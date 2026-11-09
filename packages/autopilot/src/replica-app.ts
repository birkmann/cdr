// The replica's Next.js app (plan §2.4), written from this template: the page from the design system's composites.
// Generated apps and their installs live under the site's project folder, never in the repository.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { overlaysComponent, type OnLoadOverlay } from "./replica-overlays.js";

export interface ReplicaNames {
  scope: string;
  tokens: string;
  wc: string;
  react: string;
  site: string;
}

export interface ReplicaAppOptions {
  appDir: string;
  dsDir: string;
  names: ReplicaNames;
  /** the page component from the page generator (`Home.tsx`, `Startseite.tsx`, …) */
  pageTsx: string;
  /** the path of the original page, when it is not `/` */
  pagePath?: string;
  /** dialogs the page opens on load */
  overlays?: readonly OnLoadOverlay[];
  /** the width whose breakpoint frame goes into the server's HTML (the others mount in the browser) */
  serverWidth?: number;
  title: string;
  lang: string;
  /** where one install per dependency set is kept (`node_modules`, copied into each app) */
  depsCache: string;
  env: NodeJS.ProcessEnv;
  log(line: string): void;
}

/** The dependencies of a replica, third-party only: the design-system packages are copied in beside them. */
export const REPLICA_DEPS = {
  dependencies: {
    next: "16.4.4",
    react: "19.3.1",
    "react-dom": "19.3.1",
    lit: "^3.3.1",
    "@lit/react": "^1.0.8",
  },
  devDependencies: {
    typescript: "5.9.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@types/node": "22.20.5",
  },
};

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function nextBinOf(appDir: string): string {
  return join(appDir, "node_modules/next/dist/bin/next");
}

const FRAME_OPEN = /^(\s*)<div data-bp="(\d+)"[^>]*>\s*$/;

/** The page's breakpoint frames (`<div data-bp="…">` … `</div>`) as line ranges; none when the page is not laid out that way. */
function framesOf(lines: readonly string[]): { open: number; close: number; bp: number }[] {
  const frames: { open: number; close: number; bp: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FRAME_OPEN.exec(lines[i]!);
    if (!m) continue;
    const close = lines.indexOf(`${m[1]}</div>`, i + 1);
    if (close < 0) return [];
    frames.push({ open: i, close, bp: Number(m[2]) });
    i = close;
  }
  return frames;
}

/**
 * One frame in the server's HTML: every breakpoint's frame in it would repeat the page's text and links once per
 * breakpoint for whatever reads the HTML (search engines, assistive tech before CSS, the verify suite). The browser
 * mounts the others before its first paint, and the CSS switches between them as before.
 */
export function serverFrameOnly(pageTsx: string, width: number): { source: string; split: boolean } {
  const lines = pageTsx.split("\n");
  const frames = framesOf(lines);
  const head = lines.findIndex((l) => /^export default function \w+\([^)]*\)[^{]*\{\s*$/.test(l));
  if (frames.length < 2 || head < 0 || head > frames[0]!.open) return { source: pageTsx, split: false };
  const shown = frames.filter((f) => f.bp <= width).pop() ?? frames[0]!;
  for (const f of [...frames].reverse()) {
    if (f === shown) continue;
    const pad = /^\s*/.exec(lines[f.open]!)![0];
    lines.splice(f.close + 1, 0, `${pad})}`);
    lines.splice(f.open, 0, `${pad}{allFrames && (`);
  }
  lines.splice(head + 1, 0, "  const allFrames = FrameReact.useContext(AllFrames)");
  return { source: lines.join("\n"), split: true };
}

/** The app's files (template plus the page), pure. */
export function replicaFiles(
  o: Pick<
    ReplicaAppOptions,
    "names" | "pageTsx" | "title" | "lang" | "overlays" | "pagePath" | "serverWidth"
  >,
): Record<string, string> {
  const { names } = o;
  const overlays = o.overlays?.length ? o.overlays : null;
  // the page answers where the original does (`/de`, `/de.html`), so links and the verify suite find it
  const routes =
    o.pagePath && o.pagePath !== "/"
      ? `async rewrites() { return [{ source: ${JSON.stringify(o.pagePath)}, destination: "/" }] }, `
      : "";
  // the generator names the component after the page (`Startseite`, `Home`, …), which may even be `Page`
  const component = /^export default function (\w+)/m.exec(o.pageTsx)?.[1] ?? "Home";
  const { source, split } = o.serverWidth
    ? serverFrameOnly(o.pageTsx, o.serverWidth)
    : { source: o.pageTsx, split: false };
  const body = source.replace(/^export default function/m, "function");
  const onLoad = overlays ? "\n    <OnLoadOverlays />" : "";
  // (a passive effect of the first commit would run before the other frames exist: the hook mounts with them)
  const root = split
    ? `import * as FrameReact from 'react'

const AllFrames = FrameReact.createContext(false)

${body}

function Interactions() {
  useInteractions()
  return null
}

export default function ReplicaPage() {
  const [all, setAll] = FrameReact.useState(false)
  FrameReact.useLayoutEffect(() => setAll(true), [])
  return (
    <AllFrames.Provider value={all}>
      <${component} />
      {all && <Interactions />}${onLoad}
    </AllFrames.Provider>
  )
}
`
    : `${body}

export default function ReplicaPage() {
  useInteractions()
  return ${overlays ? `<>\n    <${component} />\n    <OnLoadOverlays />\n  </>` : `<${component} />`}
}
`;
  const page = `'use client'
import { useInteractions } from '${names.site}'
${overlays ? "import { OnLoadOverlays } from './OnLoadOverlays'\n" : ""}${root}`;
  return {
    "package.json": json({
      name: "replica",
      private: true,
      version: "0.0.0",
      scripts: { build: "next build", start: "next start" },
      ...REPLICA_DEPS,
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "preserve",
        strict: true,
        allowJs: true,
        noEmit: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        isolatedModules: true,
        incremental: true,
        skipLibCheck: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./*"] },
      },
      include: ["next-env.d.ts", "app/**/*.ts", "app/**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
    "next.config.mjs": `/** @type {import('next').NextConfig} */\nexport default { ${routes}poweredByHeader: false, images: { unoptimized: true } }\n`,
    "next-env.d.ts": `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`,
    "app/layout.tsx": `import type { ReactNode } from 'react'
import '${names.tokens}/tokens.css'
import '${names.site}/styles.css'

export const metadata = { title: ${JSON.stringify(o.title)} }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang=${JSON.stringify(o.lang)}>
      <body>{children}</body>
    </html>
  )
}
`,
    "app/page.tsx": page,
    ...(overlays ? { "app/OnLoadOverlays.tsx": overlaysComponent(overlays) } : {}),
    ".gitignore": "node_modules\n.next\n",
    "RECREATION.md":
      "# Replica\n\nThe page rebuilt in Next.js from its design system. The layout, text, photos, fonts and logos belong to their owners.\n",
  };
}

/** One `npm install` per dependency set, kept in `depsCache`, copied into each app. */
export async function ensureReplicaDeps(
  o: Pick<ReplicaAppOptions, "appDir" | "depsCache" | "env" | "log">,
): Promise<void> {
  if (existsSync(join(o.appDir, "node_modules/next/package.json"))) return;
  const manifest = json({ name: "replica-deps", private: true, ...REPLICA_DEPS });
  const key = createHash("sha256").update(manifest).digest("hex").slice(0, 16);
  const cached = join(o.depsCache, key);
  if (!existsSync(join(cached, "node_modules/next/package.json"))) {
    o.log("installing the replica's dependencies (once per dependency set; needs the network)");
    const tmp = `${cached}.tmp-${randomBytes(4).toString("hex")}`;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "package.json"), manifest);
    await new Promise<void>((res, rej) => {
      const child = spawn("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: tmp,
        env: o.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr?.on("data", (d) => (err = (err + String(d)).slice(-3000)));
      child.on("error", rej);
      child.on("exit", (code) =>
        code === 0 ? res() : rej(new Error(`npm install failed: ${err.slice(-800)}`)),
      );
    });
    rmSync(cached, { recursive: true, force: true });
    mkdirSync(dirname(cached), { recursive: true });
    renameSync(tmp, cached);
  }
  mkdirSync(o.appDir, { recursive: true });
  cpSync(join(cached, "node_modules"), join(o.appDir, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
  });
}

/** The design system's packages go into the app's node_modules next to their third-party dependencies. */
export function copyDsPackages(o: Pick<ReplicaAppOptions, "appDir" | "dsDir" | "names">): void {
  const modules = join(o.appDir, "node_modules", o.names.scope);
  mkdirSync(modules, { recursive: true });
  for (const name of ["tokens", "web-components", "react", "site"]) {
    const from = join(o.dsDir, "packages", name);
    const to = join(modules, name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, filter: (src) => !src.includes("/node_modules") });
  }
}

/** Writes the app and its assets; the install is separate so the swap rounds can reuse it. */
export function writeReplicaApp(o: ReplicaAppOptions): void {
  mkdirSync(o.appDir, { recursive: true });
  for (const [file, content] of Object.entries(replicaFiles(o))) {
    const f = join(o.appDir, file);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  const pub = join(o.dsDir, "packages/site/public");
  if (existsSync(pub)) cpSync(pub, join(o.appDir, "public"), { recursive: true, force: true });
}

/** Reads the design system workspace's names. */
export function replicaNames(dsDir: string): ReplicaNames {
  const scope = (
    JSON.parse(readFileSync(join(dsDir, "package.json"), "utf8")) as { name: string }
  ).name.split("/")[0]!;
  return {
    scope,
    tokens: `${scope}/tokens`,
    wc: `${scope}/web-components`,
    react: `${scope}/react`,
    site: `${scope}/site`,
  };
}

import type { HarnessEvent, LaunchFramework } from "@harness/protocol";
import type { ToolCallView } from "./index.js";

/** A program the user can start from the chat: declared with `set_launch`, or inferred from a written manifest. */
export interface LaunchView {
  command: string;
  /** Folder relative to the project root ("" or undefined: the root). */
  cwd?: string;
  title?: string;
  framework?: LaunchFramework;
  /** Not declared by the agent: guessed from a Cargo.toml / go.mod it wrote in this turn. */
  inferred?: boolean;
}

type LaunchEvent = Extract<HarnessEvent, { type: "launch.ready" }>;

function relPath(path: string, projectPath?: string): string | undefined {
  let p = path.replace(/\\/g, "/");
  if (projectPath) {
    const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === root) return "";
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  if (p.startsWith("/") || /^[a-z]:\//i.test(p) || p.split("/").includes("..")) return undefined;
  return p.replace(/^(\.\/)+/, "");
}

const RUST: Omit<LaunchView, "cwd"> = { command: "cargo run --release", framework: "rust" };
const GO: Omit<LaunchView, "cwd"> = { command: "go run .", framework: "go" };

function joinRel(dir: string, sub: string): string {
  return [dir, sub].filter(Boolean).join("/");
}

/** What a manifest written with `content` makes launchable, if anything (Tauri apps are left to `set_launch`). */
function fromManifest(name: string, content: string): Omit<LaunchView, "cwd"> | undefined {
  if (name === "Cargo.toml" && /^\s*\[package\]/m.test(content) && !/\btauri\b/.test(content)) return RUST;
  if (name === "go.mod" && /^\s*module\s/m.test(content)) return GO;
  return undefined;
}

/** Program folders (relative to the project) a successful tool call shows: manifests written, builds run. */
function candidates(t: ToolCallView, projectPath?: string): Array<Omit<LaunchView, "inferred">> {
  const args = t.args as { path?: unknown; content?: unknown; command?: unknown } | undefined;
  if (t.name === "write_file" && typeof args?.path === "string") {
    const rel = relPath(args.path, projectPath);
    if (rel === undefined) return [];
    const parts = rel.split("/");
    const name = parts.pop()!;
    const found = fromManifest(name, typeof args.content === "string" ? args.content : "");
    if (found) return [{ ...found, cwd: parts.join("/") }];
    // A Rust binary's entry point: the crate is the folder above src/.
    if (name === "main.rs" && parts.at(-1) === "src") return [{ ...RUST, cwd: parts.slice(0, -1).join("/") }];
    return [];
  }
  if (t.name === "bash" && typeof args?.command === "string") {
    const cmd = args.command;
    // The folder the command works in: a leading `cd <dir> &&` (or `;`), else the project root.
    const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;)/.exec(cmd);
    const dir = cd ? relPath(cd[1].replace(/^["']|["']$/g, ""), projectPath) : "";
    if (dir === undefined) return [];
    const out: Array<Omit<LaunchView, "inferred">> = [];
    // `cat > Cargo.toml <<'EOF' … EOF`: a manifest written from the shell.
    for (const m of cmd.matchAll(
      /\bcat\s*>\s*(["']?)([^\s"'<>;&|]*(?:Cargo\.toml|go\.mod))\1[^\n]*<<-?\s*(["']?)(\w+)\3\n([\s\S]*?)\n\4\b/g,
    )) {
      const rel = relPath(m[2], projectPath && dir ? `${projectPath}/${dir}` : projectPath);
      if (rel === undefined) continue;
      const parts = joinRel(dir, rel).split("/");
      const found = fromManifest(parts.pop()!, m[5]);
      if (found) out.push({ ...found, cwd: parts.join("/") });
    }
    if (/(?:^|[\s;&|(])cargo\s+(?:\+\S+\s+)?(?:build|run|test)\b/.test(cmd) && !/--manifest-path/.test(cmd))
      out.push({ ...RUST, cwd: dir });
    else if (/(?:^|[\s;&|(])go\s+(?:build|run)\b/.test(cmd)) out.push({ ...GO, cwd: dir });
    return out;
  }
  return [];
}

/**
 * Launch buttons for one turn: the agent's `launch.ready` events (latest per folder and command), or –
 * for turns that built a Rust or Go program without declaring it – one inferred from the manifest it wrote
 * (with `write_file` or a shell heredoc) or the `cargo`/`go` builds it ran.
 */
export function turnLaunches(
  events: LaunchEvent[],
  tools: ToolCallView[],
  projectPath?: string,
): LaunchView[] {
  if (events.length) {
    const byKey = new Map<string, LaunchView>();
    for (const e of events) {
      const key = `${e.cwd ?? ""}\n${e.command}`;
      byKey.delete(key);
      byKey.set(key, { command: e.command, cwd: e.cwd, title: e.title, framework: e.framework });
    }
    return [...byKey.values()];
  }
  let best: (LaunchView & { depth: number }) | undefined;
  for (const t of tools) {
    if (t.status !== "ok") continue;
    for (const c of candidates(t, projectPath)) {
      const parts = c.cwd ? c.cwd.split("/") : [];
      if (parts.includes("node_modules") || parts.includes("target")) continue;
      if (!best || parts.length < best.depth)
        best = { ...c, cwd: c.cwd || undefined, inferred: true, depth: parts.length };
    }
  }
  if (!best) return [];
  const { depth: _, ...view } = best;
  return [view];
}

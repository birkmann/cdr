import { describe, expect, it } from "vitest";
import { replicaFiles, serverFrameOnly } from "../src/replica-app.js";

const names = {
  scope: "@acme-ds",
  tokens: "@acme-ds/tokens",
  wc: "@acme-ds/web-components",
  react: "@acme-ds/react",
  site: "@acme-ds/site",
};

const page = `import { Hero } from '@acme-ds/site'

export default function Startseite() {
  return (
    <>
      <div data-bp="0" className="a">
        <main className="m">
          <Hero variant="xs" />
        </main>
      </div>
      <div data-bp="768" className="b">
        <main className="m">
          <Hero variant="md" />
        </main>
      </div>
      <div data-bp="1424" className="c">
        <main className="m">
          <Hero variant="lg" />
        </main>
      </div>
      <div data-bp="1920" className="d">
        <main className="m">
          <Hero variant="xl" />
        </main>
      </div>
    </>
  )
}
`;

describe("replica frames", () => {
  it("keeps only the frame of the given width out of the browser-only group", () => {
    const { source, split } = serverFrameOnly(page, 1440);
    expect(split).toBe(true);
    expect(source.match(/\{allFrames && \(/g)).toHaveLength(3);
    expect(source).toMatch(/\n {6}<div data-bp="1424" className="c">/);
    expect(source).not.toMatch(/\{allFrames && \(\n {6}<div data-bp="1424"/);
    expect(source).toMatch(/\{allFrames && \(\n {6}<div data-bp="1920"/);
    expect(source).toContain("const allFrames = FrameReact.useContext(AllFrames)");
  });

  it("leaves a page without breakpoint frames alone", () => {
    const single = `export default function Home() {\n  return <main />\n}\n`;
    expect(serverFrameOnly(single, 1440)).toEqual({ source: single, split: false });
  });

  it("mounts the interactions with the other frames", () => {
    const tsx = replicaFiles({ names, pageTsx: page, title: "T", lang: "de", serverWidth: 1440 })["app/page.tsx"]!;
    expect(tsx).toContain("{all && <Interactions />}");
    expect(tsx).toContain("function Startseite()");
    expect(tsx).not.toMatch(/export default function Startseite/);
    expect(tsx).toContain("useLayoutEffect(() => setAll(true), [])");
  });
});

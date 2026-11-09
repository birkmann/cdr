import type { SceneElement, SceneScreen } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { dslElementToIr } from "../src/export/fromDsl.js";

const ir = (el: SceneElement) =>
  dslElementToIr({ root: { id: "r", type: "frame", children: [el] } } as unknown as SceneScreen, el.id) as unknown as {
    tag: string;
    attrs: Record<string, string>;
    interaction?: unknown;
  };

const button = (extra: Partial<SceneElement>): SceneElement =>
  ({ id: "b", type: "button", text: "M1", ...extra }) as SceneElement;

describe("a button that opens a URL", () => {
  it("is an anchor with the URL in its markup", () => {
    const out = ir(button({ interaction: { onTap: "open-url", url: "https://x.test/m1" } }));
    expect(out.tag).toBe("a");
    expect(out.attrs.href).toBe("https://x.test/m1");
    expect(out.interaction).toBeUndefined();
  });

  it("stays a button when it does something else", () => {
    expect(ir(button({ interaction: { onTap: "back" } })).tag).toBe("button");
  });

  it("does not nest a link inside a link", () => {
    const out = ir(
      button({
        interaction: { onTap: "open-url", url: "https://x.test/" },
        children: [{ id: "c", type: "button", text: "inner" } as SceneElement],
      }),
    );
    expect(out.tag).toBe("div");
    expect(out.attrs.role).toBe("button");
  });
});

describe("what a capture knows about text", () => {
  const text = (meta: Record<string, string>, textStyle?: string) =>
    ({ id: "t", type: "text", text: "Hi", meta, style: textStyle ? { textStyle } : {} }) as unknown as SceneElement;

  it("keeps the element the page wrote it in", () => {
    expect(ir(text({ textTag: "h3" }, "display")).tag).toBe("h3");
    expect(ir(text({ textTag: "div" }, "display")).tag).toBe("p");
  });

  it("zeroes the browser's margins where the reset does not reach", () => {
    expect((ir(text({ textTag: "h5" })) as unknown as { style: Record<string, string> }).style.margin).toBe("0");
    expect((ir(text({ textTag: "h2" })) as unknown as { style: Record<string, string> }).style.margin).toBeUndefined();
  });

  it("still reads a designed page's text style", () => {
    expect(ir(text({}, "headline")).tag).toBe("h2");
  });

  it("renders hidden content as the importer built it", () => {
    const out = ir({ id: "h", type: "frame", meta: { hiddenMarkup: "<h1>x</h1>" } } as unknown as SceneElement) as unknown as {
      raw?: string;
    };
    expect(out.raw).toBe("<h1>x</h1>");
  });
});

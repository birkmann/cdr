import { describe, expect, it } from "vitest";
import { buildFileIndex, chatFileOps, parentFolders, resolveFileRef, type ChatFiles } from "./file-refs";

const root = "/home/u/app";
const index = buildFileIndex([
  "README.md",
  "src/a.ts",
  "src/deep/util.js",
  "packages/one/index.ts",
  "packages/two/index.ts",
  "my file.txt",
]);
const resolve = (ref: string) => resolveFileRef(ref, index, root);

describe("references to project files", () => {
  it.each([
    ["README.md", { path: "README.md" }],
    ["src/a.ts", { path: "src/a.ts" }],
    ["./src/a.ts", { path: "src/a.ts" }],
    [`${root}/src/a.ts`, { path: "src/a.ts" }],
    ["util.js", { path: "src/deep/util.js" }],
    ["deep/util.js", { path: "src/deep/util.js" }],
    ["one/index.ts", { path: "packages/one/index.ts" }],
    ["src/a.ts:12", { path: "src/a.ts", line: 12 }],
    ["src/a.ts:12:4", { path: "src/a.ts", line: 12 }],
    ["src/a.ts:12-20", { path: "src/a.ts", line: 12 }],
    ["src/a.ts#L7", { path: "src/a.ts", line: 7 }],
    ["src/a.ts#L7-L9", { path: "src/a.ts", line: 7 }],
    ["src\\a.ts", { path: "src/a.ts" }],
    ["my%20file.txt", { path: "my file.txt" }],
  ])("reads %s", (ref, expected) => {
    expect(resolve(ref)).toEqual(expected);
  });

  it.each([
    ["an unknown file", "src/nothing.ts"],
    ["a name that fits several files", "index.ts"],
    ["ordinary text", "not a path"],
    ["a word", "pnpm"],
    ["a folder", "src"],
    ["a partial name", "ME.md"],
    ["a path outside the project", "/etc/passwd"],
    ["a sibling folder of the project", "/home/u/app-other/src/a.ts"],
    ["a path climbing out", "../app/src/a.ts"],
    ["a URL", "https://example.com/README.md"],
    ["nothing", ""],
  ])("does not link %s", (_name, ref) => {
    expect(resolve(ref)).toBeUndefined();
  });
});

describe("the chat view's file tabs", () => {
  it("opens a file once and shows it", () => {
    let f = chatFileOps.open({}, root, "a");
    f = chatFileOps.open(f, root, "b");
    f = chatFileOps.open(f, root, "a");
    expect(f[root]).toMatchObject({ tabs: ["a", "b"], active: "a" });
  });

  it("asks for a line again each time", () => {
    const first = chatFileOps.open({}, root, "a", 5);
    const again = chatFileOps.open(first, root, "a", 5);
    expect(first[root]!.reveal).toMatchObject({ path: "a", line: 5 });
    expect(again[root]!.reveal!.nonce).not.toBe(first[root]!.reveal!.nonce);
  });

  it("activates a neighbour when the active tab closes", () => {
    let f = ["a", "b", "c"].reduce<ChatFiles>((s, p) => chatFileOps.open(s, root, p), {});
    f = chatFileOps.activate(f, root, "b");
    f = chatFileOps.close(f, root, "b");
    expect(f[root]).toMatchObject({ tabs: ["a", "c"], active: "c" });
    f = chatFileOps.close(f, root, "c");
    expect(f[root]).toMatchObject({ tabs: ["a"], active: "a" });
    f = chatFileOps.close(f, root, "a");
    expect(f[root]).toMatchObject({ tabs: [], active: null });
  });

  it("keeps the active tab when another closes", () => {
    let f = ["a", "b"].reduce<ChatFiles>((s, p) => chatFileOps.open(s, root, p), {});
    f = chatFileOps.close(f, root, "a");
    expect(f[root]!.active).toBe("b");
  });

  it("keeps each project's tabs apart", () => {
    let f = chatFileOps.open({}, "/one", "a");
    f = chatFileOps.open(f, "/two", "b");
    expect(f["/one"]!.tabs).toEqual(["a"]);
    expect(f["/two"]!.tabs).toEqual(["b"]);
  });

  it("ignores a file that is not open", () => {
    const f = chatFileOps.open({}, root, "a");
    expect(chatFileOps.activate(f, root, "b")).toBe(f);
    expect(chatFileOps.close(f, root, "b")).toBe(f);
  });

  it("lists the folders above a file", () => {
    expect(parentFolders("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(parentFolders("c.ts")).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { posix, win32 } from "node:path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./components/dialogs";
import { openFile, openFolder } from "./file-actions";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./components/dialogs", () => ({ confirmDialog: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({
  dirname: async (path: string) => (/^[a-z]:/i.test(path) ? win32 : posix).dirname(path),
  basename: async (path: string) => (/^[a-z]:/i.test(path) ? win32 : posix).basename(path),
}));

function store(root: string | null = "/project", dirty = false) {
  const errors: string[] = [];
  return {
    workspace: root ? { root, name: "project" } : null,
    buffers: new Map([
      ["draft.ts", { path: "draft.ts", saved: "before", content: dirty ? "after" : "before", mtime: 0 }],
    ]),
    openWorkspace: vi.fn(async (_path: string) => {}),
    openTab: vi.fn(),
    attempt: async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        errors.push((error as Error).message);
      }
    },
    errors,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("opening files and folders", () => {
  it("leaves the workspace alone when the file dialog is cancelled", async () => {
    const st = store();
    vi.mocked(openDialog).mockResolvedValue(null);
    await openFile(st);
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.openTab).not.toHaveBeenCalled();
  });

  it.each([
    ["/project", "/project/src/app.ts", "src/app.ts"],
    ["/", "/app.ts", "app.ts"],
    ["C:\\Project", "c:\\project\\src\\app.ts", "src/app.ts"],
  ])("opens a file in %s without resetting dirty buffers", async (root, selected, path) => {
    const st = store(root, true);
    vi.mocked(openDialog).mockResolvedValue(selected);
    await openFile(st);
    expect(st.openTab).toHaveBeenCalledWith({ kind: "file", path });
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.buffers.get("draft.ts")?.content).toBe("after");
  });

  it("opens the containing folder when there is no workspace", async () => {
    const st = store(null);
    vi.mocked(openDialog).mockResolvedValue("/project/src/app.ts");
    await openFile(st);
    expect(st.openWorkspace).toHaveBeenCalledWith("/project/src");
    expect(st.openTab).toHaveBeenCalledWith({ kind: "file", path: "app.ts" });
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("does not confuse a sibling folder with a file inside the workspace", async () => {
    const st = store();
    vi.mocked(openDialog).mockResolvedValue("/project-other/app.ts");
    vi.mocked(confirmDialog).mockResolvedValue(false);
    await openFile(st);
    expect(confirmDialog).toHaveBeenCalled();
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.openTab).not.toHaveBeenCalled();
  });

  it("switches folders only after confirmation for an external file", async () => {
    const st = store();
    vi.mocked(openDialog).mockResolvedValue("/other/app.ts");
    vi.mocked(confirmDialog).mockResolvedValue(true);
    await openFile(st);
    expect(st.openWorkspace).toHaveBeenCalledWith("/other");
    expect(st.openTab).toHaveBeenCalledWith({ kind: "file", path: "app.ts" });
  });

  it.each([openFile, openFolder])("protects unsaved changes when switching folders", async (open) => {
    const st = store("/project", true);
    vi.mocked(openDialog).mockResolvedValue("/other/app.ts");
    await open(st);
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.openTab).not.toHaveBeenCalled();
    expect(st.errors).toEqual(["Save or close your modified files before switching folders."]);
  });

  it("does not open a tab if switching folders fails", async () => {
    const st = store(null);
    vi.mocked(openDialog).mockResolvedValue("/other/app.ts");
    st.openWorkspace.mockRejectedValue(new Error("Folder unavailable"));
    await openFile(st);
    expect(st.openTab).not.toHaveBeenCalled();
    expect(st.errors).toEqual(["Folder unavailable"]);
  });
});

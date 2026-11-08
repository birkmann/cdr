import { beforeEach, describe, expect, it, vi } from "vitest";
import { posix, win32 } from "node:path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./components/dialogs";
import {
  enterCodeView,
  openFile,
  openFileInCode,
  openFolder,
  openSessionFolder,
  pathInWorkspace,
} from "./file-actions";

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

describe("opening a conversation's folder", () => {
  function sessionStore(root: string | null, dirty = false) {
    return {
      ...store(root, dirty),
      setSide: vi.fn(),
      revealInExplorer: vi.fn(),
    };
  }

  it("opens the folder and keeps the conversation selected", async () => {
    const st = sessionStore(null);
    await openSessionFolder(st, "/sandboxes/snake-1");
    expect(st.openWorkspace).toHaveBeenCalledWith("/sandboxes/snake-1", { keepSession: true });
    expect(st.setSide).toHaveBeenCalledWith("files");
  });

  it("only shows the explorer when the folder is already open", async () => {
    const st = sessionStore("/sandboxes/snake-1");
    await openSessionFolder(st, "/sandboxes/snake-1");
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.setSide).toHaveBeenCalledWith("files");
  });

  it("reveals the conversation's output folder", async () => {
    const st = sessionStore(null);
    await openSessionFolder(st, "/project", ".harness/chess-game");
    expect(st.openWorkspace).toHaveBeenCalledWith("/project", { keepSession: true });
    expect(st.revealInExplorer).toHaveBeenCalledWith(".harness/chess-game");
  });

  it("protects unsaved changes", async () => {
    const st = sessionStore("/project", true);
    await openSessionFolder(st, "/sandboxes/snake-1");
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.setSide).not.toHaveBeenCalled();
    expect(st.revealInExplorer).not.toHaveBeenCalled();
    expect(st.errors).toEqual(["Save or close your modified files before switching folders."]);
  });
});

describe("entering the code view", () => {
  const viewStore = (root: string | null, dirty = false) => ({ ...store(root, dirty), setMode: vi.fn() });

  it("opens the conversation's project and keeps the conversation", async () => {
    const st = viewStore("/project");
    expect(await enterCodeView(st, "/other")).toBe(true);
    expect(st.openWorkspace).toHaveBeenCalledWith("/other", { keepSession: true });
    expect(st.setMode).toHaveBeenCalledWith("code");
  });

  it.each([
    ["the open project", "/project"],
    ["a folder inside the open project", "/project/packages/a"],
  ])("does not reopen %s", async (_name, project) => {
    const st = viewStore("/project");
    expect(await enterCodeView(st, project)).toBe(true);
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.setMode).toHaveBeenCalledWith("code");
  });

  it("opens a project when no folder is open", async () => {
    const st = viewStore(null);
    expect(await enterCodeView(st, "/other")).toBe(true);
    expect(st.openWorkspace).toHaveBeenCalledWith("/other", { keepSession: true });
  });

  it("just changes the view without a project", async () => {
    const st = viewStore("/project");
    expect(await enterCodeView(st, null)).toBe(true);
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.setMode).toHaveBeenCalledWith("code");
  });

  it("shows the code view with the modified files when the project cannot be opened", async () => {
    const st = viewStore("/project", true);
    expect(await enterCodeView(st, "/other")).toBe(false);
    expect(st.openWorkspace).not.toHaveBeenCalled();
    expect(st.setMode).toHaveBeenCalledWith("code");
    expect(st.errors).toEqual(["Save or close your modified files before switching folders."]);
  });
});

describe("opening a project's file in the code view", () => {
  const viewStore = (root: string | null, dirty = false) => ({ ...store(root, dirty), setMode: vi.fn() });

  it("names a file of a project inside the workspace from the workspace root", () => {
    expect(pathInWorkspace("/mono/pkg", "/mono", "src/a.ts")).toBe("pkg/src/a.ts");
    expect(pathInWorkspace("/mono", "/mono", "src/a.ts")).toBe("src/a.ts");
    expect(pathInWorkspace("/mono-other", "/mono", "a.ts")).toBe("a.ts");
    expect(pathInWorkspace("/mono", undefined, "a.ts")).toBe("a.ts");
  });

  it("opens the project first, then the file at its line", async () => {
    const st = viewStore("/project");
    await openFileInCode(st, "/other", "a.ts", 3);
    expect(st.openWorkspace).toHaveBeenCalledWith("/other", { keepSession: true });
    expect(st.openTab).toHaveBeenCalledWith({ kind: "file", path: "a.ts", line: 3 });
  });

  it("does not open a file of another project when the project cannot be opened", async () => {
    const st = viewStore("/project", true);
    await openFileInCode(st, "/other", "a.ts");
    expect(st.openTab).not.toHaveBeenCalled();
    expect(st.setMode).toHaveBeenCalledWith("code");
  });
});

/** All files of a project, for telling references to them apart from any other text. */
export interface FileIndex {
  files: ReadonlySet<string>;
  byName: ReadonlyMap<string, readonly string[]>;
}

export const EMPTY_INDEX: FileIndex = { files: new Set(), byName: new Map() };

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function buildFileIndex(files: string[]): FileIndex {
  const byName = new Map<string, string[]>();
  for (const f of files) {
    const name = nameOf(f);
    const list = byName.get(name);
    if (list) list.push(f);
    else byName.set(name, [f]);
  }
  return { files: new Set(files), byName };
}

const POSITION = /(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/;

/**
 * The project file a reference in a message names, as a path relative to the project. A reference is
 * a project path (`src/a.ts`), an absolute path inside the project, or the end of a path when only one
 * file fits (`a.ts`); it can end in a position (`:12`, `:12:3`, `#L12`). Anything else is not a link.
 */
export function resolveFileRef(
  reference: string,
  index: FileIndex,
  root: string,
): { path: string; line?: number } | undefined {
  let ref = reference.trim().replace(/\\/g, "/");
  if (!ref || /\s/.test(ref) || ref.includes("://")) return undefined;
  try {
    ref = decodeURI(ref);
  } catch {
    /* not encoded */
  }
  const position = POSITION.exec(ref);
  if (position) ref = ref.slice(0, position.index);
  const line = position ? Number(position[1] ?? position[2]) : undefined;
  if (ref.startsWith("/")) {
    if (!ref.startsWith(root + "/")) return undefined;
    ref = ref.slice(root.length + 1);
  }
  ref = ref.replace(/^(\.\/)+/, "");
  if (!ref || ref.split("/").includes("..")) return undefined;
  const found = index.files.has(ref)
    ? [ref]
    : (index.byName.get(nameOf(ref)) ?? []).filter((f) => f.endsWith(`/${ref}`));
  if (found.length !== 1) return undefined;
  return { path: found[0]!, ...(line ? { line } : {}) };
}

/** Every folder above a file, to keep the file in sight in a tree. */
export function parentFolders(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export interface FileTabs {
  tabs: string[];
  active: string | null;
  /** A line to show in the active file; the nonce repeats a request. */
  reveal?: { path: string; line: number; nonce: number };
}
/** The chat view's open files, by project folder. */
export type ChatFiles = Record<string, FileTabs>;

const EMPTY: FileTabs = { tabs: [], active: null };
let revealNonce = 0;

export const chatFileOps = {
  open(files: ChatFiles, root: string, path: string, line?: number): ChatFiles {
    const cur = files[root] ?? EMPTY;
    return {
      ...files,
      [root]: {
        tabs: cur.tabs.includes(path) ? cur.tabs : [...cur.tabs, path],
        active: path,
        reveal: line ? { path, line, nonce: ++revealNonce } : undefined,
      },
    };
  },
  close(files: ChatFiles, root: string, path: string): ChatFiles {
    const cur = files[root] ?? EMPTY;
    const at = cur.tabs.indexOf(path);
    if (at < 0) return files;
    const tabs = cur.tabs.filter((t) => t !== path);
    const active = cur.active === path ? (tabs[at] ?? tabs[at - 1] ?? null) : cur.active;
    return { ...files, [root]: { tabs, active } };
  },
  activate(files: ChatFiles, root: string, path: string): ChatFiles {
    const cur = files[root] ?? EMPTY;
    return cur.tabs.includes(path) ? { ...files, [root]: { tabs: cur.tabs, active: path } } : files;
  },
};

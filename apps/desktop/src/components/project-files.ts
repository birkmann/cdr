import { useEffect, useState } from "react";
import { app, fs } from "../ipc";
import { EMPTY_INDEX, buildFileIndex, type FileIndex } from "../file-refs";

const allowed = new Map<string, Promise<void>>();

/** Make a project readable by the file commands, once per project. */
export function allowProject(root: string): Promise<void> {
  let done = allowed.get(root);
  if (!done) {
    done = app.allowFolder(root);
    done.catch(() => allowed.delete(root));
    allowed.set(root, done);
  }
  return done;
}

/** The project's files, read again shortly after `version` changes. */
export function useProjectFiles(root: string | undefined, version: unknown = 0): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!root) return setFiles([]);
    let live = true;
    const timer = setTimeout(() => {
      void allowProject(root)
        .then(() => fs.listFiles(root))
        .then((list) => live && setFiles(list))
        .catch(() => live && setFiles([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [root, version]);
  return files;
}

/** The project's files, indexed for recognising references to them in messages. */
export function useFileIndex(root: string | undefined, version: unknown): FileIndex {
  const files = useProjectFiles(root, version);
  const [index, setIndex] = useState(EMPTY_INDEX);
  useEffect(() => setIndex(files.length ? buildFileIndex(files) : EMPTY_INDEX), [files]);
  return index;
}

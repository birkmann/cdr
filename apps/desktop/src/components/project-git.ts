import { useEffect, useState } from "react";
import { git, type GitSummary } from "../ipc";

const NOT_A_REPO: GitSummary = { isRepo: false, status: null, added: 0, deleted: 0 };

/**
 * Git summaries of a few projects, by folder. They are asked for one at a time, shortly after
 * `version` changes and then every `everyMs`; earlier answers stay until newer ones arrive.
 */
export function useProjectSummaries(
  paths: string[],
  version: unknown = 0,
  everyMs = 15_000,
): Record<string, GitSummary | undefined> {
  const [summaries, setSummaries] = useState<Record<string, GitSummary>>({});
  const key = paths.join("\0");
  useEffect(() => {
    if (!key) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const list = key.split("\0");
    const load = async () => {
      for (const path of list) {
        const summary = await git.summary(path).catch(() => NOT_A_REPO);
        if (!live) return;
        setSummaries((s) => ({ ...s, [path]: summary }));
      }
      if (live) timer = setTimeout(() => void load(), everyMs);
    };
    timer = setTimeout(() => void load(), 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, version, everyMs]);
  return summaries;
}

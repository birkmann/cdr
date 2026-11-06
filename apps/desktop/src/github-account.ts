import { useSyncExternalStore } from "react";
import { github, type GithubUser } from "./ipc";

/** undefined while the first check runs, null when signed out. Shared by the status bar, Settings and dialogs. */
let user: GithubUser | null | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function setGithubUser(u: GithubUser | null) {
  user = u;
  for (const l of listeners) l();
}

/** Ask the app for the stored sign-in again (after signing in or out elsewhere, or on start). */
export function refreshGithubUser(): Promise<void> {
  loading = github
    .status()
    .then((u) => setGithubUser(u))
    .catch(() => setGithubUser(null));
  return loading;
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (user === undefined && !loading) void refreshGithubUser();
  return () => listeners.delete(l);
}

export function useGithubUser(): GithubUser | null | undefined {
  return useSyncExternalStore(subscribe, () => user);
}

/** Open Settings → GitHub. */
export function openGithubSettings() {
  window.dispatchEvent(new CustomEvent("cdr:open-settings", { detail: "github" }));
}

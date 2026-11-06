/** "github.com/owner/repo" for GitHub remotes (HTTPS or SSH), otherwise the URL without credentials. */
export function remoteLabel(url: string): string {
  const u = url.trim().replace(/\.git$/, "");
  const gh = u.match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[/:](.+)$/i);
  if (gh) return `github.com/${gh[1]}`;
  return u.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

/** The web page for a GitHub remote, if it is one. */
export function remoteWebUrl(url: string): string | undefined {
  const l = remoteLabel(url);
  return l.startsWith("github.com/") ? `https://${l}` : undefined;
}

/**
 * A GitHub repository name for a folder: sandbox folders lose their random "-2f7a3b" suffix,
 * and characters GitHub would replace become dashes.
 */
export function suggestRepoName(folder: string, sandbox = false): string {
  const base = sandbox ? folder.replace(/-[0-9a-f]{6}$/, "") : folder;
  const name = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return name.slice(0, 100) || "project";
}

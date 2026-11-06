/** Whether a file is Markdown and can be shown rendered. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

/**
 * Resolve a link or image reference found in the Markdown file `from` to a workspace-relative path.
 * Leading "/" means the workspace root (as on GitHub). Returns null when it escapes the workspace.
 */
export function resolveRelative(from: string, ref: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    decoded = ref;
  }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) return null;
  return parts.join("/") + (decoded.endsWith("/") ? "/" : "");
}

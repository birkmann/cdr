/** Split merged text with conflict markers into ours/theirs resolutions. */
export function resolveMarkers(text: string, side: "ours" | "theirs" | "both"): string {
  const out: string[] = [];
  let mode: "none" | "ours" | "base" | "theirs" = "none";
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ")) mode = "ours";
    else if (line.startsWith("||||||| ") && mode === "ours") mode = "base";
    else if (line === "=======" && (mode === "ours" || mode === "base")) mode = "theirs";
    else if (line.startsWith(">>>>>>> ") && mode === "theirs") mode = "none";
    else if (mode === "none") out.push(line);
    else if (mode === "ours" && (side === "ours" || side === "both")) out.push(line);
    else if (mode === "theirs" && (side === "theirs" || side === "both")) out.push(line);
  }
  return out.join("\n");
}

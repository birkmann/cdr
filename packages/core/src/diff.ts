/**
 * Small unified-diff generator. Uses common prefix/suffix trimming and a bounded LCS on the
 * changed middle region, which is plenty for edit-sized changes and stays O(n) for big files.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = midA.length * midB.length <= 4_000_000 ? lcsOps(midA, midB) : naiveOps(midA, midB);

  // Build full op list with surrounding equal lines, then cut into hunks.
  type Op = { t: " " | "-" | "+"; line: string };
  const all: Op[] = [
    ...a.slice(0, start).map((line) => ({ t: " " as const, line })),
    ...ops,
    ...a.slice(endA).map((line) => ({ t: " " as const, line })),
  ];
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  // positions of changes
  while (i < all.length) {
    // skip equal lines far away from changes
    let next = i;
    while (next < all.length && all[next].t === " ") next++;
    if (next >= all.length) break;
    const hunkStart = Math.max(i, next - context);
    for (let k = i; k < hunkStart; k++) {
      aLine++;
      bLine++;
    }
    // extend hunk until we see > 2*context equal lines
    let end = next;
    let equalRun = 0;
    let k = next;
    while (k < all.length) {
      if (all[k].t === " ") {
        equalRun++;
        if (equalRun > context * 2) break;
      } else {
        equalRun = 0;
        end = k;
      }
      k++;
    }
    const hunkEnd = Math.min(all.length, end + 1 + context);
    const hunk = all.slice(hunkStart, hunkEnd);
    const aCount = hunk.filter((o) => o.t !== "+").length;
    const bCount = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    aLine += aCount;
    bLine += bCount;
    i = hunkEnd;
  }
  return out.join("\n");
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsOps(a: string[], b: string[]): { t: " " | "-" | "+"; line: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { t: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "-", line: a[i++] });
    else ops.push({ t: "+", line: b[j++] });
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

function naiveOps(a: string[], b: string[]) {
  return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
}

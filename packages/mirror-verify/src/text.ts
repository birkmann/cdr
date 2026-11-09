import type { RichBlock, RichInline, RichTextDoc } from "@harness/mirror-core";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  shy: "",
  copy: "©",
};

/** Local fallback for @cmp/transforms normalizeText. */
export function localNormalizeText(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e] ?? m;
    })
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿­]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inlineText(nodes: RichInline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.value;
    else if (n.type === "break") out += "\n";
    else if (n.type === "link") out += inlineText(n.children);
  }
  return out;
}

function blockText(b: RichBlock): string {
  switch (b.type) {
    case "paragraph":
    case "heading":
      return inlineText(b.children);
    case "list":
      return b.children.map((li) => li.children.map(blockText).join("\n")).join("\n");
    case "blockquote":
      return b.children.map(blockText).join("\n");
    case "embeddedAsset":
      return b.caption ?? "";
    case "rawHtml":
      return b.html.replace(/<[^>]+>/g, " ");
    default:
      return "";
  }
}

/** Local fallback for @cmp/transforms richTextToPlainText. */
export function localPlainText(doc: RichTextDoc): string {
  return (doc?.children ?? []).map(blockText).filter(Boolean).join("\n\n");
}

export interface TextFns {
  normalizeText(s: string): string;
  plainText(doc: RichTextDoc): string;
}

let cached: TextFns | undefined;
/** Prefer @cmp/transforms (shared normalisation), fall back to local implementations. */
export async function loadTextFns(): Promise<TextFns> {
  if (cached) return cached;
  let normalizeText = localNormalizeText;
  let plainText = localPlainText;
  try {
    const mod: Record<string, unknown> = await import("@harness/mirror-transforms");
    if (typeof mod.normalizeText === "function") normalizeText = mod.normalizeText as (s: string) => string;
    if (typeof mod.richTextToPlainText === "function") plainText = mod.richTextToPlainText as (d: RichTextDoc) => string;
  } catch {
    /* fallback */
  }
  cached = { normalizeText, plainText };
  return cached;
}

export function words(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

export interface TextDiff {
  old: string;
  new: string;
  at: number; // word index in old
}

const MAX_DP = 4_000_000;

/**
 * Word-level similarity 2*LCS/(|a|+|b|) with up to `maxDiffs` differing windows.
 * Falls back to bag-of-words overlap when the DP table would be too big.
 */
export function textSimilarity(a: string, b: string, maxDiffs = 10): { similarity: number; diffs: TextDiff[]; method: "lcs" | "bag" } {
  const A = words(a);
  const B = words(b);
  if (!A.length && !B.length) return { similarity: 1, diffs: [], method: "lcs" };
  if (!A.length || !B.length) return { similarity: 0, diffs: [{ old: A.slice(0, 30).join(" "), new: B.slice(0, 30).join(" "), at: 0 }], method: "lcs" };
  const n = A.length;
  const m = B.length;
  if ((n + 1) * (m + 1) > MAX_DP) {
    const count = new Map<string, number>();
    for (const w of A) count.set(w, (count.get(w) ?? 0) + 1);
    let common = 0;
    for (const w of B) {
      const c = count.get(w) ?? 0;
      if (c > 0) {
        common++;
        count.set(w, c - 1);
      }
    }
    return { similarity: (2 * common) / (n + m), diffs: [], method: "bag" };
  }
  const W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const lcs = dp[0];
  // walk the alignment, grouping consecutive non-matching ops into diff windows
  const diffs: TextDiff[] = [];
  let i = 0;
  let j = 0;
  let cur: { o: string[]; n: string[]; at: number } | undefined;
  const flush = () => {
    if (cur && diffs.length < maxDiffs) diffs.push({ old: cur.o.join(" "), new: cur.n.join(" "), at: cur.at });
    cur = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i * W + j + 1] >= dp[(i + 1) * W + j])) {
      cur ??= { o: [], n: [], at: i };
      cur.n.push(B[j++]);
    } else {
      cur ??= { o: [], n: [], at: i };
      cur.o.push(A[i++]);
    }
  }
  flush();
  return { similarity: (2 * lcs) / (n + m), diffs, method: "lcs" };
}

/** Comparison key: lowercase, whitespace removed (robust against block joiners and CSS). */
export function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

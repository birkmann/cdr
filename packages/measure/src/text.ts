// Text comparison with drift detection. Ported from the earlier project's scripts/lib/app-run/measure.mjs (textCompare).
// A live text the capture did not see either, or an output text the live page no longer shows but the capture did,
// is the live page's content changing between capture and measuring (`drift`), not an output fault; `real` counts
// the output's own misses only.

export interface TextReport {
  live: number;
  out: number;
  recall: number;
  precision: number;
  missing: string[];
  extra: string[];
  drift?: { liveOnly: string[]; captureOnly: string[]; count: number };
  real?: { missing: string[]; extra: string[] };
  realRecall?: number;
}

export const squash = (t: string) =>
  t
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u00a0\u200b\u00ad]+/g, "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"');

export function textCompare(live: string[], out: string[], captured: string[] | null = null): TextReport {
  // visible copy only: glyph-only strings ("◄►", "›") are icons, not text
  const uniq = (a: string[]) => [
    ...new Set(a.filter((t) => squash(t).length > 1 && /[\p{L}\p{N}]/u.test(t))),
  ];
  const L = uniq(live),
    O = uniq(out);
  const hayO = squash(O.join(" ")),
    hayL = squash(L.join(" "));
  const missing = L.filter((t) => !hayO.includes(squash(t)));
  const extra = O.filter((t) => !hayL.includes(squash(t)));
  const res: TextReport = {
    live: L.length,
    out: O.length,
    recall: L.length ? 1 - missing.length / L.length : 1,
    precision: O.length ? 1 - extra.length / O.length : 1,
    missing: missing.slice(0, 40),
    extra: extra.slice(0, 40),
  };
  if (captured) {
    const hayC = squash(uniq(captured).join(" "));
    const liveOnly = missing.filter((t) => !hayC.includes(squash(t)));
    const captureOnly = extra.filter((t) => hayC.includes(squash(t)));
    const realMissing = missing.filter((t) => !liveOnly.includes(t));
    const realExtra = extra.filter((t) => !captureOnly.includes(t));
    res.drift = {
      liveOnly: liveOnly.slice(0, 40),
      captureOnly: captureOnly.slice(0, 40),
      count: liveOnly.length + captureOnly.length,
    };
    res.real = { missing: realMissing.slice(0, 40), extra: realExtra.slice(0, 40) };
    res.realRecall = L.length ? 1 - realMissing.length / L.length : 1;
  }
  return res;
}

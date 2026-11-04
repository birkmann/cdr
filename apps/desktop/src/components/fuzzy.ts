/** Subsequence fuzzy score; higher is better, null when not matching. Basename matches rank higher. */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const base = t.slice(t.lastIndexOf("/") + 1);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 6 : 1;
    if (i === 0 || "/._- ".includes(t[i - 1])) score += 4;
    prev = i;
    ti = i + 1;
  }
  if (base.includes(q)) score += 25 + (base.startsWith(q) ? 15 : 0);
  return score - target.length * 0.02;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string, limit = 80): T[] {
  if (!query.trim()) return items.slice(0, limit);
  const scored: { t: T; s: number }[] = [];
  for (const t of items) {
    const s = fuzzyScore(query.trim(), key(t));
    if (s !== null) scored.push({ t, s });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}

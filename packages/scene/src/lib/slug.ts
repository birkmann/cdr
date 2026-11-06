// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Layer names → CSS class names / file names / component names. Deterministic and deduplicated.

/** "Hero image #2" → "hero-image-2". Never empty (falls back to `fallback`), never starts with a digit. */
export function slugify(input: string, fallback = "item"): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (!s) return fallback;
  return /^[0-9]/.test(s) ? `${fallback}-${s}` : s;
}

/** "plant list" → "PlantList"; guaranteed to be a valid JS identifier starting with an upper-case letter. */
export function pascalCase(input: string, fallback = "Screen"): string {
  const parts = slugify(input, "").split("-").filter(Boolean);
  const s = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  if (!s) return fallback;
  return /^[0-9]/.test(s) ? `${fallback}${s}` : s;
}

/** Hands out unique names: the first "title" stays "title", later ones become "title-2", "title-3"… */
export function createNamer(separator = "-") {
  const used = new Map<string, number>();
  const taken = new Set<string>();
  return function unique(base: string): string {
    let n = used.get(base) ?? 0;
    let name = n === 0 ? base : `${base}${separator}${n + 1}`;
    while (taken.has(name)) {
      n += 1;
      name = `${base}${separator}${n + 1}`;
    }
    used.set(base, n + 1);
    taken.add(name);
    return name;
  };
}
export type Namer = ReturnType<typeof createNamer>;

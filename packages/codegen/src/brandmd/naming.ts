// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Brand guide (DESIGN.md) — semantic token keys (design-md--generator/PLAN.md §6.2). Which measured colour becomes
// `canvas`, `ink`, `primary`, `surface-dark` …, which text style `display-xl` … `nav-link`, which radius `none` … `full`,
// which spacing value `xxs` … `section`, and the component keys (`top-nav`, `button-primary-active`, a set's own name
// slugified). Deterministic: the same measurements give the same keys, keys are unique, and nothing is assigned that
// was not measured (semantic colours only when found, a body colour only when it differs from the ink). The colour
// maths the rules need (ΔE2000, contrast, hue names) lives here and is shared with facts.ts. Pure.
import { lab } from "./lab.js";
import { isDark, luminance, parseColor } from "@harness/scene";
import { createNamer, slugify } from "@harness/scene";
import type { ColorFact, ColorGroup, ScaleStep } from "@harness/protocol";

/* ------------------------------------------------------------------ colour maths */

const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000" };
const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .padStart(2, "0");

/** Any CSS colour → `#rrggbb` (lower case), painted over `under` when translucent; null for transparent / unparsable. */
export function toHex(c: string | undefined | null, under = "#ffffff"): string | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (s === "transparent" || s === "none") return null;
  const p = parseColor(NAMED[s] ?? s);
  if (!p || p.a < 0.05) return null;
  if (p.a >= 0.999) return "#" + p.rgb.map(hex2).join("");
  const u = parseColor(under)?.rgb ?? [255, 255, 255];
  return "#" + p.rgb.map((v, i) => hex2(v * p.a + u[i]! * (1 - p.a))).join("");
}

/** Alpha of a CSS colour (1 when unparsable but present). */
export const alphaOf = (c: string | undefined | null) =>
  !c
    ? 0
    : /^(transparent|none)$/i.test(c.trim())
      ? 0
      : (parseColor(NAMED[c.trim().toLowerCase()] ?? c)?.a ?? 1);

const rgbOf = (hex: string): [number, number, number] => parseColor(hex)?.rgb ?? [0, 0, 0];

/** CIEDE2000 colour difference of two colours (< 2 reads as the same colour). */
export function deltaE(a: string, b: string): number {
  const [L1, a1, b1] = lab(...rgbOf(a)),
    [L2, a2, b2] = lab(...rgbOf(b));
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1),
    C2 = Math.hypot(a2, b2),
    Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G),
    ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1),
    Cp2 = Math.hypot(ap2, b2);
  const hp = (x: number, y: number) => {
    if (x === 0 && y === 0) return 0;
    const h = Math.atan2(y, x) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1 = hp(ap1, b1),
    h2 = hp(ap2, b2);
  const dL = L2 - L1,
    dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2,
    Cpm = (Cp1 + Cp2) / 2;
  let hm = h1 + h2;
  if (Cp1 * Cp2 !== 0)
    hm =
      Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : (h1 + h2) / 2;
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2),
    Sc = 1 + 0.045 * Cpm,
    Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** Same colour for the brand guide (ΔE2000 < 2). */
export const sameColor = (a: string, b: string) => a === b || deltaE(a, b) < 2;

/**
 * Two measured colours are one token: ΔE2000 < 2 — except two different background greys. ΔE2000 forgives lightness
 * near white (#ffffff / #fafafa / #f7f7f7 are all < 2 apart), yet a site sets its surface ladder in exactly those steps.
 */
export const oneToken = (a: { hex: string; background: boolean }, b: { hex: string; background: boolean }) =>
  a.hex === b.hex || (sameColor(a.hex, b.hex) && !(a.background && b.background));

export const contrast = (a: string, b: string) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

export function hslOf(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** A colour that reads as a hue (not grey, not near-white / near-black) — brandKit's rule. */
export const isChromatic = (hex: string) => {
  const { s, l } = hslOf(hex);
  return s >= 0.28 && l > 0.12 && l < 0.88 && luminance(hex) < 0.8;
};
export { isDark };

const HUES: Array<[number, string]> = [
  [15, "red"],
  [40, "orange"],
  [50, "amber"],
  [65, "yellow"],
  [90, "lime"],
  [150, "green"],
  [175, "teal"],
  [195, "cyan"],
  [250, "blue"],
  [265, "indigo"],
  [290, "violet"],
  [315, "purple"],
  [345, "pink"],
  [360, "red"],
];

/** Plain hue name of a colour ("red", "navy", "teal"); "grey" for neutrals. */
export function hueName(hex: string): string {
  const { h, s, l } = hslOf(hex);
  if (s < 0.15) return "grey";
  const name = HUES.find(([max]) => h < max)?.[1] ?? "red";
  if (name === "blue" && l < 0.3) return "navy";
  if (name === "orange" && l < 0.32) return "brown";
  return name;
}

/* ------------------------------------------------------------------ colours */

/** One measured colour (a ΔE2000 < 2 cluster) and where it is used (facts.ts). */
export interface ColorUse {
  hex: string;
  /**
   * role → weight. Areas are shares of the desktop page area, text roles characters, the rest element counts:
   * page-bg, band-bg, card-bg, fill, control-fill, heading, body-text, nav-text, footer-text, button-text, on-dark-text,
   * on-primary-text, border, link, icon, state:hover|active|focus|disabled, gradient, declared, semantic:success|warning|error
   */
  roles: Record<string, number>;
  area: number;
  count: number;
  chars: number;
  pages: string[];
  kinds: string[];
  cssVar?: string;
  /** position of the stop in the page's main gradient */
  stop?: number;
}

/** Colours facts.ts settled from the captured CTA controls (primary by count across pages) and the foundations. */
export interface ColorHints {
  primary?: string;
  primaryActive?: string;
  primaryHover?: string;
  primaryDisabled?: string;
  onPrimary?: string;
  /** the foundations' page background / copy colour, for documents without measurements */
  background?: string;
  text?: string;
}

const TEXT_ROLES = ["heading", "body-text", "nav-text", "footer-text", "button-text"];
const SURFACE_ROLES = ["page-bg", "band-bg", "card-bg", "fill"];
const w = (u: ColorUse, roles: string[]) => roles.reduce((a, r) => a + (u.roles[r] ?? 0), 0);
const title = (key: string) =>
  key
    .split("-")
    .map((p) =>
      p.length <= 2 && /^[a-z]+$/.test(p) && p !== "on"
        ? p.toUpperCase()
        : p.charAt(0).toUpperCase() + p.slice(1),
    )
    .join(" ");

export function groupOfColor(key: string): ColorGroup {
  if (/^(canvas|surface)/.test(key)) return "surface";
  if (/^hairline/.test(key)) return "hairline";
  if (/^(ink|body|muted|on-)/.test(key)) return "text";
  if (/^(success|warning|error)/.test(key)) return "semantic";
  if (/^gradient/.test(key)) return "gradient";
  if (/^(primary|link)/.test(key)) return "brand";
  return "accent";
}

/**
 * Semantic colour keys from roles: `canvas` = largest light band background (the page background first); `surface-*` =
 * the other band / card backgrounds by use; `surface-dark` = largest dark band; `ink` = most common heading colour on
 * light ground; `body` = most common running-text colour; `muted` / `muted-soft` = lower-contrast neutral copy;
 * `hairline` / `-strong` = thin borders; `primary` (+ states, `on-primary`) from the CTA hints; `on-dark` = copy on
 * dark bands; `link`; `success` / `warning` / `error` only when the site has them; gradient stops; the remaining
 * chromatic colours as accents named by hue.
 */
export function nameColors(uses: ColorUse[], hints: ColorHints = {}): ColorFact[] {
  const list = [...uses].sort(
    (a, b) =>
      b.count + b.area * 1000 + b.chars / 20 - (a.count + a.area * 1000 + a.chars / 20) ||
      (a.hex < b.hex ? -1 : 1),
  );
  const find = (hex: string | undefined) =>
    hex ? (list.find((u) => u.hex === hex) ?? list.find((u) => sameColor(u.hex, hex))) : undefined;
  const out: ColorFact[] = [];
  const has = (key: string) => out.some((c) => c.key === key);
  const add = (key: string, u: ColorUse | undefined, hex?: string) => {
    const h = u?.hex ?? hex;
    if (!h || has(key)) return undefined;
    const roles = u
      ? Object.entries(u.roles)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([r]) => r)
      : [];
    out.push({
      key,
      label: title(key),
      hex: h,
      group: groupOfColor(key),
      roles,
      area: u ? Math.round(u.area * 10000) / 10000 : 0,
      count: u?.count ?? 0,
      pages: u?.pages ?? [],
      kinds: u?.kinds ?? [],
      source: u ? "site" : "derived",
      ...(u?.cssVar ? { cssVar: u.cssVar } : {}),
    });
    return h;
  };
  /** best use by `score` among those passing `ok` and not already holding one of `taken`'s colours */
  const best = (ok: (u: ColorUse) => boolean, score: (u: ColorUse) => number, taken: string[] = []) =>
    list
      .filter((u) => ok(u) && score(u) > 0 && !taken.some((t) => find(t) === u || t === u.hex))
      .sort((a, b) => score(b) - score(a) || (a.hex < b.hex ? -1 : 1))[0];

  // canvas: the page / largest band background, light first
  const bgScore = (u: ColorUse) => (u.roles["page-bg"] ?? 0) + (u.roles["band-bg"] ?? 0);
  const canvasU = best((u) => !isDark(u.hex), bgScore) ?? best(() => true, bgScore);
  const canvas = add("canvas", canvasU, hints.background) ?? "#ffffff";
  const dark = isDark(canvas);

  // primary and its captured states
  const primary = hints.primary ? add("primary", find(hints.primary), hints.primary) : undefined;
  if (primary) {
    if (hints.primaryActive && !sameColor(hints.primaryActive, primary))
      add("primary-active", find(hints.primaryActive), hints.primaryActive);
    if (
      hints.primaryHover &&
      !sameColor(hints.primaryHover, primary) &&
      !(hints.primaryActive && sameColor(hints.primaryHover, hints.primaryActive))
    )
      add("primary-hover", find(hints.primaryHover), hints.primaryHover);
    if (hints.primaryDisabled && !sameColor(hints.primaryDisabled, primary))
      add("primary-disabled", find(hints.primaryDisabled), hints.primaryDisabled);
  }

  // surfaces: dark bands, then the light ladder (card plate, soft band, strong grey)
  const surfaces = [canvas, ...(primary ? [primary] : [])];
  const surfaceDark = add(
    "surface-dark",
    best(
      (u) => isDark(u.hex) && (!isChromatic(u.hex) || hslOf(u.hex).l < 0.25),
      (u) => (bgScore(u) > 0 ? 1000 + bgScore(u) : 0.5 * w(u, ["card-bg"]) + 0.25 * w(u, ["fill"])),
      surfaces,
    ),
  );
  if (surfaceDark) {
    surfaces.push(surfaceDark);
    surfaces.push(
      add(
        "surface-dark-elevated",
        best(
          (u) => isDark(u.hex) && !isChromatic(u.hex) && luminance(u.hex) > luminance(surfaceDark),
          (u) => w(u, SURFACE_ROLES),
          surfaces,
        ),
      ) ?? surfaceDark,
    );
  }
  const lightSurface = (u: ColorUse) => isDark(u.hex) === dark && !isChromatic(u.hex);
  const card = add(
    "surface-card",
    best(lightSurface, (u) => w(u, ["card-bg"]), surfaces),
  );
  if (card) surfaces.push(card);
  const soft = add(
    "surface-soft",
    best(lightSurface, (u) => bgScore(u) + 0.25 * w(u, ["fill"]), surfaces),
  );
  if (soft) surfaces.push(soft);
  const strong = best(
    (u) => lightSurface(u) && (u.area >= 0.002 || w(u, ["card-bg", "band-bg"]) >= 2),
    (u) => (dark ? luminance(u.hex) : 1 - luminance(u.hex)) * Math.min(1, w(u, SURFACE_ROLES) * 100),
    surfaces,
  );
  if (strong) surfaces.push(add("surface-strong", strong)!);

  // copy on the light ground
  const onGround = (u: ColorUse) => contrast(u.hex, canvas) >= 3;
  const inkU = best(onGround, (u) => w(u, ["heading"])) ?? best(onGround, (u) => w(u, TEXT_ROLES));
  const ink = add("ink", inkU, inkU ? undefined : hints.text);
  const texts = ink ? [ink] : [];
  // a body colour of its own only when it sets a real share of the copy next to ink (else the copy is ink: BVG's #252525,
  // not the dark blue of a few teaser lines)
  const inkU2 = find(ink);
  const inkBody = inkU2 ? w(inkU2, ["body-text"]) : 0;
  const body = add(
    "body",
    best(
      (u) => onGround(u) && w(u, ["body-text"]) >= 0.25 * inkBody,
      (u) => w(u, ["body-text"]),
      texts,
    ),
  );
  if (body) texts.push(body);
  const ref = body ?? ink;
  if (body && ref) {
    const total = find(body)?.roles["body-text"] ?? 0;
    const bs = add(
      "body-strong",
      best(
        (u) =>
          onGround(u) &&
          contrast(u.hex, canvas) > contrast(body, canvas) &&
          w(u, ["body-text"]) >= total * 0.05,
        (u) => w(u, ["body-text"]),
        texts,
      ),
    );
    if (bs) texts.push(bs);
  }
  const mutedOk = (max: number) => (u: ColorUse) =>
    !isChromatic(u.hex) && contrast(u.hex, canvas) >= 1.8 && contrast(u.hex, canvas) < max - 0.2;
  const muted = ref
    ? add(
        "muted",
        best(mutedOk(contrast(ref, canvas)), (u) => w(u, TEXT_ROLES), texts),
      )
    : undefined;
  if (muted) {
    texts.push(muted);
    add(
      "muted-soft",
      best(mutedOk(contrast(muted, canvas)), (u) => w(u, TEXT_ROLES), texts),
    );
  }

  // hairlines: the two most used thin borders that stay quiet on the canvas
  const lines = list
    .filter(
      (u) =>
        w(u, ["border"]) > 0 &&
        !isChromatic(u.hex) &&
        contrast(u.hex, canvas) >= 1.05 &&
        contrast(u.hex, canvas) < 3 &&
        !sameColor(u.hex, canvas),
    )
    .sort((a, b) => w(b, ["border"]) - w(a, ["border"]) || (a.hex < b.hex ? -1 : 1))
    .slice(0, 2)
    .sort((a, b) => contrast(a.hex, canvas) - contrast(b.hex, canvas));
  if (lines[0]) add("hairline", lines[0]);
  if (lines[1]) add("hairline-strong", lines[1]);

  // copy on fills
  if (primary)
    add(
      "on-primary",
      find(hints.onPrimary) ??
        best(
          (u) => contrast(u.hex, primary) >= 3,
          (u) => w(u, ["on-primary-text"]),
        ),
      hints.onPrimary,
    );
  const darkGround = surfaceDark ?? "#000000";
  const onDark = add(
    "on-dark",
    best(
      (u) => contrast(u.hex, darkGround) >= 3,
      (u) => w(u, ["on-dark-text"]),
    ),
  );
  if (onDark)
    add(
      "on-dark-soft",
      best(
        (u) =>
          !isChromatic(u.hex) &&
          contrast(u.hex, darkGround) >= 3 &&
          contrast(u.hex, darkGround) < contrast(onDark, darkGround) - 0.5,
        (u) => w(u, ["on-dark-text"]),
        [onDark],
      ),
    );

  // link, semantic colours (only when found), the main gradient's stops
  const named = () => out.map((c) => c.hex);
  add(
    "link",
    best(
      (u) => isChromatic(u.hex),
      (u) => w(u, ["link"]),
      primary ? [primary] : [],
    ),
  );
  for (const k of ["success", "warning", "error"] as const)
    add(
      k,
      best(
        () => true,
        (u) => w(u, [`semantic:${k}`]),
      ),
    );
  const stops = list
    .filter((u) => u.stop !== undefined && w(u, ["gradient"]) > 0)
    .sort((a, b) => a.stop! - b.stop!);
  if (stops.length >= 2)
    stops
      .slice(0, 4)
      .forEach((u, i, a) =>
        add(
          i === 0
            ? "gradient-start"
            : i === a.length - 1
              ? "gradient-end"
              : `gradient-mid${i > 1 ? `-${i}` : ""}`,
          u,
        ),
      );

  // accents: other hues the site really uses (not only in states or declarations), named by hue
  const namer = createNamer("-");
  for (const k of out.map((c) => c.key)) namer(k);
  const significant = (u: ColorUse) => u.count >= 2 || u.area >= 0.002 || u.chars >= 20;
  // the browser's default link colours (#0000ee, #551a8b, #ee0000) mark unstyled links, not a brand hue
  const uaDefault = (h: string) => ["#0000ee", "#551a8b", "#ee0000"].includes(h.toLowerCase());
  const accents = list.filter(
    (u) =>
      isChromatic(u.hex) &&
      !uaDefault(u.hex) &&
      significant(u) &&
      Object.keys(u.roles).some((r) => !/^(state:|declared|gradient)/.test(r)) &&
      !named().some((h) => sameColor(h, u.hex)),
  );
  for (const u of accents.slice(0, 4)) add(namer(hueName(u.hex)), u);
  return out;
}

/* ------------------------------------------------------------------ typography */

/** Text runs clustered by (family, size, weight, line height, tracking, transform), weighted by characters (facts.ts). */
export interface TypeCluster {
  family: string;
  /** the CSS font-family list as authored */
  stack: string;
  size: number;
  weight: number;
  /** unitless */
  lineHeight: number;
  /** px */
  letterSpacing: number;
  textTransform?: "uppercase" | "lowercase" | "capitalize";
  chars: number;
  /** use → characters: heading, h1…h6, hero, nav, footer, button, link, card, body */
  uses: Record<string, number>;
  mono: boolean;
  /** a few strings set in this style (to find the same copy at the narrowest width) */
  strings: string[];
  source?: "site" | "derived";
}

/** DESIGN.md typography keys in the order the examples list them. */
export const TYPE_ORDER = [
  "display-xl",
  "display-lg",
  "display-md",
  "display-sm",
  "title-lg",
  "title-md",
  "title-sm",
  "lead",
  "body-md",
  "body-sm",
  "caption",
  "label-uppercase",
  "button",
  "nav-link",
  "code",
] as const;

const isRegular = (c: TypeCluster) => c.weight <= 500;
const useOf = (c: TypeCluster, k: string) => c.uses[k] ?? 0;

/**
 * Type roles by size rank and element kind: `code` (monospace), `button` (the captured CTA label, else copy inside
 * buttons), `nav-link` (header nav), `body-md` (the regular size most running copy is set in), headings (well above the
 * body or bold above it; sizes within 9 % are one step) → `display-*` from 24 px up, `title-*` below, then `lead`,
 * `body-sm`, `caption`, `label-uppercase`. Each cluster takes one key.
 */
export function nameTypes(
  clusters: TypeCluster[],
  o: { button?: TypeCluster } = {},
): Array<{ key: string; cluster: TypeCluster }> {
  const pool = [...clusters]
    .filter((c) => c.chars > 0 && c.size > 0)
    .sort((a, b) => b.chars - a.chars || b.size - a.size || a.weight - b.weight);
  const total = pool.reduce((a, c) => a + c.chars, 0) || 1;
  const taken = new Set<TypeCluster>();
  const out = new Map<string, TypeCluster>();
  const take = (key: string, c: TypeCluster | undefined) => {
    if (c && !out.has(key)) {
      out.set(key, c);
      taken.add(c);
    }
    return c;
  };
  const top = (ok: (c: TypeCluster) => boolean, score: (c: TypeCluster) => number = (c) => c.chars) =>
    pool
      .filter((c) => !taken.has(c) && ok(c) && score(c) > 0)
      .sort((a, b) => score(b) - score(a) || b.size - a.size)[0];

  take(
    "code",
    top((c) => c.mono),
  );
  const btn = o.button
    ? (pool.find(
        (c) =>
          !c.mono &&
          Math.abs(c.size - o.button!.size) <= 0.5 &&
          c.weight === o.button!.weight &&
          c.family === o.button!.family,
      ) ?? o.button)
    : top(
        (c) => !c.mono,
        (c) => useOf(c, "button"),
      );
  take("button", btn);
  take(
    "nav-link",
    top(
      (c) => !c.mono && c.size <= 20,
      (c) => useOf(c, "nav"),
    ),
  );
  const body =
    take(
      "body-md",
      top(
        (c) => !c.mono && isRegular(c) && c.size >= 13 && c.size <= 20 && c.textTransform !== "uppercase",
        (c) => useOf(c, "body") || c.chars / 10,
      ),
    ) ??
    take(
      "body-md",
      top((c) => !c.mono && isRegular(c)),
    );
  const bodySize = body?.size ?? 16;

  // headings → steps (sizes within 9 % are one step; the most used cluster speaks for it)
  const heads = pool
    .filter(
      (c) =>
        !taken.has(c) &&
        !c.mono &&
        (c.size >= Math.max(20, bodySize * 1.25) ||
          (c.weight >= 600 &&
            c.size >= bodySize &&
            c.textTransform !== "uppercase" &&
            (useOf(c, "heading") > 0 || c.size > bodySize))),
    )
    .sort((a, b) => b.size - a.size);
  const steps: TypeCluster[][] = [];
  for (const c of heads) {
    const last = steps[steps.length - 1];
    if (last && last[0]!.size / c.size < 1.09) last.push(c);
    else steps.push([c]);
  }
  const repOf = (s: TypeCluster[]) => [...s].sort((a, b) => b.chars - a.chars)[0]!;
  const pick = (ss: TypeCluster[][], n: number) =>
    [...ss]
      .sort((a, b) => repOf(b).chars - repOf(a).chars)
      .slice(0, n)
      .sort((a, b) => repOf(b).size - repOf(a).size);
  const display = pick(
    steps.filter((s) => repOf(s).size >= 24),
    4,
  );
  const titles = pick(
    steps.filter((s) => repOf(s).size < 24),
    3,
  );
  display.forEach((s, i) => take(TYPE_ORDER[i]!, repOf(s)));
  titles.forEach((s, i) => take(TYPE_ORDER[4 + i]!, repOf(s)));
  for (const s of [...display, ...titles]) for (const c of s) taken.add(c);

  take(
    "lead",
    top(
      (c) =>
        !c.mono &&
        isRegular(c) &&
        c.size > bodySize &&
        c.size < Math.min(24, bodySize * 1.6) &&
        c.chars >= total * 0.02,
    ),
  );
  const small = take(
    "body-sm",
    top(
      (c) => !c.mono && isRegular(c) && c.size < bodySize && c.size >= 12 && c.textTransform !== "uppercase",
    ),
  );
  take(
    "caption",
    top(
      (c) => !c.mono && c.size < (small?.size ?? bodySize) && c.size >= 10 && c.textTransform !== "uppercase",
    ),
  );
  take(
    "label-uppercase",
    top((c) => !c.mono && c.textTransform === "uppercase" && c.size <= bodySize + 2),
  );
  return TYPE_ORDER.filter((k) => out.has(k)).map((key) => ({ key, cluster: out.get(key)! }));
}

/* ------------------------------------------------------------------ radii and spacing */

export const PILL = 9999;

/** A measured radius: px value, or a pill (radius ≥ half the height) / circle (round square box). */
export interface RadiusUse {
  value: number;
  count: number;
  kinds: string[];
  shape?: "pill" | "circle";
}

const RADIUS_BINS: Array<[string, number]> = [
  ["xs", 3],
  ["sm", 6],
  ["md", 10],
  ["lg", 16],
  ["xl", 32],
  ["xxl", 99],
];

/** Radius histogram → `none xs sm md lg xl (xxl) pill full`: one value per bin (the most used), rare values dropped. */
export function nameRadii(uses: RadiusUse[]): ScaleStep[] {
  const merged: RadiusUse[] = [];
  for (const u of [...uses].sort((a, b) => b.count - a.count || a.value - b.value)) {
    const shape = u.shape ?? (u.value >= 100 ? "pill" : undefined);
    const v = shape ? PILL : Math.round(u.value);
    const hit = merged.find((m) => m.shape === shape && Math.abs(m.value - v) <= 1);
    if (hit) {
      hit.count += u.count;
      hit.kinds = [...new Set([...hit.kinds, ...u.kinds])];
    } else merged.push({ value: v, count: u.count, kinds: [...u.kinds], ...(shape ? { shape } : {}) });
  }
  const out: ScaleStep[] = [];
  const zero = merged.find((m) => !m.shape && m.value === 0);
  if (zero) out.push({ key: "none", value: 0, count: zero.count, kinds: zero.kinds.sort() });
  let lo = 0;
  for (const [key, hi] of RADIUS_BINS) {
    const m = merged
      .filter((x) => !x.shape && x.value > lo && x.value <= hi && x.count >= 2)
      .sort((a, b) => b.count - a.count || a.value - b.value)[0];
    if (m) out.push({ key, value: m.value, count: m.count, kinds: m.kinds.sort() });
    lo = hi;
  }
  for (const shape of ["pill", "circle"] as const) {
    const ms = merged.filter((x) => x.shape === shape);
    if (ms.length)
      out.push({
        key: shape === "pill" ? "pill" : "full",
        value: PILL,
        count: ms.reduce((a, x) => a + x.count, 0),
        kinds: [...new Set(ms.flatMap((x) => x.kinds))].sort(),
      });
  }
  if (!out.length) out.push({ key: "none", value: 0, count: 0, kinds: [] });
  return out;
}

const SPACE_LADDER: Array<[string, number]> = [
  ["xxs", 4],
  ["xs", 8],
  ["sm", 12],
  ["md", 16],
  ["lg", 24],
  ["xl", 32],
  ["xxl", 48],
];

/**
 * Spacing ladder `xxs … xxl` + `section`: each step takes the most used measured value within ±15 % of its standard
 * value (seen ≥ 3 times, on the base unit's half grid); unmeasured steps keep the standard value with count 0.
 */
export function nameSpacing(values: number[], unit: number, section: number): ScaleStep[] {
  const counts = new Map<number, number>();
  for (const v of values) if (v > 0) counts.set(Math.round(v), (counts.get(Math.round(v)) ?? 0) + 1);
  const out: ScaleStep[] = [];
  for (const [key, std] of SPACE_LADDER) {
    const hit = [...counts]
      .filter(([v, n]) => v >= std * 0.85 && v <= std * 1.15 && v % Math.max(2, unit / 2) === 0 && n >= 3)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const prev = out[out.length - 1]?.value ?? 0;
    const value = Math.max(hit ? hit[0] : std, prev + Math.max(2, unit / 2));
    out.push({ key, value, count: hit && hit[0] === value ? hit[1] : 0, kinds: [] });
  }
  out.push({
    key: "section",
    value: Math.round(section),
    count: counts.get(Math.round(section)) ?? 0,
    kinds: [],
  });
  return out;
}

/* ------------------------------------------------------------------ components */

/** Default DESIGN.md key of a component kind (generic set names map here). */
export const KIND_KEYS: Record<string, string> = {
  header: "top-nav",
  footer: "footer",
  navigation: "nav-bar",
  menu: "nav-menu",
  breadcrumb: "breadcrumb",
  pagination: "pagination",
  tabs: "category-tab",
  link: "text-link",
  hero: "hero-band",
  section: "content-band",
  card: "card",
  teaser: "teaser-card",
  "list-item": "list-item",
  list: "list",
  accordion: "accordion",
  carousel: "carousel",
  table: "spec-table",
  quote: "quote",
  stat: "spec-cell",
  button: "button",
  "icon-button": "icon-button",
  input: "text-input",
  textarea: "text-area",
  select: "select",
  checkbox: "checkbox",
  radio: "radio",
  toggle: "toggle",
  search: "search-input",
  form: "form",
  badge: "badge",
  tag: "filter-chip",
  alert: "alert",
  toast: "toast",
  modal: "modal",
  tooltip: "tooltip",
  progress: "progress",
  image: "image",
  video: "video",
  lightbox: "lightbox",
  avatar: "avatar",
  icon: "icon",
  logo: "logo",
  text: "text-block",
  divider: "divider",
  other: "component",
};

/** `## Components` headings in order, with the kinds each holds. */
export const COMPONENT_GROUPS: Array<[string, string[]]> = [
  ["Top Navigation", ["header", "navigation", "menu", "breadcrumb"]],
  ["Buttons", ["button", "icon-button", "link"]],
  [
    "Cards & Containers",
    [
      "hero",
      "section",
      "card",
      "teaser",
      "list-item",
      "list",
      "accordion",
      "carousel",
      "table",
      "quote",
      "stat",
      "modal",
      "image",
      "video",
      "lightbox",
      "avatar",
    ],
  ],
  ["Inputs & Forms", ["input", "textarea", "select", "checkbox", "radio", "toggle", "search", "form"]],
  ["Tabs / Tags", ["tabs", "tag", "badge", "pagination"]],
  ["Feedback", ["alert", "toast", "tooltip", "progress"]],
  ["Brand Signature", ["logo", "icon", "divider", "text", "other"]],
  ["CTA / Footer", ["footer"]],
];

export const groupOfKind = (kind: string) =>
  COMPONENT_GROUPS.find(([, ks]) => ks.includes(kind))?.[0] ?? "Brand Signature";

/** Kinds whose key never comes from the set's name (the examples' fixed names). */
const FIXED = new Set([
  "header",
  "footer",
  "button",
  "icon-button",
  "input",
  "search",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "toggle",
]);
const GENERIC = new Set([
  "component",
  "default",
  "main",
  "base",
  "primary",
  "standard",
  "generic",
  "item",
  "block",
  "module",
  "element",
  "variant",
  "style",
  "group",
  "set",
  "site",
  "global",
  "page",
  "new",
]);

/** "Model card" → model-card; "Card" / "Card / Default" → the kind's key; buttons by their fill role. */
export function componentBase(
  name: string,
  kind: string,
  o: { button?: "primary" | "secondary" | "dark" | "text"; onDark?: boolean } = {},
): string {
  if (kind === "button")
    return `button-${o.button === "text" ? "text-link" : (o.button ?? "secondary")}${o.onDark && o.button !== "primary" ? "-on-dark" : ""}`;
  const fallback = KIND_KEYS[kind] ?? "component";
  if (FIXED.has(kind)) return fallback;
  const slug = slugify(name.replace(/\//g, " "), "");
  const kindWords = new Set([kind, ...slugify(kind, "").split("-"), ...fallback.split("-")]);
  const own = slug.split("-").filter((p) => p && !kindWords.has(p) && !GENERIC.has(p) && !/^\d+$/.test(p));
  return own.length
    ? slug
        .split("-")
        .filter((p) => !GENERIC.has(p) && !/^\d+$/.test(p))
        .join("-")
    : fallback;
}

const STATE_WORDS: Array<[RegExp, string]> = [
  [/^(pressed|active|down|press)$/, "active"],
  [/^(hover|hovered|over)$/, "hover"],
  [/^(focus|focused|focus-visible)$/, "focus"],
  [/^(disabled|inactive|off-limits)$/, "disabled"],
  [/^(selected|checked|current|on|open|expanded)$/, "selected"],
];
const SIZE_WORDS: Array<[RegExp, string]> = [
  [/^(xs|x-?small|tiny)$/, "xs"],
  [/^(sm|s|small)$/, "sm"],
  [/^(lg|l|large|big)$/, "lg"],
  [/^(xl|x-?large)$/, "xl"],
];
const DEFAULT_WORDS =
  /^(default|none|normal|regular|md|m|medium|base|rest|idle|enabled|off|closed|false|collapsed)$/;

/**
 * Key suffix of one variant value: states (`pressed` → active, `checked` → selected — `active` on tabs / tags / links),
 * sizes (`small` → sm), defaults → null, anything else slugified.
 */
export function variantSuffix(value: string, kind: string): string | null {
  const v = value.trim().toLowerCase();
  if (DEFAULT_WORDS.test(v)) return null;
  for (const [re, s] of STATE_WORDS)
    if (re.test(v))
      return s === "selected" &&
        ["tabs", "tag", "badge", "link", "navigation", "menu", "pagination"].includes(kind)
        ? "active"
        : s;
  for (const [re, s] of SIZE_WORDS) if (re.test(v)) return s;
  return slugify(v, "") || null;
}

/** Unique, stable keys: the first `card` stays `card`, the next one becomes `card-2`. */
export const keyNamer = () => createNamer("-");

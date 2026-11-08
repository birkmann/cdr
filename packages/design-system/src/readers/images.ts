import { leaseChrome } from "@harness/capture";
import type { ChatMessage, ImagePart } from "@harness/protocol";
import type { BrandSpec, SpecSource } from "../spec.js";
import { deltaE, hexToOklch, normHex } from "../tokens/color.js";

export interface PaletteColor {
  hex: string;
  /** share of the image's pixels (0–1) */
  share: number;
}

/** Runs in the page: draws each image to a 160 px canvas and clusters its pixels (k-means in Lab, k = 8). */
const CLUSTER = String.raw`(async (sources) => {
  const lab = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const R = f(r), G = f(g), B = f(b);
    const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    return [116 * t(y) - 16, 500 * (t(x) - t(y)), 200 * (t(y) - t(z))];
  };
  const out = [];
  for (const src of sources) {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) px.push([d[i], d[i + 1], d[i + 2]]);
    const L = px.map(lab);
    const k = Math.min(8, px.length);
    // deterministic seeds: spread over the pixels sorted by lightness
    const order = [...L.keys()].sort((a, b) => L[a][0] - L[b][0]);
    let cent = Array.from({ length: k }, (_, i) => [...L[order[Math.floor(((i + 0.5) / k) * order.length)]]]);
    const assign = new Array(L.length).fill(0);
    for (let iter = 0; iter < 12; iter++) {
      for (let i = 0; i < L.length; i++) {
        let best = 0, bd = Infinity;
        for (let j = 0; j < k; j++) { const dd = (L[i][0] - cent[j][0]) ** 2 + (L[i][1] - cent[j][1]) ** 2 + (L[i][2] - cent[j][2]) ** 2; if (dd < bd) { bd = dd; best = j; } }
        assign[i] = best;
      }
      const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
      for (let i = 0; i < L.length; i++) { const s = sum[assign[i]]; s[0] += L[i][0]; s[1] += L[i][1]; s[2] += L[i][2]; s[3]++; }
      cent = sum.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[j]));
    }
    // each cluster's colour: the mean of its real pixels (sRGB), so the hex is one the image contains
    const rgb = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) { const s = rgb[assign[i]]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++; }
    for (const s of rgb) if (s[3]) out.push({ r: s[0] / s[3], g: s[1] / s[3], b: s[2] / s[3], n: s[3] / px.length / sources.length });
  }
  return out;
})`;

/** The dominant colours of the images, merged across images (ΔE < 4) and sorted by share. */
export async function imagePalette(
  images: ImagePart[],
  o: { chrome: string; signal?: AbortSignal },
): Promise<PaletteColor[]> {
  const lease = await leaseChrome(o.chrome, { signal: o.signal });
  try {
    const { cdp } = lease;
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      browserContextId: lease.contextId,
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sources = images.map((i) => `data:${i.mimeType};base64,${i.data}`);
    const res = await cdp.send(
      "Runtime.evaluate",
      { expression: `${CLUSTER}(${JSON.stringify(sources)})`, awaitPromise: true, returnByValue: true },
      sessionId,
      60_000,
    );
    if (res.exceptionDetails)
      throw new Error(
        `Could not read the images: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
      );
    const raw = (res.result.value ?? []) as { r: number; g: number; b: number; n: number }[];
    const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
    const merged: PaletteColor[] = [];
    for (const c of raw.sort((a, b) => b.n - a.n)) {
      const h = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
      const near = merged.find((m) => deltaE(m.hex, h) < 4);
      if (near) near.share += c.n;
      else merged.push({ hex: h, share: c.n });
    }
    return merged
      .sort((a, b) => b.share - a.share)
      .map((c) => ({ ...c, share: Math.round(c.share * 1000) / 1000 }));
  } finally {
    await lease.close();
  }
}

/** Snap a colour to the nearest measured one when it is close (ΔE ≤ 6), so roles keep measured values. */
export function snap(hex: string, palette: PaletteColor[]): string {
  let best: string | undefined;
  let bd = Infinity;
  for (const p of palette) {
    const d = deltaE(hex, p.hex);
    if (d < bd) {
      bd = d;
      best = p.hex;
    }
  }
  return best && bd <= 6 ? best : hex;
}

/** A spec from the palette alone (no vision model): the most colourful frequent colour is primary. */
export function specFromPalette(palette: PaletteColor[], name: string): Partial<BrandSpec> {
  const sorted = [...palette].sort((a, b) => b.share - a.share);
  const bg = sorted[0]?.hex ?? "#ffffff";
  const dark = hexToOklch(bg).l < 0.5;
  const chromatic = sorted
    .filter((c) => hexToOklch(c.hex).c > 0.06 && c.share >= 0.005)
    .sort((a, b) => hexToOklch(b.hex).c * Math.sqrt(b.share) - hexToOklch(a.hex).c * Math.sqrt(a.share));
  const primary = chromatic[0]?.hex ?? (dark ? "#78a9ff" : "#0f62fe");
  const text = [...sorted].sort(
    (a, b) =>
      Math.abs(hexToOklch(b.hex).l - hexToOklch(bg).l) - Math.abs(hexToOklch(a.hex).l - hexToOklch(bg).l),
  )[0]?.hex;
  const sources: Record<string, SpecSource> = {
    "colors.primary": chromatic[0] ? "image" : "default",
    "colors.background": "image",
    theme: "image",
  };
  return {
    name,
    theme: dark ? "dark" : "light",
    colors: {
      primary,
      ...(chromatic[1] && deltaE(chromatic[1].hex, primary) > 15 ? { secondary: chromatic[1].hex } : {}),
      background: bg,
      ...(text ? { text } : {}),
    },
    sources,
    notes: ["Read from the images' colours only (no vision model): fonts, radii and density are defaults."],
  };
}

export const IMAGE_SYSTEM = `You are a senior design-systems designer. You get screenshots or mockups of a product or brand, and the dominant colours measured from their pixels. Read the brand's visual language so that a design system (tokens and components in the spirit of IBM Carbon) can be generated from it.

Decide from what you see:
- colours by role: the primary brand / action colour (buttons, links, highlights), an optional secondary and accent, status colours if visible, and the page background, surface and text colours. Prefer hex values from the measured list; give other values only for colours that are clearly visible but missing from it.
- theme: light or dark (the main background).
- fonts: the closest widely available family for the body text and, if different, for headlines (e.g. "Inter", "IBM Plex Sans", "Roboto", "Playfair Display"), and a monospace font if code is shown.
- radius: corner radius of controls (buttons, inputs) and of containers (cards), in px. Fully rounded pill buttons are 999.
- controlHeight: height of a normal button or input in px (32–56).
- density: compact, normal or spacious.
- buttons.secondary: "outline" when secondary buttons are outlined, "tonal" when they are a light fill; buttons.uppercase: true when button labels are all caps.
- elevation: none (flat), soft (subtle shadows) or strong.
- name: the brand or product name if it is visible, else a short fitting name.

Reply with ONLY a JSON object in a \`\`\`json fenced block:
{"name": "...", "theme": "light", "colors": {"primary": "#...", "secondary": "#...", "accent": "#...", "success": "#...", "warning": "#...", "danger": "#...", "background": "#...", "surface": "#...", "text": "#..."}, "fonts": {"sans": "...", "display": "...", "mono": "..."}, "radius": {"control": 4, "container": 8}, "controlHeight": 40, "density": "normal", "buttons": {"secondary": "outline", "uppercase": false}, "elevation": "soft", "notes": ["one short observation about the look", "..."]}
Leave out colours you cannot see. If you cannot see any image, reply exactly NO_IMAGES.`;

/** Parse the vision model's reply into a partial spec (colours snapped to the measured palette). */
export function parseVisionSpec(text: string, palette: PaletteColor[]): Partial<BrandSpec> | undefined {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0];
  if (!body) return undefined;
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object") return undefined;
  const colors: Record<string, string> = {};
  const sources: Record<string, SpecSource> = {};
  for (const [k, v] of Object.entries((j.colors ?? {}) as Record<string, unknown>)) {
    const h = typeof v === "string" ? normHex(v) : undefined;
    if (!h) continue;
    colors[k] = palette.length ? snap(h, palette) : h;
    sources[`colors.${k}`] = "vision";
  }
  if (!colors.primary) return undefined;
  for (const k of [
    "theme",
    "fonts.sans",
    "radius.control",
    "radius.container",
    "controlHeight",
    "density",
    "buttons.secondary",
    "elevation",
  ])
    sources[k] = "vision";
  return {
    ...(typeof j.name === "string" && j.name.trim() ? { name: j.name.trim() } : {}),
    theme: j.theme === "dark" ? "dark" : "light",
    colors: colors as BrandSpec["colors"],
    ...(j.fonts && typeof j.fonts === "object" ? { fonts: j.fonts } : {}),
    ...(j.radius && typeof j.radius === "object" ? { radius: j.radius } : {}),
    ...(typeof j.controlHeight === "number" ? { controlHeight: j.controlHeight } : {}),
    ...(["compact", "normal", "spacious"].includes(j.density) ? { density: j.density } : {}),
    ...(j.buttons && typeof j.buttons === "object" ? { buttons: j.buttons } : {}),
    ...(["none", "soft", "strong"].includes(j.elevation) ? { elevation: j.elevation } : {}),
    sources,
    notes: Array.isArray(j.notes) ? j.notes.filter((x: unknown) => typeof x === "string").slice(0, 6) : [],
  };
}

/** The messages for the vision reading. */
export function visionMessages(images: ImagePart[], palette: PaletteColor[]): ChatMessage[] {
  const list = palette.length
    ? palette
        .slice(0, 16)
        .map((c) => `${c.hex} (${Math.round(c.share * 100)}%)`)
        .join(", ")
    : "(not measured)";
  return [
    { role: "system", content: IMAGE_SYSTEM },
    {
      role: "user",
      content: `Measured dominant colours (share of pixels): ${list}\n\nRead the brand from the attached image(s).`,
      images,
    },
  ];
}

export interface ImageReading {
  spec: Partial<BrandSpec>;
  palette: PaletteColor[];
  /** how the roles were assigned */
  method: "vision" | "palette";
  note?: string;
}

/** Read a brand from images: measured palette (Chrome) + roles from a vision model, or the palette alone. */
export async function readImages(
  images: ImagePart[],
  o: {
    name?: string;
    chrome?: string;
    signal?: AbortSignal;
    complete?: (messages: ChatMessage[]) => Promise<string>;
  },
): Promise<ImageReading> {
  let palette: PaletteColor[] = [];
  let note: string | undefined;
  if (o.chrome) {
    try {
      palette = await imagePalette(images, { chrome: o.chrome, signal: o.signal });
    } catch (e) {
      note = `Measuring the colours failed (${(e as Error).message}).`;
    }
  } else note = "No headless browser: the colours were not measured from the pixels.";
  const name = o.name?.trim() || "";
  if (o.complete) {
    try {
      const text = await o.complete(visionMessages(images, palette));
      if (!/NO_IMAGES/.test(text)) {
        const spec = parseVisionSpec(text, palette);
        if (spec) {
          if (name) spec.name = name;
          spec.notes = [
            `Read from ${images.length} image(s) by a vision model${palette.length ? ", colours snapped to the measured pixels" : ""}.`,
            ...(spec.notes ?? []),
          ];
          return { spec, palette, method: "vision", ...(note ? { note } : {}) };
        }
        note = [note, "The vision model's reply had no usable brand reading."].filter(Boolean).join(" ");
      } else note = [note, "The model cannot view images."].filter(Boolean).join(" ");
    } catch (e) {
      note = [note, `The vision reading failed (${(e as Error).message}).`].filter(Boolean).join(" ");
    }
  }
  if (!palette.length)
    throw new Error(
      `${note ?? ""} Nothing could be read from the images: configure a vision model (designSystem.model) or install Chrome.`.trim(),
    );
  return {
    spec: specFromPalette(palette, name || "Design System"),
    palette,
    method: "palette",
    ...(note ? { note } : {}),
  };
}

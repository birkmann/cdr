// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Test input for brandmd (facts / naming / write): a hand-made, minimal fictional brand "Northwind" — a design system
// with five component sets and three captured screens (home at 1280 and 390, a second page at 1280), each with the
// BrandCapture the importer stores. Not a result of the app; numbers are chosen so the tests can state expectations:
// blue CTA (#1c69d4, 5 controls over 2 pages) vs. a larger red promo band (#e22718), pressed #0653b6, disabled
// #d6d6d6, weights 300 / 400 / 700 (500 and 600 absent), 8px spacing, 80px band padding, @media 768 / 1024 / 1440.
import type { SceneComponentDef, SceneDesignSystem, SceneElement, SceneScreen } from "@harness/protocol";
import type { BrandCapture, CapturedControl } from "@harness/protocol";

const FAMILY = "'Northwind Sans', Helvetica, Arial, sans-serif";
let n = 0;
const id = (p: string) => `${p}-${++n}`;

function text(
  t: string,
  size: number,
  weight: 300 | 400 | 700,
  color: string,
  o: { lh?: number; ls?: number; upper?: boolean; tag?: string; width?: number } = {},
): SceneElement {
  const el: SceneElement = {
    id: id("t"),
    type: "text",
    text: t,
    style: {
      fontFamily: FAMILY,
      fontSize: size,
      fontWeight: weight,
      lineHeight: o.lh ?? 1.4,
      color,
      ...(o.ls ? { letterSpacing: o.ls / size } : {}),
      ...(o.upper ? { textTransform: "uppercase" } : {}),
    },
    layout: { width: o.width ?? "fill" },
  };
  return o.tag
    ? { id: id("f"), type: "frame", meta: { tag: o.tag }, layout: { width: "fill" }, children: [el] }
    : el;
}
function frame(
  o: {
    w?: number | "fill";
    h?: number;
    bg?: string;
    pad?: number | [number, number] | [number, number, number, number];
    radius?: number;
    border?: string;
    tag?: string;
    dir?: "row" | "column";
    gap?: number;
  },
  children: SceneElement[] = [],
): SceneElement {
  return {
    id: id("f"),
    type: "frame",
    ...(o.tag ? { meta: { tag: o.tag } } : {}),
    layout: {
      width: o.w ?? "fill",
      ...(o.h ? { height: o.h } : {}),
      ...(o.pad !== undefined ? { padding: o.pad } : {}),
      direction: o.dir ?? "column",
      gap: o.gap ?? 16,
    },
    style: {
      ...(o.bg ? { background: o.bg } : {}),
      ...(o.radius !== undefined ? { radius: o.radius } : {}),
      ...(o.border ? { border: { width: 1, color: o.border } } : {}),
    },
    children,
  };
}
const inst = (componentId: string, el: SceneElement): SceneElement => ({
  ...el,
  id: id("i"),
  instance: { componentId },
});

/* ------------------------------------------------------------------ component mains */

const button = (bg: string, label: string, color = "#ffffff", border?: string) =>
  frame({ w: 160, h: 48, bg, pad: [14, 32, 14, 32], radius: 0, border, tag: "button" }, [
    text(label, 14, 700, color, { lh: 1, ls: 0.5, width: 96 }),
  ]);
const header = (wide: boolean) =>
  frame(
    { h: 64, bg: "#ffffff", pad: [0, 24], dir: "row", tag: "header", gap: 32 },
    wide
      ? ["Models", "Electric", "Offers", "Dealers"].map((t) => text(t, 14, 400, "#262626", { width: 80 }))
      : [{ id: id("ic"), type: "icon", icon: "menu", layout: { width: 24, height: 24 } }],
  );
const card = (title: string, price: string) =>
  frame({ w: 357, h: 300, bg: "#fafafa", pad: 24, radius: 0, border: "#e6e6e6" }, [
    {
      id: id("img"),
      type: "image",
      image: { src: "https://northwind.example/img/car.jpg", alt: title },
      layout: { width: 309, height: 160 },
    },
    text(title, 18, 700, "#262626", { lh: 1.4 }),
    text(price, 14, 300, "#3c3c3c", { lh: 1.55 }),
  ]);
const footer = () =>
  frame(
    { h: 240, bg: "#f7f7f7", pad: [64, 80], dir: "row", tag: "footer", gap: 48 },
    ["Imprint", "Privacy", "Contact"].map((t) => text(t, 14, 300, "#6b6b6b", { width: 120 })),
  );

const sets: SceneComponentDef[] = [
  {
    id: "set-header",
    name: "Header",
    kind: "header",
    origin: "extracted",
    variantAxes: { breakpoint: ["sm", "lg"] },
    variants: { "breakpoint=sm": header(false), "breakpoint=lg": header(true) },
    defaultVariant: "breakpoint=lg",
  },
  {
    id: "set-button",
    name: "Button",
    kind: "button",
    origin: "extracted",
    variantAxes: { style: ["primary", "secondary"], state: ["default", "pressed"] },
    variants: {
      "style=primary,state=default": button("#1c69d4", "Learn more"),
      "style=primary,state=pressed": button("#0653b6", "Learn more"),
      "style=secondary,state=default": button("#ffffff", "Configure", "#262626", "#cccccc"),
    },
    defaultVariant: "style=primary,state=default",
  },
  {
    id: "set-card",
    name: "Model card",
    kind: "card",
    origin: "extracted",
    variants: { default: card("Northwind iX", "From 49,900 EUR") },
    defaultVariant: "default",
  },
  {
    id: "set-footer",
    name: "Footer",
    kind: "footer",
    origin: "extracted",
    variants: { default: footer() },
    defaultVariant: "default",
  },
  {
    id: "set-input",
    name: "Text input",
    kind: "input",
    origin: "generated",
    variants: {
      default: frame({ w: 320, h: 48, bg: "#ffffff", pad: [14, 16], radius: 0, border: "#cccccc" }, [
        text("Postcode", 16, 300, "#6b6b6b", { lh: 1.55 }),
      ]),
    },
    defaultVariant: "default",
  },
];

export const fixtureDs: SceneDesignSystem = {
  version: 1,
  name: "Northwind",
  componentSets: sets,
  tokens: {
    theme: "light",
    primary: "#1c69d4",
    background: "#ffffff",
    surface: "#fafafa",
    text: "#262626",
    textMuted: "#6b6b6b",
    border: "#e6e6e6",
    radius: 0,
    spacing: 8,
    fontFamily: "Northwind Sans",
  },
};

/* ------------------------------------------------------------------ screens */

const BODY =
  "Northwind builds electric cars for long distances. Every model charges fast, drives quietly and carries five people with their luggage in comfort. ";

function homeDesktop(): SceneElement {
  return frame({ w: 1280, h: 2080, bg: "#ffffff", tag: "body", gap: 0 }, [
    inst("set-header", header(true)),
    frame({ h: 600, bg: "#1a2129", pad: 80, tag: "section" }, [
      text("Drive the future", 64, 700, "#ffffff", { lh: 1.05, tag: "h1" }),
      text("Electric range up to 600 km.", 18, 300, "#bbbbbb", { lh: 1.55 }),
      inst("set-button", button("#1c69d4", "Learn more")),
    ]),
    frame({ h: 200, bg: "#e22718", pad: [40, 80] }, [
      text("Spring offer", 32, 700, "#ffffff", { lh: 1.15, tag: "h2" }),
    ]),
    frame({ h: 760, bg: "#ffffff", pad: 80, tag: "section" }, [
      text("Discover", 13, 700, "#262626", { ls: 1.5, upper: true }),
      text("Our models", 48, 700, "#262626", { lh: 1.1, tag: "h2" }),
      text(BODY + BODY, 16, 300, "#3c3c3c", { lh: 1.55 }),
      frame({ dir: "row", gap: 24 }, [
        inst("set-card", card("Northwind iX", "From 49,900 EUR")),
        inst("set-card", card("Northwind i5", "From 59,900 EUR")),
        inst("set-card", card("Northwind X1", "From 39,900 EUR")),
      ]),
      text("Fuel consumption combined: 0.0 l/100 km.", 12, 400, "#6b6b6b", { lh: 1.4, ls: 0.5 }),
      frame({ dir: "row", gap: 16 }, [
        inst("set-button", button("#1c69d4", "Learn more")),
        inst("set-button", button("#ffffff", "Configure", "#262626", "#cccccc")),
      ]),
    ]),
    inst("set-footer", footer()),
  ]);
}

function homeMobile(): SceneElement {
  return frame({ w: 390, h: 2600, bg: "#ffffff", tag: "body", gap: 0 }, [
    inst("set-header", header(false)),
    frame({ h: 520, bg: "#1a2129", pad: [48, 16], tag: "section" }, [
      text("Drive the future", 40, 700, "#ffffff", { lh: 1.05, tag: "h1" }),
      text("Electric range up to 600 km.", 16, 300, "#bbbbbb", { lh: 1.55 }),
      inst("set-button", button("#1c69d4", "Learn more")),
    ]),
    frame({ h: 1400, bg: "#ffffff", pad: [48, 16], tag: "section" }, [
      text("Our models", 32, 700, "#262626", { lh: 1.1, tag: "h2" }),
      text(BODY + BODY, 16, 300, "#3c3c3c", { lh: 1.55 }),
      inst("set-card", card("Northwind iX", "From 49,900 EUR")),
    ]),
    inst("set-footer", footer()),
  ]);
}

function modelsDesktop(): SceneElement {
  return frame({ w: 1280, h: 1200, bg: "#ffffff", tag: "body", gap: 0 }, [
    inst("set-header", header(true)),
    frame({ h: 900, bg: "#ffffff", pad: 80, tag: "section" }, [
      text("All models", 48, 700, "#262626", { lh: 1.1, tag: "h1" }),
      text(BODY, 16, 300, "#3c3c3c", { lh: 1.55 }),
      frame({ dir: "row", gap: 16 }, [
        inst("set-button", button("#1c69d4", "Learn more")),
        inst("set-button", button("#1c69d4", "Test drive")),
      ]),
    ]),
    inst("set-footer", footer()),
  ]);
}

/* ------------------------------------------------------------------ captures */

const base = (o: Partial<CapturedControl["base"]> = {}): CapturedControl["base"] => ({
  backgroundColor: "rgb(28, 105, 212)",
  color: "rgb(255, 255, 255)",
  fontFamily: FAMILY,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.5,
  lineHeight: 14,
  borderRadius: 0,
  paddingTop: 14,
  paddingRight: 32,
  paddingBottom: 14,
  paddingLeft: 32,
  height: 48,
  ...o,
});
const cta = (count: number, y: number): CapturedControl => ({
  key: "button.cta|#1c69d4",
  kind: "button",
  text: "Learn more",
  box: { x: 80, y, w: 160, h: 48 },
  count,
  base: base(),
  active: { backgroundColor: "rgb(6, 83, 182)" },
  unreached: ["hover"],
});
const MEDIA: BrandCapture["mediaQueries"] = [
  { query: "(max-width: 767px)", maxWidth: 767, rules: 40 },
  { query: "(min-width: 768px)", minWidth: 768, rules: 30 },
  { query: "(min-width: 1024px)", minWidth: 1024, rules: 25 },
  { query: "(min-width: 1440px)", minWidth: 1440, rules: 12 },
  { query: "(min-width: 1023px)", minWidth: 1023, rules: 3 },
  { query: "(min-width: 500px)", minWidth: 500, rules: 1 },
];
const TEXTS = [
  "Models",
  "Electric",
  "Offers",
  "Dealers",
  "Drive the future",
  "Electric range up to 600 km.",
  "Learn more",
  "Spring offer",
  "Discover",
  "Our models",
  "Northwind iX",
  "Northwind i5",
  "Northwind X1",
  "From 49,900 EUR",
  "Configure",
  "Imprint",
  "Privacy",
  "Contact",
];
const FONTS: BrandCapture["fontFiles"] = [300, 400, 700].map((w) => ({
  family: "Northwind Sans",
  weight: String(w),
  style: "normal",
  url: `https://northwind.example/fonts/nw-${w}.woff2`,
  format: "woff2",
}));
const MARKS: BrandCapture["marks"] = {
  title: "Northwind | Electric cars for long distances",
  icons: [{ rel: "icon", href: "/favicon.svg" }],
  logo: { src: "https://northwind.example/logo.svg", alt: "Northwind", box: { x: 24, y: 16, w: 120, h: 32 } },
};

function capture(url: string, width: number, o: Partial<BrandCapture>): BrandCapture {
  return {
    url: "https://northwind.example",
    finalUrl: url,
    width,
    customProperties: {
      "--nw-primary": "#1c69d4",
      "--nw-error": "#dc2626",
      "--nw-teal": "#0d9488",
      "--nw-space": "8px",
    },
    mediaQueries: MEDIA,
    marks: MARKS,
    images: [],
    icons: [],
    sections: [],
    grids: [],
    controls: [],
    fontFiles: FONTS,
    overlay: null,
    texts: TEXTS,
    ...o,
  };
}

const HOME = "https://northwind.example/en/index.html";
const MODELS = "https://northwind.example/en/models.html";

export function fixtureScreens(): SceneScreen[] {
  const screen = (
    sid: string,
    page: string,
    width: number,
    root: SceneElement,
    cap: BrandCapture,
    minWidth: number,
  ): SceneScreen => ({
    version: 1,
    id: sid,
    name: page.endsWith("models.html") ? "Models" : "Home",
    platform: "web",
    width,
    height: typeof root.layout?.height === "number" ? root.layout.height : 2000,
    responsive: { group: page, minWidth },
    capture: cap,
    root: { ...root, meta: { ...root.meta, source: page, capturedAt: "2026-10-20T09:00:00Z" } },
  });
  return [
    screen(
      "home-1280",
      HOME,
      1280,
      homeDesktop(),
      capture(HOME, 1280, {
        sections: [
          {
            box: { x: 0, y: 0, w: 1280, h: 64 },
            background: "#ffffff",
            paddingTop: 0,
            paddingBottom: 0,
            dark: false,
          },
          {
            box: { x: 0, y: 64, w: 1280, h: 600 },
            background: "#1a2129",
            paddingTop: 80,
            paddingBottom: 80,
            dark: true,
          },
          {
            box: { x: 0, y: 664, w: 1280, h: 200 },
            background: "#e22718",
            paddingTop: 40,
            paddingBottom: 40,
            dark: false,
          },
          {
            box: { x: 0, y: 864, w: 1280, h: 760 },
            background: "#ffffff",
            paddingTop: 80,
            paddingBottom: 80,
            dark: false,
          },
          {
            box: { x: 0, y: 1624, w: 1280, h: 240 },
            background: "#f7f7f7",
            paddingTop: 64,
            paddingBottom: 64,
            dark: false,
          },
        ],
        grids: [
          { box: { x: 80, y: 1100, w: 1119, h: 300 }, columns: 3, gap: 24, itemW: 357, count: 3, section: 3 },
        ],
        images: [
          {
            src: "https://northwind.example/img/hero.jpg",
            naturalW: 2560,
            naturalH: 1200,
            box: { x: 0, y: 64, w: 1280, h: 600 },
            section: 1,
            background: true,
          },
          ...[0, 1, 2].map((i) => ({
            src: `https://northwind.example/img/car-${i}.jpg`,
            naturalW: 800,
            naturalH: 450,
            box: { x: 104 + i * 381, y: 1124, w: 309, h: 174 },
            section: 3,
            objectFit: "cover",
          })),
        ],
        controls: [
          cta(3, 400),
          {
            key: "button.secondary",
            kind: "button",
            text: "Configure",
            box: { x: 260, y: 1500, w: 160, h: 48 },
            count: 2,
            base: base({
              backgroundColor: "rgb(255, 255, 255)",
              color: "rgb(38, 38, 38)",
              borderColor: "rgb(204, 204, 204)",
              borderWidth: 1,
              paddingTop: 13,
              paddingRight: 31,
              paddingBottom: 13,
              paddingLeft: 31,
            }),
          },
          {
            key: "chip.promo",
            kind: "chip",
            text: "Offer",
            box: { x: 80, y: 700, w: 400, h: 120 },
            count: 1,
            base: base({ backgroundColor: "rgb(226, 39, 24)", height: 120, borderRadius: 4 }),
          },
          {
            key: "button.disabled",
            kind: "button",
            text: "Sold out",
            box: { x: 80, y: 1560, w: 160, h: 48 },
            count: 1,
            disabled: true,
            base: base({ backgroundColor: "rgb(214, 214, 214)", color: "rgb(107, 107, 107)" }),
          },
          {
            key: "tab",
            kind: "tab",
            text: "All",
            box: { x: 80, y: 900, w: 60, h: 40 },
            count: 4,
            base: base({
              backgroundColor: "rgba(0, 0, 0, 0)",
              color: "rgb(107, 107, 107)",
              fontSize: 13,
              height: 40,
              paddingLeft: 0,
              paddingRight: 0,
            }),
            hover: { color: "rgb(38, 38, 38)" },
          },
          {
            key: "tab.selected",
            kind: "tab",
            text: "Electric",
            box: { x: 160, y: 900, w: 80, h: 40 },
            count: 1,
            selected: true,
            base: base({
              backgroundColor: "rgba(0, 0, 0, 0)",
              color: "rgb(38, 38, 38)",
              fontSize: 13,
              height: 40,
              paddingLeft: 0,
              paddingRight: 0,
            }),
          },
        ],
      }),
      1024,
    ),
    screen(
      "home-390",
      HOME,
      390,
      homeMobile(),
      capture(HOME, 390, {
        sections: [
          {
            box: { x: 0, y: 0, w: 390, h: 64 },
            background: "#ffffff",
            paddingTop: 0,
            paddingBottom: 0,
            dark: false,
          },
          {
            box: { x: 0, y: 64, w: 390, h: 520 },
            background: "#1a2129",
            paddingTop: 48,
            paddingBottom: 48,
            dark: true,
          },
        ],
        grids: [
          { box: { x: 16, y: 900, w: 358, h: 900 }, columns: 1, gap: 16, itemW: 358, count: 3, section: 3 },
        ],
        controls: [cta(2, 380)],
      }),
      0,
    ),
    screen(
      "models-1280",
      MODELS,
      1280,
      modelsDesktop(),
      capture(MODELS, 1280, {
        sections: [
          {
            box: { x: 0, y: 64, w: 1280, h: 900 },
            background: "#ffffff",
            paddingTop: 80,
            paddingBottom: 80,
            dark: false,
          },
        ],
        controls: [
          { ...cta(2, 300), text: "Test drive" },
          {
            key: "chip.promo",
            kind: "chip",
            text: "Offer",
            box: { x: 80, y: 200, w: 400, h: 120 },
            count: 1,
            base: base({ backgroundColor: "rgb(226, 39, 24)", height: 120, borderRadius: 4 }),
          },
        ],
      }),
      1024,
    ),
  ];
}

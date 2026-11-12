// The modern recreation: one semantic DOM for every width (the live page's own structure, matched across its walks),
// mobile-first CSS fitted from the measurements (fluid values, the page's own breakpoints, no per-width copies),
// real media (video, srcset images), the page's hover looks as CSS, and a small accessible runtime for menus,
// sliders and video. What the live page lacks for accessibility (names of icon controls, a skip link, a pause control
// for moving video, landmarks, heading order) is added, never taken away.
import { createHash } from "node:crypto";
import type {
  ImportedFont,
  SnapElement,
  SnapHover,
  SnapNode,
  SnapSlider,
  SnapState,
  SnapText,
  Snapshot,
} from "@harness/capture";
import { decodeDataUrl } from "./dataurl.js";
import { imageSize } from "./imagesize.js";
import {
  cursorCss,
  defaultDisplay,
  elementDecls,
  INHERITED,
  isMedia,
  textDecls,
  transformCss,
  type Decls,
  type InferContext,
} from "./infer.js";
import { MODERN_RUNTIME_JS } from "./runtime.js";
import { fitCss, fitSamples, type Sample } from "./fit.js";
import {
  eachNode,
  indexWalk,
  isEl,
  isTextNode,
  unify,
  type ModernVariant,
  type UNode,
  type Unified,
  type Walk,
} from "./unify.js";

export type ModernFiles = Record<string, string | Uint8Array>;

export interface ModernInput {
  variants: ModernVariant[];
  page?: string;
  sourceUrl?: string;
  /** downloaded videos: source URL → file bytes and type */
  media?: Record<string, { body: Uint8Array; type: string }>;
  /** embed: font files in fonts/ (default); system: fallback stacks only */
  fonts?: "embed" | "system";
  /** none: images left out (placeholders) */
  images?: boolean;
}

/** The page as a tree of sections with their markup and rules (the Lit emitter builds components from it). */
export interface ModernDoc {
  lang: string;
  title: string;
  description: string;
  head: string[];
  /** global CSS: reset, tokens, fonts, base text */
  baseCss: string;
  /** every section in page order: its markup and the rules of its classes */
  sections: { id: string; label: string; tag: string; html: string; css: string; interactive: boolean }[];
  /** markup outside sections (skip link) */
  prelude: string;
  /**
   * the body as the page nests it, each section a `<!--section:ID-->` placeholder (the Lit project puts its
   * components there, inside the page's own wrappers)
   */
  skeleton: string;
  /** class of the body (its rules are in the page section's CSS) */
  bodyClass?: string;
  runtime: string;
}

export interface ModernReport {
  nodes: number;
  sections: number;
  classes: number;
  mediaQueries: number[];
  videos: { src: string; file?: string; reason?: string }[];
  sliders: number;
  hoverRules: number;
  menus: number;
  added: string[];
}

interface Role {
  slider?: {
    id: string;
    facts: SnapSlider;
    role: "scroller" | "track" | "slide";
    index?: number;
    count?: number;
  };
  arrow?: { slider: string; dir: 1 | -1 };
  dots?: { slider: string; active?: number };
  dot?: { slider: string; index: number };
  video?: { id: string };
  videoToggle?: { video: string };
  menuTrigger?: string;
  menuClose?: boolean;
  menuBack?: boolean;
  menuPanel?: string;
  pseudo?: "before" | "after";
  skip?: boolean;
  /** a marquee: copies of one strip moving endlessly (the box that clips it, the moving track, each copy) */
  marquee?: { id: string; role: "frame" | "track" | "copy"; index?: number; copies?: number; source?: UNode };
  marqueeToggle?: string;
}

/** the labels the recreation adds (names of controls the page left unnamed, its skip link), per page language */
const LABELS = {
  en: {
    next: "Next slide",
    previous: "Previous slide",
    slide: "Go to slide {}",
    slides: "Slides {}",
    pauseVideo: "Pause video",
    playVideo: "Play video",
    pauseAnimation: "Pause animation",
    playAnimation: "Play animation",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    openSubmenu: "Open submenu",
    submenu: "{}: submenu",
    back: "Back",
    skip: "Skip to content",
  },
  de: {
    next: "Nächste Folie",
    previous: "Vorherige Folie",
    slide: "Zu Folie {}",
    slides: "Folien {}",
    pauseVideo: "Video anhalten",
    playVideo: "Video abspielen",
    pauseAnimation: "Animation anhalten",
    playAnimation: "Animation abspielen",
    openMenu: "Menü öffnen",
    closeMenu: "Menü schließen",
    openSubmenu: "Untermenü öffnen",
    submenu: "{}: Untermenü",
    back: "Zurück",
    skip: "Zum Inhalt springen",
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
const slug = (s: string, max = 32) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");

const KNOWN = new Set(
  "a abbr address article aside b blockquote br button caption cite code dd del details dfn div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend li main mark nav ol p picture pre q s samp section select small span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul video svg canvas dialog menu output meter progress".split(
    " ",
  ),
);
const VOID = new Set(["br", "img", "input", "hr", "source", "wbr"]);
const INTERACTIVE = new Set(["a", "button", "summary", "select", "input", "textarea"]);

/** words in class names that say what an icon control does → its accessible name */
const CONTROL_WORDS: [RegExp, string][] = [
  [/pause/i, "Pause"],
  [/\bplay|start-?anim/i, "Play"],
  [/next|forward|right/i, "Next"],
  [/prev|back|left/i, "Previous"],
  [/close|dismiss/i, "Close"],
  [/burger|hamburger|menu|nav-?toggle|navigation/i, "Menu"],
  [/search|such/i, "Search"],
  [/share/i, "Share"],
  [/mute/i, "Mute"],
  [/top/i, "Back to top"],
  [/lang|sprach/i, "Language"],
  [/login|account|konto/i, "Account"],
  [/cart|basket|warenkorb/i, "Cart"],
];
const SOCIAL: [RegExp, string][] = [
  [/linkedin\./i, "LinkedIn"],
  [/xing\./i, "XING"],
  [/facebook\./i, "Facebook"],
  [/instagram\./i, "Instagram"],
  [/(twitter|x)\.com/i, "X"],
  [/youtube\./i, "YouTube"],
  [/github\./i, "GitHub"],
  [/tiktok\./i, "TikTok"],
  [/kununu\./i, "kununu"],
  [/medium\./i, "Medium"],
  [/^mailto:/i, "E-mail"],
  [/^tel:/i, "Phone"],
];

export function emitModern(input: ModernInput): { files: ModernFiles; report: ModernReport; doc: ModernDoc } {
  const model = unify(input.variants);
  return new ModernEmitter(model, input).run();
}

class ModernEmitter {
  readonly files: ModernFiles = {};
  readonly roles = new Map<UNode, Role>();
  readonly report: ModernReport = {
    nodes: 0,
    sections: 0,
    classes: 0,
    mediaQueries: [],
    videos: [],
    sliders: 0,
    hoverRules: 0,
    menus: 0,
    added: [],
  };
  readonly colors = new Map<string, number>();
  readonly assetFiles = new Map<string, string>();
  readonly decls = new Map<UNode, (Decls | null)[]>();
  readonly classOf = new Map<UNode, string>();
  readonly tags = new Map<UNode, string>();
  readonly labels = new Map<UNode, string>();
  readonly ids = new Map<UNode, string>();
  readonly extraAttrs = new Map<UNode, Record<string, string>>();
  readonly srOnly = new Map<string, { text: string; tag: string; href?: string }[]>();
  /** state rules: selector scope → node → per-variant decls */
  readonly stateRules: { scope: string; node: UNode; vi: number; decls: Decls; self?: boolean }[] = [];
  readonly hoverRules: { sel: string[]; decls: Decls }[] = [];
  readonly hovered = new Set<UNode>();
  /** nodes shown only in a state (the open menu): their walk there */
  readonly stateNodes = new Map<UNode, SnapNode>();
  /** active looks of slider dots: the dots box → what the current dot changes */
  readonly activeDots = new Map<UNode, Decls>();
  sections: UNode[] = [];
  bodyText: Decls = new Map();
  lcp?: UNode;

  constructor(
    readonly model: Unified,
    readonly input: ModernInput,
  ) {}

  get vs() {
    return this.model.variants;
  }

  snap0(): Snapshot {
    return this.vs[this.vs.length - 1]!.snap;
  }

  run(): { files: ModernFiles; report: ModernReport; doc: ModernDoc } {
    eachNode(this.model.root, () => this.report.nodes++);
    this.collectSrOnly();
    this.findRoles();
    this.unifyStates();
    this.semantics();
    const ctx = this.context();
    this.hoverCss(ctx);
    eachNode(this.model.root, (u) => {
      if (u.text) return;
      this.decls.set(
        u,
        this.vs.map((_, vi) => {
          const n = u.at[vi];
          if (!isEl(n)) return null;
          const d = elementDecls(u, vi, this.model, ctx);
          const t = textDecls(u, vi, this.model, ctx);
          if (t) for (const [k, v] of t) d.set(k, v);
          this.listStyle(u, vi, d);
          this.marqueeDecls(u, vi, d);
          this.standaloneLink(u, vi, d);
          this.inlineAlign(u, vi, d);
          this.normalise(d);
          return d;
        }),
      );
    });
    this.visualOrder();
    this.videoPosters();
    this.sliderBleed();
    this.closedPanels();
    this.activeLooks();
    this.transparentBoxes();
    this.stateCss(ctx);
    this.inherit();
    this.findSections();
    this.findLcp();
    const css = this.css();
    const doc = this.document(css);
    this.files["index.html"] = this.html(doc);
    this.files["styles.css"] =
      `${doc.baseCss}\n${doc.sections.map((s) => s.css).join("\n")}\n${this.globalStateCss}`;
    this.files["app.js"] = MODERN_RUNTIME_JS;
    this.report.sections = this.sections.length;
    this.report.classes = new Set(this.classOf.values()).size;
    this.report.mediaQueries = this.vs.map((v) => v.minWidth).filter((w) => w > 0);
    return { files: this.files, report: this.report, doc };
  }

  // ---------------------------------------------------------------------------------------------- roles

  collectSrOnly() {
    for (const v of this.vs)
      for (const s of v.snap.srOnly ?? []) {
        const list = this.srOnly.get(s.parent) ?? [];
        if (!list.some((x) => x.text === s.text))
          list.push({ text: s.text, tag: s.tag, ...(s.href ? { href: s.href } : {}) });
        this.srOnly.set(s.parent, list);
      }
  }

  role(u: UNode): Role {
    let r = this.roles.get(u);
    if (!r) this.roles.set(u, (r = {}));
    return r;
  }

  /** the node of a walk node id */
  nodeOfId(vi: number, id: number | undefined, walk?: Walk): UNode | undefined {
    if (id === undefined) return undefined;
    const w = walk ?? this.model.walks[vi]![0]!;
    const n = w.byId.get(id);
    return n?.key ? this.model.byKey.get(n.key) : undefined;
  }

  findRoles() {
    let sliders = 0,
      videos = 0;
    eachNode(this.model.root, (u) => {
      if (u.key.endsWith("::before")) this.role(u).pseudo = "before";
      if (u.key.endsWith("::after")) this.role(u).pseudo = "after";
    });
    // sliders: from the widest variant that has them
    this.vs.forEach((v, vi) => {
      const w = this.model.walks[vi]![0]!;
      for (const n of w.byKey.values()) {
        if (!isEl(n)) continue;
        const u = this.model.byKey.get(n.key!);
        if (!u) continue;
        const sc = n.scroller;
        if (sc && sc.axis === "x" && sc.slider && !this.roles.get(u)?.slider) {
          const id = `slider-${++sliders}`;
          const f = sc.slider;
          this.role(u).slider = { id, facts: f, role: "scroller" };
          const track = f.row ? this.model.byKey.get(f.row) : undefined;
          const trackU = track && track !== u ? track : u;
          this.role(trackU).slider = { id, facts: f, role: "track" };
          const slides = trackU.children.filter((c) => !c.text && !this.roles.get(c)?.pseudo);
          slides.forEach(
            (s, k) => (this.role(s).slider = { id, facts: f, role: "slide", index: k, count: slides.length }),
          );
          if (f.dots) {
            const dots = this.model.byKey.get(f.dots.key);
            if (dots) {
              this.role(dots).dots = {
                slider: id,
                ...(f.dots.active !== undefined ? { active: f.dots.active } : {}),
              };
              dots.children
                .filter((c) => !c.text)
                .forEach((c, k) => (this.role(c).dot = { slider: id, index: k }));
            }
          }
        }
        if (n.carousel) {
          const target = w.byId.get(n.carousel.scroller);
          const tu = target?.key ? this.model.byKey.get(target.key) : undefined;
          const s = tu ? this.roles.get(tu)?.slider : undefined;
          if (s) this.role(u).arrow = { slider: s.id, dir: n.carousel.dir };
        }
        if (n.tag === "video" && n.media?.kind === "video" && !this.roles.get(u)?.video)
          this.role(u).video = { id: `video-${++videos}` };
      }
      // rows of slides the page clips further up (Swiper in free mode, a hand-made track): a slider too
      for (const n of w.byKey.values()) {
        if (
          !isEl(n) ||
          !/flex/.test(n.layout?.display ?? "") ||
          /column/.test(n.layout?.dir ?? "row") ||
          (n.layout?.wrap ?? "nowrap") !== "nowrap"
        )
          continue;
        const u = this.model.byKey.get(n.key!);
        if (!u || this.roles.get(u)?.slider) continue;
        const kids = (n.children ?? []).filter(
          (c): c is SnapElement => isEl(c) && !c.pseudo && (c.rect?.w ?? 0) > 40,
        );
        if (kids.length < 3) continue;
        let clip: SnapElement | undefined;
        for (let p = w.parentOf.get(n); p; p = w.parentOf.get(p))
          if (/hidden|clip/.test(p.style?.overflow?.[0] ?? "")) {
            clip = p;
            break;
          }
        if (!clip) continue;
        const right = clip.rect.x + clip.rect.w;
        const past = kids.filter(
          (k) => k.rect.x >= right - 1 || k.rect.x + k.rect.w <= clip!.rect.x + 1,
        ).length;
        if (!past || past === kids.length) continue;
        const id = `slider-${++sliders}`;
        const shown = kids.length - past;
        let free = false;
        for (let p: SnapElement | undefined = n, i = 0; p && i < 4; p = w.parentOf.get(p), i++)
          if (/free-?mode/i.test(p.attrs?.class ?? "")) free = true;
        const f: SnapSlider = { slides: kids.length, perView: shown, row: n.key!, ...(free ? { free } : {}) };
        if (clip.key) this.bleedTo.set(u, clip.key);
        this.role(u).slider = { id, facts: f, role: "track" };
        const slides = u.children.filter((c) => !c.text && !this.roles.get(c)?.pseudo);
        slides.forEach(
          (sl, k) => (this.role(sl).slider = { id, facts: f, role: "slide", index: k, count: slides.length }),
        );
      }
      // the menu (narrow variants): trigger, panel, close
      for (const st of v.snap.states ?? []) {
        if (st.kind !== "menu") continue;
        const trig = this.nodeOfId(vi, st.trigger);
        if (trig) this.role(trig).menuTrigger = "menu";
      }
    });
    this.marquees();
    // the page's own skip link: replaced by the recreation's (its focus look was never captured)
    const skip = this.snap0().doc?.skipLink;
    if (skip)
      eachNode(this.model.root, (u) => {
        if (u.tag === "a" && this.textOf(u) === skip.text.trim()) this.role(u).skip = true;
      });
    // video controls: a button near the video that pauses / plays it
    for (const [u, r] of [...this.roles]) {
      if (!r.video) continue;
      let scope = u.parent;
      for (let k = 0; k < 3 && scope?.parent; k++) scope = scope.parent;
      if (!scope) continue;
      eachNode(scope, (c) => {
        if (c.text || this.roles.get(c)?.videoToggle) return;
        const n = c.at.find(isEl) as SnapElement | undefined;
        if (!n || (!/^(button|a)$/.test(n.tag) && n.attrs?.role !== "button")) return;
        const words = `${n.attrs?.class ?? ""} ${n.attrs?.["aria-label"] ?? ""} ${n.attrs?.title ?? ""}`;
        if (/pause|play|anim|video|stop/i.test(words)) this.role(c).videoToggle = { video: r.video!.id };
      });
    }
    this.report.sliders = sliders;
  }

  /**
   * A slider whose slides are copies of one strip (logos, a ticker) is a marquee: the strip moves endlessly by CSS
   * (the copies side by side, the track shifted by one copy), the page's pause control or hover stops it
   */
  marquees() {
    let k = 0;
    const sig = (u: UNode) => {
      const parts: string[] = [];
      eachNode(u, (x) => {
        const n = x.at.find(Boolean);
        if (x.text) parts.push(((n as SnapText | undefined)?.text ?? "").trim());
        else if (isEl(n) && (n.src || n.svg)) parts.push(String(n.src ?? n.svg?.length));
      });
      return parts.join("|");
    };
    for (const [u, r] of [...this.roles]) {
      if (r.slider?.role !== "track") continue;
      const copies = u.children.filter((c) => !c.text && !this.roles.get(c)?.pseudo);
      if (copies.length < 2 || copies.length > 4) continue;
      // the frame: the slider's clipping box (its scroller), else the track's parent
      const frame =
        [...this.roles].find(([, x]) => x.slider?.id === r.slider!.id && x.slider.role === "scroller")?.[0] ??
        u.parent!;
      const controlled = [...this.roles.values()].some(
        (x) => x.arrow?.slider === r.slider!.id || x.dots?.slider === r.slider!.id,
      );
      const width = (x: UNode) => Math.max(0, ...x.at.map((n) => (isEl(n) ? n.rect.w : 0)));
      // copies of one strip: alike, or each at least as wide as the frame (a strip that loops); no arrows or dots
      const alike = !!sig(copies[0]!) && copies.every((c) => sig(c) === sig(copies[0]!));
      const strips = copies.every((c) => width(c) >= width(frame) * 0.9);
      if (controlled || !(alike || strips)) continue;
      const id = `marquee-${++k}`;
      // the copy the capture saw most of: every copy is written from it (an off-screen copy loses its media)
      const best = [...copies].sort((a, b) => sig(b).length - sig(a).length)[0]!;
      const sid = r.slider.id;
      for (const [, y] of [...this.roles]) if (y.slider?.id === sid) delete y.slider;
      // nothing inside a marquee is a slider of its own (rows of logos in a copy)
      eachNode(frame, (x) => {
        const y = this.roles.get(x);
        if (y?.slider) delete y.slider;
      });
      this.role(frame).marquee = { id, role: "frame" };
      this.role(u).marquee = { id, role: "track", copies: copies.length };
      copies.forEach(
        (c, i) =>
          (this.role(c).marquee = { id, role: "copy", index: i, ...(c !== best ? { source: best } : {}) }),
      );
      // its pause control: a button beside it that pauses / plays an animation
      let scope: UNode | undefined = frame;
      for (let i = 0; i < 4 && scope?.parent; i++) scope = scope.parent;
      if (scope)
        eachNode(scope, (c) => {
          const n = this.el(c);
          if (!n || (n.tag !== "button" && n.attrs?.role !== "button") || this.roles.get(c)?.videoToggle)
            return;
          if (
            /pause|play|anim|stop/i.test(
              `${n.attrs?.class ?? ""} ${n.attrs?.["aria-label"] ?? ""} ${n.attrs?.title ?? ""}`,
            )
          )
            this.role(c).marqueeToggle = id;
        });
      this.report.added.push(`marquee ${id} as a CSS animation`);
    }
  }

  /** menu / submenu states: nodes only shown in them join the tree; their looks there become state rules */
  stateWalks: { scope: string; vi: number; walk: Walk; state: SnapState; region?: string }[] = [];
  /** widget regions (tabs, accordions, toggles that swap a box): region key → its id and its states by control key */
  readonly regions = new Map<
    string,
    { id: string; states: Map<string, { state: string; toggle: boolean; hover?: boolean }> }
  >();
  unifyStates() {
    // one region per control: the smallest box any width saw it change (a wide walk can blame a whole page)
    const regionFor = new Map<string, string>();
    this.vs.forEach((v, vi) => {
      const main = this.model.walks[vi]![0]!;
      for (const st of v.snap.states ?? []) {
        if (st.kind !== "region") continue;
        const reg = st.region !== undefined ? main.byId.get(st.region) : undefined;
        const ctlId = st.index !== undefined ? v.snap.controls?.[st.index]?.id : undefined;
        const ctl = ctlId !== undefined ? main.byId.get(ctlId) : undefined;
        if (!reg?.key || !ctl?.key) continue;
        const prev = regionFor.get(ctl.key);
        if (!prev || reg.key.split("/").length > prev.split("/").length) regionFor.set(ctl.key, reg.key);
      }
    });
    // what a control says it controls (a tab's panel, an accordion's answer) is part of its region too
    const byId = new Map<string, string>();
    eachNode(this.model.root, (u) => {
      const id = (u.at.find(isEl) as SnapElement | undefined)?.attrs?.id;
      if (id && !byId.has(id)) byId.set(id, u.key);
    });
    const common = (a: string, b: string) => {
      let x = this.model.byKey.get(a);
      const ys = new Set<UNode>();
      for (let y = this.model.byKey.get(b); y; y = y.parent) ys.add(y);
      while (x && !ys.has(x)) x = x.parent;
      return x?.key;
    };
    for (const [ctlKey, regKey] of [...regionFor]) {
      const ctl = this.model.byKey.get(ctlKey);
      const ids = ((ctl?.at.find(isEl) as SnapElement | undefined)?.aria?.["aria-controls"] ?? "").split(
        /\s+/,
      );
      let key = regKey;
      for (const id of ids) {
        const t = id && byId.get(id);
        if (t) key = common(key, t) ?? key;
      }
      regionFor.set(ctlKey, key);
    }
    // controls of one group (tabs) share one region: the smallest box holding all their regions
    for (const [ctlKey] of regionFor) {
      const ctl = this.model.byKey.get(ctlKey);
      for (const sib of ctl?.parent?.children ?? []) {
        const other = regionFor.get(sib.key);
        if (sib !== ctl && other && other !== regionFor.get(ctlKey)) {
          const c = common(regionFor.get(ctlKey)!, other);
          if (c) {
            regionFor.set(ctlKey, c);
            regionFor.set(sib.key, c);
          }
        }
      }
    }
    this.vs.forEach((v, vi) => {
      const states = v.snap.states ?? [];
      const main = this.model.walks[vi]![0]!;
      states.forEach((st, k) => {
        if (st.kind !== "menu" && st.kind !== "submenu" && st.kind !== "region") return;
        const walk = indexWalk(
          st.snapshot.root,
          st.snapshot.viewport?.width ?? v.width,
          st.snapshot.viewport?.height ?? v.snap.viewport.height,
        );
        const name = st.kind === "menu" ? "menu" : `sub-${k}`;
        if (st.kind === "region") {
          // a widget in another state: its region and the control that shows it
          const ctlId = st.index !== undefined ? v.snap.controls?.[st.index]?.id : undefined;
          const ctl = ctlId !== undefined ? main.byId.get(ctlId) : undefined;
          const regKey = ctl?.key ? regionFor.get(ctl.key) : undefined;
          if (!regKey || !ctl?.key || !this.model.byKey.has(regKey) || !this.model.byKey.has(ctl.key)) return;
          // a slider's dots and arrows: the slider drives them
          const cr = this.roles.get(this.model.byKey.get(ctl.key)!);
          if (cr?.dot || cr?.arrow) return;
          const reg = { key: regKey };
          let r = this.regions.get(reg.key);
          if (!r) this.regions.set(reg.key, (r = { id: `r${this.regions.size + 1}`, states: new Map() }));
          let one = r.states.get(ctl.key);
          if (!one)
            r.states.set(
              ctl.key,
              (one = { state: String(r.states.size + 1), toggle: !!st.toggle, hover: !!st.hover }),
            );
          // a desktop flyout: open while the pointer is over its entry or focus is in it (keyboard), in CSS alone
          const at = `[data-region="${r.id}"]`;
          this.stateWalks.push({
            scope: one.hover ? `:is(${at}:hover, ${at}:focus-within)` : `${at}[data-state="${one.state}"]`,
            vi,
            walk,
            state: st,
            region: reg.key,
          });
        } else this.stateWalks.push({ scope: `:root[data-menu="${name}"]`, vi, walk, state: st });
        // nodes the state adds: into the tree, absent at rest
        const add = (n: SnapNode, parentKey: string | undefined) => {
          if (!n.key) return;
          let u = this.model.byKey.get(n.key);
          if (!u) {
            const pu = parentKey ? this.model.byKey.get(parentKey) : undefined;
            if (!pu) return;
            u = {
              key: n.key,
              text: n.kind === "text",
              tag: n.kind === "text" ? "#text" : (n as SnapElement).tag,
              ord: n.ord ?? 0,
              at: this.vs.map(() => undefined),
              children: [],
              parent: pu,
            };
            this.model.byKey.set(u.key, u);
            pu.children.push(u);
            pu.children.sort((a, b) => a.ord - b.ord);
            (u as UNode & { stateOnly?: boolean }).stateOnly = true;
          }
          if (!this.stateNodes.has(u) && !u.at.some(Boolean)) this.stateNodes.set(u, n);
          if (n.kind !== "text")
            for (const c of (n as SnapElement).children ?? []) {
              // a box the capture moved for paint order goes back under its own parent (its containing block)
              const from = (c as SnapElement).from;
              const real = typeof from === "number" ? walk.byId.get(from)?.key : undefined;
              add(c, real && this.model.byKey.has(real) ? real : n.key);
            }
        };
        if (st.snapshot.root) add(st.snapshot.root, undefined);
        if (st.kind === "region") return;
        const panel =
          st.panel !== undefined
            ? st.snapshot.root && indexWalk(st.snapshot.root, 0, 0).byId.get(st.panel)
            : undefined;
        const close = st.close !== undefined ? walk.byId.get(st.close) : undefined;
        if (panel?.key) {
          const pu = this.model.byKey.get(panel.key);
          if (pu && !this.role(pu).menuPanel) this.role(pu).menuPanel = name;
        }
        if (close?.key) {
          const cu = this.model.byKey.get(close.key);
          const trig = this.nodeOfId(vi, st.trigger);
          if (cu && cu !== trig) this.role(cu).menuClose = true;
        }
        if (st.kind === "submenu") {
          const parent = states[st.parent ?? 0];
          const pw = parent?.snapshot.root ? indexWalk(parent.snapshot.root, 0, 0) : undefined;
          const item = st.item !== undefined && pw ? pw.byId.get(st.item) : undefined;
          const iu = item?.key ? this.model.byKey.get(item.key) : undefined;
          if (iu) this.role(iu).menuTrigger = name;
          const back = st.back !== undefined ? walk.byId.get(st.back) : undefined;
          const bu = back?.key ? this.model.byKey.get(back.key) : undefined;
          if (bu) this.role(bu).menuBack = true;
        }
      });
    });
    this.report.menus = new Set(this.stateWalks.map((s) => s.scope)).size;
  }

  // ---------------------------------------------------------------------------------------------- semantics

  /** a node's live element (from the widest variant that shows it) */
  el(u: UNode): SnapElement | undefined {
    for (let vi = this.vs.length - 1; vi >= 0; vi--) if (isEl(u.at[vi])) return u.at[vi] as SnapElement;
    for (const s of this.stateWalks) {
      const n = s.walk.byKey.get(u.key);
      if (isEl(n)) return n;
    }
    return undefined;
  }

  semantics() {
    // tags: the live page's, custom elements and presentational tags mapped to div / span
    eachNode(this.model.root, (u) => {
      if (u.text) return;
      const n = this.el(u);
      let tag = u.tag;
      if (!KNOWN.has(tag))
        tag =
          n?.layout?.display && /^inline/.test(n.layout.display) && !/block|flex|grid/.test(n.layout.display)
            ? "span"
            : "div";
      if (n?.kind === "raster")
        tag = this.roles.get(u)?.video ? "video" : n.tag === "input" ? "input" : "img";
      if (n?.kind === "img") tag = "img";
      if (n?.kind === "svg") tag = "svg";
      if (n?.kind === "input")
        tag = n.input?.multiline
          ? "textarea"
          : n.input?.type === "select"
            ? "select"
            : n.input?.type === "button"
              ? "button"
              : "input";
      if (u === this.model.root) tag = "body";
      this.tags.set(u, tag);
    });
    this.validNesting();
    // the slider arrows and dots are buttons
    for (const [u, r] of this.roles)
      if (r.dot) this.tags.set(u, "span");
      else if (r.arrow || r.videoToggle || r.menuTrigger || r.menuClose || r.menuBack || r.marqueeToggle) {
        const t = this.tags.get(u) ?? "";
        // a control is a button; a link stays a link only where it goes somewhere
        if (t !== "button" && !(t === "a" && this.el(u)?.attrs?.href)) this.tags.set(u, "button");
      }
    // an anchor that goes nowhere is no link: a button where it opens something, else plain text
    eachNode(this.model.root, (u) => {
      const n = this.el(u);
      if (u.text || this.tags.get(u) !== "a" || !n || n.attrs?.href) return;
      const opens = !!(
        n.aria?.["aria-haspopup"] ||
        n.aria?.["aria-expanded"] ||
        n.attrs?.role === "button" ||
        n.pointer ||
        this.roles.get(u)?.menuTrigger
      );
      this.tags.set(u, opens ? "button" : "span");
    });
    // what the page made a button with a role (an icon that opens a submenu): a real button
    eachNode(this.model.root, (u) => {
      const n = this.el(u);
      if (
        !u.text &&
        n?.attrs?.role === "button" &&
        /^(span|div|i|a)$/.test(this.tags.get(u) ?? "") &&
        !(this.tags.get(u) === "a" && n.attrs?.href)
      )
        this.tags.set(u, "button");
    });
    // one h1, no skipped heading levels (the look stays: it is the class's)
    const heads: UNode[] = [];
    eachNode(this.model.root, (u) => {
      if (/^h[1-6]$/.test(this.tags.get(u) ?? "")) heads.push(u);
    });
    if (!heads.some((h) => this.tags.get(h) === "h1")) {
      const cand = this.firstBigText();
      if (cand) {
        this.tags.set(cand, "h1");
        heads.unshift(cand);
        heads.sort((a, b) => this.order(a) - this.order(b));
        this.report.added.push("h1 for the page's main title");
      }
    }
    // headings of the page's chrome (navigation, menus, panels shown on demand) are never its h1
    const chrome = (u: UNode) => {
      if (!u.at.some(Boolean)) return true;
      for (let p: UNode | undefined = u.parent; p; p = p.parent) {
        if (/^(nav|header|aside|dialog)$/.test(this.tags.get(p) ?? "") || this.roles.get(p)?.menuPanel)
          return true;
        if (!p.at.some(Boolean)) return true;
      }
      return false;
    };
    const page = heads.filter((h) => !chrome(h));
    if (!page.some((h) => this.tags.get(h) === "h1") && page.length) {
      const first = page.find(
        (h) =>
          Number(this.tags.get(h)!.slice(1)) ===
          Math.min(...page.map((x) => Number(this.tags.get(x)!.slice(1)))),
      );
      if (first) this.tags.set(first, "h1");
    }
    let prev = 0;
    let firstH1 = true;
    for (const h of heads) {
      let lv = Number(this.tags.get(h)!.slice(1));
      if (chrome(h)) {
        // in the chrome: below the page's outline, never skipping more than one level
        lv = Math.max(2, Math.min(lv, prev + 1));
      } else {
        if (lv === 1 && !firstH1) lv = 2;
        if (lv === 1) firstH1 = false;
        if (lv > prev + 1) lv = Math.max(prev + 1, 1);
        if (firstH1 && lv > 1 && page[0] === h) lv = 1;
        if (lv === 1) firstH1 = false;
      }
      if (`h${lv}` !== this.tags.get(h)) this.tags.set(h, `h${lv}`);
      prev = lv;
    }
    // accessible names of controls and images
    eachNode(this.model.root, (u) => {
      const tag = this.tags.get(u);
      if (!tag || u.text) return;
      const n = this.el(u);
      if (!n) return;
      if ((tag === "a" || tag === "button") && !this.hasName(u)) {
        const label = this.deriveLabel(u, n);
        this.labels.set(u, label);
        this.report.added.push(`name "${label}" for an icon ${tag}`);
      }
      if (tag === "iframe" && !n.attrs?.title) this.labels.set(u, "Embedded content");
    });
    // more than one nav: each named
    const navs: UNode[] = [];
    eachNode(this.model.root, (u) => {
      if (this.tags.get(u) === "nav") navs.push(u);
    });
    if (navs.length > 1)
      navs.forEach((u, k) => {
        const n = this.el(u);
        if (!n?.attrs?.["aria-label"] && !n?.aria?.["labelledby-text"]) {
          const inFooter = this.ancestorTag(u, "footer");
          this.labels.set(
            u,
            inFooter
              ? k === navs.length - 1
                ? "Footer"
                : `Footer ${k + 1}`
              : k === 0
                ? "Main"
                : `Navigation ${k + 1}`,
          );
        }
      });
  }

  /**
   * Markup the HTML parser keeps as it is: lists hold only items (a wrapper between a list and its items becomes the
   * list), items sit in lists, a paragraph holds no blocks, links and buttons do not nest. The live DOM (built by
   * scripts) can break these rules; written out as HTML they would be restructured by the browser.
   */
  validNesting() {
    const kids = (u: UNode) => u.children.filter((c) => !c.text && !this.roles.get(c)?.pseudo);
    const isList = (t?: string) => t === "ul" || t === "ol" || t === "menu";
    eachNode(this.model.root, (u) => {
      const t = this.tags.get(u);
      if (!isList(t)) return;
      const ks = kids(u);
      if (ks.every((c) => this.tags.get(c) === "li")) return;
      // the box holding the items (others beside it: a slider's live region) becomes the list
      const wrapper = ks.find((c) => kids(c).length > 0 && kids(c).every((x) => this.tags.get(x) === "li"));
      if (wrapper) {
        // ul > div.swiper-wrapper > li: the wrapper is the list
        this.tags.set(u, "div");
        this.tags.set(wrapper, t!);
        return;
      }
      let items = false;
      for (const c of ks) eachNode(c, (x) => x !== c && this.tags.get(x) === "li" && (items = true));
      if (items) this.tags.set(u, "div");
      else for (const c of ks) if (this.tags.get(c) !== "li") this.tags.set(c, "li");
    });
    const BLOCK =
      /^(div|p|ul|ol|li|section|article|header|footer|nav|main|aside|figure|figcaption|h[1-6]|table|form|blockquote|address|dl|hr|pre|fieldset|details)$/;
    eachNode(this.model.root, (u) => {
      const t = this.tags.get(u);
      if (t === "li" && u.parent && !isList(this.tags.get(u.parent))) this.tags.set(u, "div");
      // a heading inside a heading is closed by the parser
      if (/^h[1-6]$/.test(t ?? "") && u.parent && this.ancestorHeading(u)) this.tags.set(u, "span");
      // a paragraph or heading-level phrasing container holding blocks
      if (t === "p" && kids(u).some((c) => BLOCK.test(this.tags.get(c) ?? ""))) this.tags.set(u, "div");
      // links and buttons inside links and buttons: the inner ones lose their own interactivity in markup
      if ((t === "a" || t === "button") && u.parent) {
        for (let p: UNode | undefined = u.parent; p; p = p.parent)
          if (/^(a|button)$/.test(this.tags.get(p) ?? "")) {
            this.tags.set(u, "span");
            break;
          }
      }
    });
  }

  ancestorHeading(u: UNode) {
    for (let p = u.parent; p; p = p.parent) if (/^h[1-6]$/.test(this.tags.get(p) ?? "")) return p;
    return undefined;
  }

  ancestorTag(u: UNode, tag: string) {
    for (let p = u.parent; p; p = p.parent) if (this.tags.get(p) === tag) return p;
    return undefined;
  }

  order(u: UNode): number {
    let k = 0,
      found = -1;
    eachNode(this.model.root, (x) => {
      if (x === u) found = k;
      k++;
    });
    return found;
  }

  /** the biggest text near the top of the page (the hero title) when the page has no h1 */
  firstBigText(): UNode | undefined {
    let best: { u: UNode; size: number } | undefined;
    const vi = this.vs.length - 1;
    const vh = this.vs[vi]!.snap.viewport.height;
    eachNode(this.model.root, (u) => {
      const n = u.at[vi];
      if (!isEl(n) || INTERACTIVE.has(n.tag)) return;
      const t = (n.children ?? []).find(isTextNode) as SnapText | undefined;
      if (!t || n.rect.y > vh * 1.2 || t.text.trim().length < 6) return;
      if (!best || t.font.size > best.size + 2) best = { u, size: t.font.size };
    });
    return best && best.size >= 24 ? best.u : undefined;
  }

  textOf(u: UNode): string {
    let s = "";
    eachNode(u, (x) => {
      if (x.text) {
        const t = (x.at.find(Boolean) ?? this.stateNodes.get(x)) as SnapText | undefined;
        s += ` ${t?.text ?? ""}`;
      }
    });
    return s.replace(/\s+/g, " ").trim();
  }

  hasName(u: UNode): boolean {
    const n = this.el(u);
    if (n?.attrs?.["aria-label"] || n?.aria?.["labelledby-text"] || n?.attrs?.title) return true;
    if (n?.kind === "input" && n.input?.value?.trim()) return true;
    if (this.textOf(u)) return true;
    if (this.srOnly.get(u.key)?.length) return true;
    let named = false;
    eachNode(u, (x) => {
      const e = x.at.find(isEl) as SnapElement | undefined;
      if (e?.kind === "img" && e.alt) named = true;
      if (e?.svg && /<title>/.test(e.svg)) named = true;
      if (this.srOnly.get(x.key)?.length) named = true;
    });
    return named;
  }

  /** a label the recreation adds, in the page's language */
  t(k: keyof typeof LABELS.en, n?: number | string): string {
    const lang = (this.snap0().lang ?? "en").slice(0, 2).toLowerCase();
    const s = (LABELS[lang as keyof typeof LABELS] ?? LABELS.en)[k];
    return n === undefined ? s : s.replace("{}", String(n));
  }

  deriveLabel(u: UNode, n: SnapElement): string {
    const r = this.roles.get(u);
    if (r?.arrow) return this.t(r.arrow.dir > 0 ? "next" : "previous");
    if (r?.dot) return this.t("slide", r.dot.index + 1);
    if (r?.videoToggle) return this.t("pauseVideo");
    if (r?.marqueeToggle) return this.t("pauseAnimation");
    if (r?.menuTrigger === "menu") return this.t("openMenu");
    // a toggle beside a menu entry (a submenu's opener, by trigger or by look): named after the entry
    const words0 = `${n.attrs?.class ?? ""} ${n.aria?.["aria-haspopup"] ?? ""}`;
    if (r?.menuTrigger || /menu|sub|toggle|expand|has-children|dropdown/i.test(words0)) {
      const sib = u.parent?.children.find((c) => c !== u && !c.text && this.textOf(c));
      if (sib) return this.t("submenu", this.textOf(sib).slice(0, 60));
      if (r?.menuTrigger) return this.t("openSubmenu");
    }
    if (r?.menuClose) return this.t("closeMenu");
    if (r?.menuBack) return this.t("back");
    const href = n.attrs?.href ?? "";
    for (const [re, name] of SOCIAL) if (re.test(href)) return name;
    const words = `${n.attrs?.class ?? ""} ${n.attrs?.id ?? ""} ${n.attrs?.["data-testid"] ?? ""}`;
    for (const [re, name] of CONTROL_WORDS) if (re.test(words)) return name;
    if (href) {
      try {
        const url = new URL(href);
        const last = url.pathname.split("/").filter(Boolean).pop();
        if (last)
          return last
            .replace(/[-_]+/g, " ")
            .replace(/\.\w+$/, "")
            .replace(/^\w/, (c) => c.toUpperCase());
        return url.hostname.replace(/^www\./, "");
      } catch {
        /* not a URL */
      }
    }
    return n.tag === "a" ? "Link" : "Button";
  }

  // ---------------------------------------------------------------------------------------------- context

  context(): InferContext {
    return {
      tagOf: (u) => this.tags.get(u) ?? u.tag,
      asset: (url, n) => this.assetFor(url, n) ?? url,
      color: (c) => this.color(c),
      slider: (u, role) => this.roles.get(u)?.slider?.role === role,
      hovered: (u) => this.hovered.has(u),
    };
  }

  color(c: string): string {
    const k = normColor(c);
    this.colors.set(k, (this.colors.get(k) ?? 0) + 1);
    return k;
  }

  /** a captured image (data URL in a snapshot's assets, or a data URL itself) as a file in assets/ */
  assetFor(url: string | null | undefined, _n?: SnapElement): string | null {
    if (!url || this.input.images === false) return null;
    let data: string | undefined = url.startsWith("data:") ? url : undefined;
    if (!data) for (const v of [...this.vs].reverse()) if ((data = v.snap.assets?.[url])) break;
    if (!data) return null;
    const hit = this.assetFiles.get(data);
    if (hit) return hit;
    const d = decodeDataUrl(data);
    if (!d) return null;
    const ext = EXT[d.mime] ?? "bin";
    const hash = createHash("sha256").update(d.body).digest("hex").slice(0, 10);
    const name = `assets/${slug(nameFromUrl(url)) || "image"}-${hash}.${ext}`;
    this.files[name] = d.body;
    this.assetFiles.set(data, name);
    return name;
  }

  // ---------------------------------------------------------------------------------------------- css details

  /** list items: their marker as list-style (the walk drew it as a box) */
  listStyle(u: UNode, vi: number, d: Decls) {
    const n = u.at[vi];
    if (!isEl(n) || n.tag !== "li") return;
    const marker = (n.children ?? []).find(
      (c) => c.kind === "marker" || (c.kind === "text" && (c as SnapText).marker),
    );
    if (!marker) {
      if (d.get("display") === undefined && n.layout?.display === "list-item") d.set("list-style", "none");
      return;
    }
    d.set(
      "list-style",
      marker.kind === "marker" ? `${(marker as SnapElement).shape ?? "disc"} outside` : "decimal outside",
    );
  }

  marqueeDecls(u: UNode, vi: number, d: Decls) {
    const m = this.roles.get(u)?.marquee;
    if (!m) return;
    const place = ["position", "left", "right", "top", "bottom", "inset", "transform", "translate", "margin"];
    if (m.role === "frame") {
      d.set("overflow", "hidden");
      if (d.get("position") === "absolute") return;
      d.set("position", "relative");
    } else if (m.role === "track") {
      for (const k of [...place, "width", "height"]) d.delete(k);
      d.set("display", "flex");
      d.set("width", "max-content");
      const n = u.at[vi];
      // one copy per 50 px a second: the speed of a logo band
      const w = isEl(n) ? Math.max(...(n.children ?? []).filter(isEl).map((c) => c.rect.w), 400) : 2000;
      d.set("animation", `cdr-marquee ${Math.round(w / 50)}s linear infinite`);
      d.set("--marquee-shift", `${-100 / (m.copies ?? 2)}%`);
    } else {
      for (const k of place) d.delete(k);
      d.set("flex", "none");
    }
  }

  /**
   * A link alone on its line (an inline-block / inline-flex "More about us" under a paragraph) is laid out as a block
   * as wide as its content: it looks the same, and is no longer read as a link inside running text (WCAG 1.4.1)
   */
  standaloneLink(u: UNode, vi: number, d: Decls) {
    const n = u.at[vi];
    if (!isEl(n) || n.tag !== "a" || !u.parent) return;
    const disp = n.layout?.display ?? "inline";
    if (disp !== "inline-flex" && disp !== "inline-block") return;
    const p = u.parent.at[vi];
    if (!isEl(p) || /flex|grid/.test(p.layout?.display ?? "")) return;
    if ((p.children ?? []).some((c) => c.kind === "text" && (c as SnapText).text.trim())) return;
    const sibs = (p.children ?? []).filter((c) => c !== n && c.kind !== "text") as SnapElement[];
    if (sibs.some((c) => /^inline/.test(c.layout?.display ?? "inline") && !c.pseudo)) return;
    const t =
      (n.children ?? []).find(isTextNode) ??
      (n.children ?? []).flatMap((c) => (c as SnapElement).children ?? []).find(isTextNode);
    if (t && !/^(start|left)$/.test((t as SnapText).font.align)) return;
    d.set("display", disp === "inline-flex" ? "flex" : "block");
    d.set("width", "fit-content");
  }

  /**
   * A box holding inline-level boxes (a centred button under a heading) aligns them by its text-align, which the
   * capture records only on texts: taken from the first inline child that inherits it (not a button or field, whose
   * own alignment is the browser's)
   */
  inlineAlign(u: UNode, vi: number, d: Decls) {
    if (d.has("text-align")) return;
    const n = u.at[vi];
    if (!isEl(n) || /flex|grid/.test(n.layout?.display ?? "")) return;
    for (const c of n.children ?? []) {
      if (c.kind === "text") return;
      const e = c as SnapElement;
      if (!/^inline/.test(e.layout?.display ?? "") || /^(button|input|select|textarea)$/.test(e.tag))
        continue;
      const t =
        (e.children ?? []).find(isTextNode) ??
        (e.children ?? []).flatMap((x) => (x as SnapElement).children ?? []).find(isTextNode);
      if (!t) continue;
      const a = (t as SnapText).font.align;
      if (a && !/^(start|left)$/.test(a)) d.set("text-align", a === "-webkit-center" ? "center" : a);
      return;
    }
  }

  normalise(d: Decls) {
    const mi = d.get("margin-inline");
    if (mi) {
      d.delete("margin-inline");
      const m = (d.get("margin") ?? "0").split(" ");
      const [t, , b] =
        m.length === 1
          ? [m[0], m[0], m[0]]
          : m.length === 2
            ? [m[0], m[1], m[0]]
            : m.length === 3
              ? [m[0], m[1], m[2]]
              : [m[0], m[1], m[2]];
      d.set("margin", t === b ? `${t} ${mi}` : `${t} ${mi} ${b}`);
    }
  }

  /** text properties written only where they differ from what the element inherits (per variant) */
  inherit() {
    // the page's most common text look becomes the body's
    const count = new Map<string, { n: number; d: Decls }>();
    eachNode(this.model.root, (u) => {
      const d = this.decls.get(u)?.[0];
      if (!d?.has("font-family")) return;
      const k = ["font-family", "font-size", "line-height", "color", "font-weight"]
        .map((p) => d.get(p))
        .join("|");
      const c = count.get(k) ?? { n: 0, d };
      c.n++;
      count.set(k, c);
    });
    const top = [...count.values()].sort((a, b) => b.n - a.n)[0];
    const body = new Map<string, string>();
    if (top)
      for (const p of ["font-family", "font-size", "line-height", "color", "font-weight"])
        if (top.d.has(p)) body.set(p, top.d.get(p)!);
    // the body's own colour where the page sets one (the colour headings and links inherit)
    const rootColor = this.el(this.model.root)?.style?.color;
    if (rootColor) body.set("color", this.color(rootColor));
    this.bodyText = body;
    const DEF: Record<string, string> = {
      "font-style": "normal",
      "letter-spacing": "normal",
      "text-transform": "none",
      "text-align": "start",
      "white-space": "normal",
      "text-shadow": "none",
    };
    const walk = (u: UNode, inh: Map<string, string>[]) => {
      const ds = this.decls.get(u);
      const next = inh.map((m) => new Map(m));
      if (ds)
        ds.forEach((d, vi) => {
          if (!d) return;
          for (const p of INHERITED) {
            if (!d.has(p)) continue;
            const v = d.get(p)!;
            if ((inh[vi]!.get(p) ?? DEF[p]) === v) d.delete(p);
            else next[vi]!.set(p, v);
          }
          if (d.get("text-decoration") === "none" && this.tags.get(u) !== "a") d.delete("text-decoration");
        });
      for (const c of u.children) if (!c.text) walk(c, next);
    };
    const base = new Map(Object.entries(DEF));
    for (const [k, v] of body) base.set(k, v);
    // the body itself: no text rule of its own (the body rule above is the page's text)
    const rd = this.decls.get(this.model.root);
    rd?.forEach((d) => d && [...d.keys()].forEach((k) => INHERITED.has(k) && d.delete(k)));
    walk(
      this.model.root,
      this.vs.map(() => new Map(base)),
    );
  }

  /**
   * A menu panel at rest is out of sight (moved off-screen, or not drawn): hidden, so neither the keyboard nor a
   * screen reader reaches its links; its open state shows it (`:root[data-menu] … { visibility: visible }`)
   */
  closedPanels() {
    for (const [u, r] of this.roles) {
      if (!r.menuPanel) continue;
      this.decls.get(u)?.forEach((d) => d && d.get("display") !== "none" && d.set("visibility", "hidden"));
      const scopes = new Set(this.stateWalks.filter((s) => !s.region).map((s) => s.scope));
      for (const scope of scopes)
        this.vs.forEach((_, vi) => {
          if (this.stateWalks.some((s) => s.scope === scope && s.vi === vi))
            this.stateRules.push({ scope, node: u, vi, decls: new Map([["visibility", "visible"]]) });
        });
    }
  }

  /** slider tracks whose slides the page lets show up to an outer edge (the next slide peeking): track → that box */
  readonly bleedTo = new Map<UNode, string>();
  /**
   * A row of slides the page clips at an outer box (a full-width section), not at the row itself: the next slide shows
   * past the container. The scrolling track reaches that edge (a negative right margin, the same padding inside), so
   * the slides keep their size and start while the next one peeks in as on the live page.
   */
  sliderBleed() {
    for (const [u, clipKey] of this.bleedTo) {
      this.vs.forEach((_, vi) => {
        const d = this.decls.get(u)?.[vi];
        if (!d) return;
        const pts: Sample[] = [];
        for (const w of this.model.walks[vi]!) {
          const t = w.byKey.get(u.key),
            c = w.byKey.get(clipKey);
          if (!isEl(t) || !isEl(c)) continue;
          pts.push({ x: w.vw, y: c.rect.x + c.rect.w - (t.rect.x + t.rect.w) });
        }
        const f = fitSamples(pts);
        if (!f || pts.every((p) => p.y < 1)) return;
        const v = fitCss(f, "vw");
        d.set("margin-right", `calc(-1 * ${v.startsWith("calc(") ? v.slice(4) : v})`);
        d.set("padding-right", v);
        d.set("scroll-padding-right", v);
      });
    }
  }

  /** each layout range's poster frame of a video: as its background, so a phone loads the phone's frame only */
  readonly posters = new Map<UNode, { vi: number; file: string }[]>();
  videoPosters() {
    for (const [u, r] of this.roles) {
      if (!r.video) continue;
      const list: { vi: number; file: string }[] = [];
      this.vs.forEach((_, vi) => {
        const n = u.at[vi];
        if (!isEl(n)) return;
        const f = this.assetFor(n.poster ?? n.src);
        const d = this.decls.get(u)?.[vi];
        if (!f || !d) return;
        list.push({ vi, file: f });
        d.set("background", `center / cover no-repeat url("${f}")`);
      });
      if (list.length) this.posters.set(u, list);
    }
  }

  /**
   * Flex and grid children the page shows in another order than its DOM (`order`, a reversed row): the order they are
   * seen in, per width
   */
  visualOrder() {
    eachNode(this.model.root, (u) => {
      if (u.text) return;
      this.vs.forEach((_, vi) => {
        const n = u.at[vi];
        if (!isEl(n) || !/flex|grid/.test(n.layout?.display ?? "") || /reverse/.test(n.layout?.dir ?? ""))
          return;
        const col = /column/.test(n.layout?.dir ?? "") && /flex/.test(n.layout?.display ?? "");
        const kids = u.children.filter((c) => !c.text && isEl(c.at[vi]) && !this.roles.get(c)?.pseudo);
        if (kids.length < 2 || kids.some((c) => (c.at[vi] as SnapElement).layout?.order)) return;
        const pos = (c: UNode) => {
          const r = (c.at[vi] as SnapElement).rect;
          return col ? [r.y, r.x] : [r.y, r.x];
        };
        // reading order: rows top to bottom, each left to right (a wrapped row too); boxes of one line share it even
        // when centred at different heights (a 24px link beside a 48px bar)
        const sameLine = (a: UNode, b: UNode) => {
          const ra = (a.at[vi] as SnapElement).rect,
            rb = (b.at[vi] as SnapElement).rect;
          const overlap = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
          return Math.abs(ra.y - rb.y) <= 4 || overlap >= 0.5 * Math.min(ra.h, rb.h);
        };
        const seen = [...kids].sort((a, b) => {
          const [ay, ax] = pos(a),
            [by, bx] = pos(b);
          return !col && sameLine(a, b) ? ax! - bx! : Math.abs(ay! - by!) > 4 ? ay! - by! : ax! - bx!;
        });
        if (seen.every((c, i) => c === kids[i])) return;
        // only a real swap (overlapping boxes, placed ones, say nothing)
        if (
          kids.some(
            (c) => !/^(static|relative)$/.test((c.at[vi] as SnapElement).layout?.position ?? "static"),
          )
        )
          return;
        seen.forEach((c, i) => this.decls.get(c)?.[vi]?.set("order", String(i)));
      });
    });
  }

  /** the current slider dot looked different when captured: that look goes to `[aria-current="true"]`, every dot shares the rest */
  activeLooks() {
    const LOOK = /^(background|color|border|opacity|width|height|transform|scale|box-shadow|outline)/;
    for (const [u, r] of this.roles) {
      if (!r.dots || r.dots.active === undefined) continue;
      const dots = u.children.filter((c) => this.roles.get(c)?.dot);
      const act = dots[r.dots.active],
        ref = dots.find((_, k) => k !== r.dots!.active);
      const da = act && this.decls.get(act),
        dr = ref && this.decls.get(ref);
      if (!da || !dr) continue;
      const diff: Decls = new Map();
      da.forEach((d, vi) => {
        const r0 = dr[vi];
        if (d && r0) for (const [k, v] of d) if (LOOK.test(k) && r0.get(k) !== v) diff.set(k, v);
      });
      this.decls.set(
        act!,
        dr.map((d) => (d ? new Map(d) : null)),
      );
      if (diff.size) this.activeDots.set(u, diff);
    }
  }

  /**
   * Boxes the page drew fully transparent: revealed on hover (kept transparent, the hover rule shows them), positioned
   * layers (dropdowns, tooltips: kept hidden, out of the tab order too) or content an entrance animation had not shown
   * yet when the page was captured (shown, as a visitor sees it once it has played).
   */
  transparentBoxes() {
    let shown = 0;
    eachNode(this.model.root, (u) => {
      const n = this.el(u);
      if (!n?.invisible) return;
      // revealed by a hover only when a hover rule makes this box (or its content) opaque or visible
      const reveals = new Set(
        this.hoverRules
          .filter((h) => h.decls.has("opacity") || h.decls.has("visibility"))
          .map((h) => h.sel[1]!),
      );
      let hovered = false;
      eachNode(u, (x) => {
        if (reveals.has(x.key)) hovered = true;
      });
      const ds = this.decls.get(u);
      if (!ds) return;
      if (hovered) return;
      if (!n.reveal && !/^(static|relative|sticky)$/.test(n.layout?.position ?? "static")) {
        ds.forEach((d) => d?.set("visibility", "hidden"));
        return;
      }
      ds.forEach((d) => {
        d?.delete("opacity");
        d?.delete("visibility");
      });
      shown++;
    });
    if (shown) this.report.added.push(`${shown} box(es) an entrance animation had not shown yet, shown`);
  }

  // ---------------------------------------------------------------------------------------------- hover

  hoverCss(ctx: InferContext) {
    const seen = new Set<string>();
    const all: SnapHover[] = [];
    for (const v of [...this.vs].reverse())
      for (const h of v.snap.hover ?? []) if (!seen.has(h.key)) (seen.add(h.key), all.push(h));
    // the capture hovers two controls of a kind: the others of that kind (same tag and classes, here and in their parent) look alike
    const sigOf = (u: UNode) => {
      const n = this.el(u),
        p = u.parent ? this.el(u.parent) : undefined;
      return `${u.tag}|${n?.attrs?.class ?? ""}|${u.parent?.tag ?? ""}|${p?.attrs?.class ?? ""}`;
    };
    const kinds = new Map<string, UNode[]>();
    eachNode(this.model.root, (u) => {
      if (!u.text) kinds.set(sigOf(u), [...(kinds.get(sigOf(u)) ?? []), u]);
    });
    for (const h of [...all]) {
      const ctl = this.model.byKey.get(h.key);
      if (!ctl) continue;
      for (const twin of kinds.get(sigOf(ctl)) ?? []) {
        if (twin === ctl || seen.has(twin.key)) continue;
        seen.add(twin.key);
        all.push({
          key: twin.key,
          changes: h.changes
            .filter((c) => c.key.startsWith(h.key))
            .map((c) => ({ key: twin.key + c.key.slice(h.key.length), props: c.props })),
        });
      }
    }
    // a flyout's panel opens with its region state (its own look at each width), not with a pointer delta
    const flyouts: { reg: UNode; ctls: UNode[] }[] = [];
    for (const [key, rg] of this.regions) {
      const reg = this.model.byKey.get(key);
      const ctls = [...rg.states]
        .filter(([, one]) => one.hover)
        .map(([k]) => this.model.byKey.get(k))
        .filter((x): x is UNode => !!x);
      if (reg && ctls.length) flyouts.push({ reg, ctls });
    }
    // their parts animate as on the page (the panel's own transition, its fading content)
    for (const f of flyouts) eachNode(f.reg, (x) => void (!x.text && this.hovered.add(x)));
    // and the layers they show over the page (a backdrop fading in)
    this.vs.forEach((v, vi) => {
      for (const st of v.snap.states ?? [])
        for (const o of st.hover ? (st.overlays ?? []) : []) {
          const on = this.model.walks[vi]![0]!.byId.get(o.id);
          const ou = on?.key ? this.model.byKey.get(on.key) : undefined;
          if (ou) this.hovered.add(ou);
        }
    });
    const inPanel = (t: UNode) =>
      flyouts.some((f) => t !== f.reg && this.inside(t, f.reg) && !f.ctls.some((c) => this.inside(t, c)));
    for (const h of all) {
      const ctl = this.model.byKey.get(h.key);
      if (!ctl) continue;
      for (const c of h.changes) {
        const pseudo = /::(before|after)$/.exec(c.key);
        const target =
          this.model.byKey.get(c.key) ??
          (pseudo ? this.model.byKey.get(c.key.slice(0, -pseudo[0].length)) : undefined);
        if (!target || (inPanel(target) && !inPanel(ctl))) continue;
        const n = this.el(target);
        const d: Decls = new Map();
        const p = c.props;
        const has = (side: number) => !!n?.style?.border?.[side];
        if (p.color) d.set("color", ctx.color(p.color));
        if (p["background-color"]) d.set("background-color", ctx.color(p["background-color"]));
        if (p["background-image"] && p["background-image"] !== "none")
          d.set("background-image", p["background-image"]);
        ["top", "right", "bottom", "left"].forEach((s, k) => {
          const v = p[`border-${s}-color`];
          if (v && has(k)) d.set(`border-${s}-color`, ctx.color(v));
        });
        if (p["box-shadow"]) d.set("box-shadow", p["box-shadow"]);
        if (p.opacity) d.set("opacity", p.opacity);
        if (p.transform) {
          const t = transformCss(p.transform, n);
          d.set(t?.[0] ?? "transform", t?.[1] ?? "none");
        }
        for (const k of [
          "translate",
          "scale",
          "rotate",
          "filter",
          "visibility",
          "clip-path",
          "fill",
          "stroke",
        ])
          if (p[k]) d.set(k, p[k]!);
        if (p["text-decoration-line"]) d.set("text-decoration-line", p["text-decoration-line"]);
        if (
          p["text-decoration-color"] &&
          (p["text-decoration-line"] ?? n?.children?.find(isTextNode)?.font.decoration?.line ?? "none") !==
            "none"
        )
          d.set("text-decoration-color", ctx.color(p["text-decoration-color"]));
        if (p["text-underline-offset"]) d.set("text-underline-offset", p["text-underline-offset"]);
        if (p["outline-style"] && p["outline-style"] !== "none")
          d.set(
            "outline",
            `${p["outline-width"] ?? "2px"} ${p["outline-style"]} ${ctx.color(p["outline-color"] ?? "currentColor")}`,
          );
        for (const k of ["width", "height", "padding-left", "padding-right", "gap"])
          if (p[k] && /px$/.test(p[k]!)) d.set(k, p[k]!);
        if (!d.size) continue;
        this.hovered.add(target);
        this.hoverRules.push({ sel: [h.key, c.key], decls: d });
      }
    }
    this.report.hoverRules = this.hoverRules.length;
  }

  // ---------------------------------------------------------------------------------------------- states

  stateCss(ctx: InferContext) {
    const REGION_KEEP =
      /^(display|visibility|opacity|background-color|background-image|color|fill|stroke|border|border-color|box-shadow|text-decoration|height|max-height)$/;
    const HOVER_KEEP =
      /^(display|visibility|opacity|background-color|background-image|color|fill|stroke|border|border-color|box-shadow|text-decoration|height|max-height|transform|translate|scale|rotate)$/;
    const KEEP =
      /^(display|visibility|opacity|transform|translate|scale|position|top|left|right|bottom|inset|background-color|color|z-index|overflow|height|max-height|min-height|width|max-width|pointer-events|box-shadow|border|padding|margin|flex|gap)$/;
    for (const s of this.stateWalks) {
      const stateModel: Unified = {
        ...this.model,
        walks: this.model.walks.map((w, vi) => (vi === s.vi ? [s.walk] : w)),
      };
      // only what the state is about: its panel, its controls (a toggle that turns into a close button) and what it adds;
      // the rest of the page was walked again too, and differs only by what moved in the meantime (an autoplay slide)
      const st = s.state;
      const keys = (s.region ? [] : [st.panel, st.close, st.back, st.item])
        .map((id) => (id !== undefined ? s.walk.byId.get(id)?.key : undefined))
        .filter((k): k is string => !!k);
      const trig = s.region ? undefined : this.nodeOfId(s.vi, st.trigger);
      if (trig) keys.push(trig.key);
      // a widget's state: everything in its region
      if (s.region) keys.push(s.region);
      const scoped = (key: string) =>
        keys.some(
          (k) => key === k || key.startsWith(`${k}/`) || key.startsWith(`${k}>`) || key.startsWith(`${k}::`),
        );
      for (const n of s.walk.byKey.values()) {
        if (!n.key || n.kind === "text") continue;
        const u = this.model.byKey.get(n.key);
        if (!u) continue;
        if (!scoped(n.key) && !(u as UNode & { stateOnly?: boolean }).stateOnly) continue;
        // a widget's moving parts (a marquee, a slider) are no part of its state
        if (s.region) {
          let moving = false;
          for (let p: UNode | undefined = u; p; p = p.parent)
            if (this.roles.get(p)?.marquee || this.roles.get(p)?.slider) moving = true;
          if (moving) continue;
        }
        const d = elementDecls(u, s.vi, stateModel, ctx);
        const t = textDecls(u, s.vi, stateModel, ctx);
        if (t) for (const [k, v] of t) d.set(k, v);
        this.normalise(d);
        const base = isEl(u.at[s.vi]) ? this.baseDeclsAt(u, s.vi, ctx) : null;
        const diff: Decls = new Map();
        if (!base) {
          // shown only in this state
          for (const [k, v] of d) diff.set(k, v);
          if (!diff.has("display")) diff.set("display", defaultDisplay(this.tags.get(u) ?? u.tag));
        } else {
          // a widget's state changes what shows and how it looks, not where its boxes sit
          // a flyout's look also turns its parts (the chevron flips)
          const keep = s.region ? (s.state.hover ? HOVER_KEEP : REGION_KEEP) : KEEP;
          for (const [k, v] of d) if (keep.test(k) && base.get(k) !== v) diff.set(k, v);
          // a box the state moves into view: no transform left
          // a box collapsed at rest (a closed panel 0-1px tall) takes its content's height
          const collapsed = /^[01](\.\d+)?px$/.test(base.get("height") ?? base.get("max-height") ?? "");
          for (const k of ["transform", "translate", "visibility", "opacity", "height", "max-height"])
            if (base.has(k) && !d.has(k) && (collapsed || !/height/.test(k)))
              diff.set(
                k,
                k === "visibility" ? "visible" : k === "opacity" ? "1" : k === "height" ? "auto" : "none",
              );
          // hidden at rest by the recreation (a closed panel, a box the page had made transparent), shown here
          if (this.decls.get(u)?.[s.vi]?.get("visibility") === "hidden" && d.get("visibility") !== "hidden")
            diff.set("visibility", "visible");
        }
        if (diff.size)
          this.stateRules.push({ scope: s.scope, node: u, vi: s.vi, decls: diff, self: u.key === s.region });
      }
      // a layer over the page the open flyout shows (a backdrop dimming the page)
      for (const o of st.hover ? (st.overlays ?? []) : []) {
        const on = this.model.walks[s.vi]![0]!.byId.get(o.id);
        const ou = on?.key ? this.model.byKey.get(on.key) : undefined;
        if (!ou) continue;
        const look: Decls = new Map([
          ["opacity", String(Math.round(o.opacity * 100) / 100)],
          ["visibility", "visible"],
        ]);
        this.stateRules.push({ scope: `:root:has(${s.scope})`, node: ou, vi: s.vi, decls: look });
      }
      // what the widget hides in this state (the other tab's panel): shown at rest, not in the walk of the state
      if (s.region && s.walk.byKey.size) {
        const reg = this.model.byKey.get(s.region);
        if (reg)
          eachNode(reg, (u) => {
            if (u === reg || u.text || !isEl(u.at[s.vi]) || s.walk.byKey.has(u.key)) return;
            // only the outermost box that disappears
            if (u.parent && u.parent !== reg && isEl(u.parent.at[s.vi]) && !s.walk.byKey.has(u.parent.key))
              return;
            let moving = false;
            for (let p: UNode | undefined = u; p; p = p.parent)
              if (this.roles.get(p)?.marquee || this.roles.get(p)?.slider) moving = true;
            if (!moving)
              this.stateRules.push({
                scope: s.scope,
                node: u,
                vi: s.vi,
                decls: new Map([["display", "none"]]),
              });
          });
      }
    }
  }

  baseDeclsAt(u: UNode, vi: number, ctx: InferContext): Decls {
    const d = elementDecls(u, vi, this.model, ctx);
    const t = textDecls(u, vi, this.model, ctx);
    if (t) for (const [k, v] of t) d.set(k, v);
    this.normalise(d);
    return d;
  }

  // ---------------------------------------------------------------------------------------------- sections

  findSections() {
    const root = this.model.root;
    const out: UNode[] = [];
    const vi = this.vs.length - 1;
    const vh = this.vs[vi]!.snap.viewport.height;
    const visible = (u: UNode) => !u.text && !this.roles.get(u)?.pseudo && !this.roles.get(u)?.skip;
    const height = (u: UNode) => {
      const n = u.at[vi] ?? u.at.find(Boolean);
      return isEl(n) ? n.rect.h : 0;
    };
    // a wrapper of sections (main, a content container): its children are the sections
    const visit = (u: UNode, depth: number) => {
      const kids = u.children.filter(visible);
      const t = this.tags.get(u);
      if (depth > 0 && /^(header|footer|nav|aside)$/.test(t ?? "")) return void out.push(u);
      const sectionKids = kids.filter((k) => this.tags.get(k) === "section").length;
      const isSection = /^(section|article)$/.test(t ?? "") && depth > 0;
      const wrapper =
        (isSection ? sectionKids >= 2 : false) ||
        (!isSection && depth === 0) ||
        (!isSection && t === "main") ||
        (!isSection && kids.length === 1) ||
        sectionKids >= 2 ||
        (!isSection &&
          kids.length >= 2 &&
          height(u) > vh * 2 &&
          depth < 8 &&
          kids.filter((k) => height(k) > 40).length >= 2);
      if (wrapper && kids.length) for (const c of kids) visit(c, depth + 1);
      else if (height(u) > 0 || this.stateNodes.has(u) || (u as UNode & { stateOnly?: boolean }).stateOnly)
        out.push(u);
    };
    visit(root, 0);
    this.sections = out.length ? out : [root];
  }

  sectionLabel(u: UNode, k: number): string {
    const t = this.tags.get(u);
    if (t === "header" && k === 0) return "header";
    if (t === "footer") return "footer";
    let heading = "";
    eachNode(u, (x) => {
      if (!heading && /^h[1-6]$/.test(this.tags.get(x) ?? "")) heading = this.textOf(x);
    });
    if (this.isHero(u)) return "hero";
    const words = (heading ? slug(heading) : cleanClass(this.el(u)?.attrs?.class ?? ""))
      .split("-")
      .filter(Boolean)
      .slice(0, 3)
      .join("-");
    return words || `section-${k + 1}`;
  }

  /** the first content section: it holds the page's h1 or its video and starts in the first screen */
  isHero(u: UNode): boolean {
    const first = this.sections.find((s) => {
      let h = false;
      eachNode(s, (x) => {
        if (this.tags.get(x) === "h1" || this.roles.get(x)?.video) h = true;
      });
      return h;
    });
    if (first !== u) return false;
    const vi = this.vs.length - 1;
    const n = u.at[vi];
    return !isEl(n) || n.rect.y < this.vs[vi]!.snap.viewport.height;
  }

  containsVideo(u: UNode) {
    let v = false;
    eachNode(u, (x) => {
      if (this.roles.get(x)?.video) v = true;
    });
    return v;
  }

  /** the largest image in the first screen: loaded first, never lazily */
  findLcp() {
    const vi = this.vs.length - 1;
    const vh = this.vs[vi]!.snap.viewport.height;
    let best: { u: UNode; a: number } | undefined;
    eachNode(this.model.root, (u) => {
      const n = u.at[vi];
      if (!isEl(n) || !(n.kind === "img" || n.kind === "raster")) return;
      if (n.rect.y > vh) return;
      const a = n.rect.w * n.rect.h;
      if (!best || a > best.a) best = { u, a };
    });
    this.lcp = best?.u;
  }

  // ---------------------------------------------------------------------------------------------- css

  globalStateCss = "";
  readonly sectionIds = new Map<UNode, string>();

  css(): Map<UNode, string> {
    // per node: the rules over its variants (mobile first)
    const rulesOf = new Map<UNode, { min: number; d: Decls }[]>();
    eachNode(this.model.root, (u) => {
      if (u.text) return;
      const ds = this.decls.get(u) ?? this.vs.map(() => null);
      const stateOnly = (u as UNode & { stateOnly?: boolean }).stateOnly;
      const tag = this.tags.get(u) ?? u.tag;
      const rules: { min: number; d: Decls }[] = [];
      let eff = new Map<string, string>();
      // absent where its parent is absent too: hidden with the parent, no rule of its own
      const parentShown = (vi: number) => !u.parent || u.parent === this.model.root || isEl(u.parent.at[vi]);
      const hiddenSomewhere = ds.some((d, vi) => !d && parentShown(vi));
      ds.forEach((d0, vi) => {
        if (!d0 && !parentShown(vi)) return;
        let want: Map<string, string>;
        if (!d0) {
          want = new Map(eff);
          want.set("display", "none");
        } else {
          want = new Map(d0);
          if (hiddenSomewhere && !want.has("display")) want.set("display", defaultDisplay(tag));
        }
        if (stateOnly) want.set("display", "none");
        const diff: Decls = new Map();
        for (const [k, v] of want) if (eff.get(k) !== v) diff.set(k, v);
        for (const k of eff.keys()) if (!want.has(k)) diff.set(k, resetOf(k, tag));
        if (vi === 0)
          for (const [k, v] of [...diff]) if (v === resetOf(k, tag) && !eff.has(k)) diff.delete(k);
        if (diff.size) rules.push({ min: this.vs[vi]!.minWidth, d: diff });
        eff = want;
      });
      rulesOf.set(u, rules);
      if (process.env.CDR_MODERN_DEBUG && u.key.includes(process.env.CDR_MODERN_DEBUG))
        console.error(
          "[modern]",
          u.key,
          JSON.stringify(ds.map((d) => (d ? Object.fromEntries(d) : null))),
          JSON.stringify(rules.map((r) => [r.min, Object.fromEntries(r.d)])),
        );
    });
    // classes: one per distinct look, named after what the page called the box
    const sig = (u: UNode) => {
      const r = rulesOf.get(u) ?? [];
      return r.map((x) => `${x.min}{${[...x.d].map(([k, v]) => `${k}:${v}`).join(";")}}`).join("");
    };
    const needsClass = (u: UNode) => {
      const r = this.roles.get(u);
      return (
        (rulesOf.get(u)?.length ?? 0) > 0 ||
        this.hoverRules.some((h) => h.sel.includes(u.key) || h.sel.some((s) => s.startsWith(`${u.key}::`))) ||
        this.stateRules.some((s) => s.node === u) ||
        u.children.some((c) => this.roles.get(c)?.pseudo) ||
        !!r?.slider ||
        !!r?.marquee ||
        !!this.el(u)?.cursorActive ||
        !!r?.dots
      );
    };
    const bySig = new Map<string, UNode[]>();
    eachNode(this.model.root, (u) => {
      if (u.text || u === this.model.root || this.roles.get(u)?.pseudo || !needsClass(u)) return;
      // nodes the hover / state rules name keep a class of their own when their look is shared but their role is not
      const own =
        this.hoverRules.some((h) => h.sel[0] === u.key) || this.stateRules.some((s) => s.node === u)
          ? `#${this.nameOf(u)}`
          : "";
      const k = sig(u) + own;
      bySig.set(k, [...(bySig.get(k) ?? []), u]);
    });
    const used = new Set<string>(["skip-link", "visually-hidden", "video-toggle"]);
    const section = new Map<UNode, string>();
    this.sections.forEach((s, k) => eachNode(s, (x) => section.set(x, this.sectionLabel(s, k))));
    for (const [, us] of bySig) {
      const counts = new Map<string, number>();
      for (const u of us) counts.set(this.nameOf(u), (counts.get(this.nameOf(u)) ?? 0) + 1);
      const base = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
      // one name per look: the page's name, else prefixed by the section it is in, else numbered
      const sec = section.get(us[0]!);
      const candidates = [base, ...(sec && !base.startsWith(sec) ? [`${sec}-${base}`] : [])];
      let name = candidates.find((c) => !used.has(c));
      for (let k = 2; !name; k++) if (!used.has(`${base}-${k}`)) name = `${base}-${k}`;
      used.add(name);
      for (const u of us) this.classOf.set(u, name);
    }
    // css per section
    const bySection = new Map<UNode, string>();
    const sectionOf = new Map<UNode, UNode>();
    for (const s of this.sections) eachNode(s, (x) => sectionOf.set(x, s));
    const emitted = new Set<string>();
    const blocks = new Map<UNode | null, { base: string[]; media: Map<number, string[]> }>();
    const blockOf = (u: UNode) => {
      const s = sectionOf.get(u) ?? null;
      let b = blocks.get(s);
      if (!b) blocks.set(s, (b = { base: [], media: new Map() }));
      return b;
    };
    eachNode(this.model.root, (u) => {
      if (u.text) return;
      const pseudo = this.roles.get(u)?.pseudo;
      let sel: string;
      if (pseudo) {
        const pc = u.parent ? this.classOf.get(u.parent) : undefined;
        if (!pc) return;
        sel = `.${pc}::${pseudo}`;
      } else if (u === this.model.root) sel = "body";
      else {
        const c = this.classOf.get(u);
        if (!c) return;
        sel = `.${c}`;
      }
      if (emitted.has(sel)) return;
      emitted.add(sel);
      const b = blockOf(u);
      for (const r of rulesOf.get(u) ?? []) {
        const d = new Map(r.d);
        if (pseudo && r === rulesOf.get(u)![0]) d.set("content", this.pseudoContent(u));
        const body = `${sel} { ${[...d].map(([k, v]) => `${k}: ${v};`).join(" ")} }`;
        if (!r.min) b.base.push(body);
        else b.media.set(r.min, [...(b.media.get(r.min) ?? []), body]);
      }
    });
    // hover / focus looks
    const hoverBlock: string[] = [];
    for (const h of this.hoverRules) {
      const ctl = this.model.byKey.get(h.sel[0]!)!;
      const cc = this.classOf.get(ctl);
      const pseudo = /::(before|after)$/.exec(h.sel[1]!);
      const tu = this.model.byKey.get(pseudo ? h.sel[1]!.slice(0, -pseudo[0].length) : h.sel[1]!);
      const tc = tu ? this.classOf.get(tu) : undefined;
      if (!cc || !tc) continue;
      const inner = tu === ctl ? "" : ` .${tc}`;
      const ps = pseudo ? `::${pseudo[1]}` : "";
      const body = [...h.decls].map(([k, v]) => `${k}: ${v};`).join(" ");
      hoverBlock.push(`.${cc}:hover${inner}${ps}, .${cc}:focus-visible${inner}${ps} { ${body} }`);
    }
    // state looks (open menu)
    const stateBlock: string[] = [];
    // one rule per look: the ranges a state looks the same in are merged (consecutive ranges into one media query)
    const groups = new Map<string, { body: string; vis: Set<number> }>();
    for (const s of this.stateRules) {
      const c = this.classOf.get(s.node);
      if (!c) continue;
      const sel = s.self ? `.${c}${s.scope}` : `${s.scope} .${c}`;
      const body = `${sel} { ${[...s.decls].map(([k, v]) => `${k}: ${v};`).join(" ")} }`;
      const g = groups.get(body) ?? { body, vis: new Set<number>() };
      g.vis.add(s.vi);
      groups.set(body, g);
    }
    for (const g of groups.values()) {
      const vis = [...g.vis].sort((a, b) => a - b);
      // consecutive runs of ranges
      const runs: [number, number][] = [];
      for (const vi of vis) {
        const last = runs[runs.length - 1];
        if (last && last[1] === vi - 1) last[1] = vi;
        else runs.push([vi, vi]);
      }
      for (const [a, b] of runs) {
        const lo = this.vs[a]!.minWidth,
          hi = this.vs[b + 1]?.minWidth;
        const q = [lo ? `(min-width: ${lo}px)` : "", hi ? `(max-width: ${hi - 0.02}px)` : ""]
          .filter(Boolean)
          .join(" and ");
        stateBlock.push(q ? `@media ${q} { ${g.body} }` : g.body);
      }
    }
    // the cursor a box shows while pressed (and while its slider is dragged)
    eachNode(this.model.root, (u) => {
      const n = this.el(u);
      const c = this.classOf.get(u);
      if (!n?.cursorActive || !c) return;
      const cur = cursorCss(n.cursorActive, (url) => this.assetFor(url) ?? url);
      stateBlock.push(`.${c}:active, [data-dragging] .${c} { cursor: ${cur}; }`);
    });
    for (const [u, d] of this.activeDots) {
      const c = this.classOf.get(u);
      if (c)
        stateBlock.push(
          `.${c} > [aria-current="true"] { ${[...d].map(([k, v]) => `${k}: ${v};`).join(" ")} }`,
        );
    }
    this.globalStateCss =
      [...new Set(hoverBlock)].join("\n") + "\n" + [...new Set(stateBlock)].join("\n") + "\n";
    for (const [s, b] of blocks) {
      const media = [...b.media]
        .sort((x, y) => x[0] - y[0])
        .map(([min, rs]) => `@media (min-width: ${min}px) {\n  ${rs.join("\n  ")}\n}`);
      const text = [...b.base, ...media].join("\n");
      if (s) bySection.set(s, text);
      else bySection.set(this.model.root, text);
    }
    return bySection;
  }

  pseudoContent(u: UNode): string {
    const n = this.el(u);
    const t = n?.children?.find(isTextNode) as SnapText | undefined;
    if (n?.kind === "img" && n.src) {
      const f = this.assetFor(n.src);
      return f ? `url("${f}")` : '""';
    }
    return t ? JSON.stringify(t.text) : '""';
  }

  private tokenCounts?: Map<string, number>;
  /** how often each class word is used on the page (the rarest of a box's words says most about it) */
  tokens(): Map<string, number> {
    if (this.tokenCounts) return this.tokenCounts;
    const m = new Map<string, number>();
    eachNode(this.model.root, (u) => {
      for (const t of classWords(this.el(u)?.attrs?.class ?? "")) m.set(t, (m.get(t) ?? 0) + 1);
    });
    return (this.tokenCounts = m);
  }

  nameOf(u: UNode): string {
    const n = this.el(u);
    const words = classWords(n?.attrs?.class ?? "");
    const counts = this.tokens();
    const fromClass = words.length
      ? [...words].sort(
          (a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || words.indexOf(a) - words.indexOf(b),
        )[0]!
      : "";
    if (fromClass) return fromClass;
    const r = this.roles.get(u);
    if (r?.slider)
      return r.slider.role === "slide" ? "slide" : r.slider.role === "track" ? "slider-track" : "slider";
    if (r?.marquee)
      return r.marquee.role === "track"
        ? "marquee-track"
        : r.marquee.role === "copy"
          ? "marquee-copy"
          : "marquee";
    const tag = this.tags.get(u) ?? u.tag;
    return TAG_NAMES[tag] ?? tag;
  }

  // ---------------------------------------------------------------------------------------------- html

  document(css: Map<UNode, string>): ModernDoc {
    const snap = this.snap0();
    const doc = snap.doc ?? {};
    const title = snap.title || this.input.page || "Page";
    const firstPara = (() => {
      let t = "";
      eachNode(this.model.root, (u) => {
        if (!t && this.tags.get(u) === "p") {
          const s = this.textOf(u);
          if (s.length > 60) t = s;
        }
      });
      return t;
    })();
    const description = (doc.description || doc.ogDescription || firstPara || title).slice(0, 300);
    const fonts = this.fontFaces();
    const head = [
      `<meta charset="utf-8">`,
      `<meta name="viewport" content="width=device-width, initial-scale=1">`,
      `<title>${esc(title)}</title>`,
      this.favicon(),
      `<meta name="description" content="${attr(description)}">`,
      ...(doc.themeColor ? [`<meta name="theme-color" content="${attr(doc.themeColor)}">`] : []),
      ...fonts.preload.map(
        (f) => `<link rel="preload" href="${f}" as="font" type="font/${f.split(".").pop()}" crossorigin>`,
      ),
      "<!--lcp-preload-->",
      `<link rel="stylesheet" href="styles.css">`,
      `<script src="app.js" defer></script>`,
    ];
    const lang = snap.lang || "en";
    const baseCss = this.baseCss(fonts.css);
    const ids = new Set<string>();
    const sections = this.sections.map((s, k) => {
      let label = this.sectionLabel(s, k);
      for (let i = 2; ids.has(label); i++) label = `${this.sectionLabel(s, k)}-${i}`;
      ids.add(label);
      this.sectionIds.set(s, label);
      return {
        id: label,
        label,
        tag: this.tags.get(s) ?? "div",
        html: this.markup(s, 0),
        css: css.get(s) ?? "",
        interactive: this.interactive(s),
      };
    });
    // the first screen's largest picture is known once the markup is written: loaded first
    const lcp = head.indexOf("<!--lcp-preload-->");
    if (this.lcpLinks.length) head.splice(lcp, 1, ...this.lcpLinks);
    else if (this.lcpHref)
      head[lcp] = `<link rel="preload" as="image" href="${attr(this.lcpHref)}" fetchpriority="high">`;
    else head.splice(lcp, 1);
    const rootCss = css.get(this.model.root) ?? "";
    if (rootCss)
      sections.unshift({ id: "page", label: "page", tag: "", html: "", css: rootCss, interactive: false });
    const skipText = doc.skipLink?.text || this.t("skip");
    const prelude = `<a class="skip-link" href="#main">${esc(skipText)}</a>`;
    return {
      lang,
      title,
      description,
      head,
      baseCss,
      sections,
      prelude,
      skeleton: "",
      runtime: MODERN_RUNTIME_JS,
    };
  }

  /** the live page's icon when the capture has it, else an empty one (no request that fails) */
  favicon(): string {
    const icon = this.snap0().doc?.icon;
    const f = icon ? this.assetFor(icon) : null;
    return f ? `<link rel="icon" href="${attr(f)}">` : `<link rel="icon" href="data:,">`;
  }

  interactive(u: UNode): boolean {
    let i = false;
    eachNode(u, (x) => {
      const r = this.roles.get(x);
      if (r && (r.slider || r.video || r.menuTrigger || r.arrow || r.dot || r.menuPanel)) i = true;
    });
    return i;
  }

  lcpHref?: string;
  lcpLinks: string[] = [];

  /** the page's skeleton: its sections inside the live page's own wrappers */
  html(doc: ModernDoc): string {
    const inSection = new Set(this.sections);
    const hasMain = (() => {
      let m = false;
      eachNode(this.model.root, (u) => {
        if (this.tags.get(u) === "main") m = true;
      });
      return m;
    })();
    if (!hasMain) this.report.added.push("main landmark");
    const sectionHtml = new Map(
      this.sections.map((u) => [u, doc.sections.find((s) => s.id === this.sectionIds.get(u))!] as const),
    );
    const render = (u: UNode, depth: number): string => {
      if (inSection.has(u)) {
        const s = sectionHtml.get(u);
        return s ? `\n<!-- section:${s.id} -->\n${s.html}\n<!-- /section -->` : "";
      }
      return this.markup(u, depth, render);
    };
    let body = this.model.root.children.map((c) => (c.text ? this.textHtml(c) : render(c, 1))).join("");
    if (!hasMain) {
      // header and footer stay outside main
      const parts = body.split(/(?=\n<!-- section:)/);
      const first = parts.findIndex((p) => !/<!-- section:header -->/.test(p));
      const last =
        parts.length - 1 - [...parts].reverse().findIndex((p) => !/<!-- section:footer -->/.test(p));
      body = [
        ...parts.slice(0, first),
        `\n<main id="main">`,
        ...parts.slice(first, last + 1),
        `\n</main>`,
        ...parts.slice(last + 1),
      ].join("");
    }
    const bc = this.classOf.get(this.model.root);
    doc.skeleton = body.replace(
      /\n<!-- section:([^ ]+) -->\n[\s\S]*?\n<!-- \/section -->/g,
      (_m, id: string) => `\n<!--section:${id}-->`,
    );
    if (bc) doc.bodyClass = bc;
    return `<!doctype html>\n<html lang="${attr(doc.lang)}">\n<head>\n  ${doc.head.join("\n  ")}\n</head>\n<body${bc ? ` class="${bc}"` : ""}>\n${doc.prelude}${body}\n</body>\n</html>\n`;
  }

  textHtml(u: UNode): string {
    const t = (u.at.find(Boolean) ?? this.stateNodes.get(u)) as SnapText | undefined;
    if (!t) return "";
    const pre = /pre/.test(t.font.whiteSpace ?? "");
    return esc(pre ? t.text : t.text.replace(/\s+/g, " "));
  }

  markup(u: UNode, depth: number, inner?: (u: UNode, depth: number) => string): string {
    if (u.text) return this.textHtml(u);
    const r = this.roles.get(u);
    if (r?.pseudo || r?.skip) return "";
    if (r?.marquee?.source) {
      // a copy of the strip: the complete copy's markup again, hidden from assistive technology
      return this.markup(r.marquee.source, depth, inner)
        .replace(/^<(\w+)([^>]*?) aria-hidden="true"/, "<$1$2")
        .replace(/^<(\w+)/, '<$1 aria-hidden="true"')
        .replace(/ tabindex="\d+"/g, "")
        .replace(/<(a|button|input|select|textarea)\b/g, '<$1 tabindex="-1"');
    }
    const n = this.el(u);
    if (!n || n.kind === "marker") return "";
    let tag = this.tags.get(u) ?? "div";
    const a: Record<string, string> = {};
    const cls = this.classOf.get(u);
    if (cls) a.class = cls;
    const live = n.attrs ?? {};
    // the page's own ids where something points at them (in-page links, labels)
    if (live.id && (this.referenced(live.id) || this.labelled().has(live.id))) a.id = live.id;
    if (tag === "main") a.id = a.id ?? "main";
    if (
      live.role &&
      !/^(presentation|none)$/.test(live.role) &&
      !(r?.slider || r?.dot || r?.dots) &&
      roleAllowed(tag, live.role)
    )
      a.role = live.role;
    // slider dots: a pointer shortcut beside the arrows and the keys (WCAG 2.5.8: an equivalent control meets the size)
    if (r?.dots) {
      a["aria-hidden"] = "true";
      delete a["aria-label"];
    }
    for (const [k, v] of Object.entries(n.aria ?? {})) {
      if (k === "labelledby-text") {
        if (!live["aria-label"]) a["aria-label"] = v;
        continue;
      }
      if (/^aria-(labelledby|describedby|controls)$/.test(k)) {
        // a relation stays where every id it names stays in the page
        if (v.split(/\s+/).every((id) => this.labelled().has(id))) a[k] = v;
        continue;
      }
      if (k === "for") {
        if (tag === "label") a.for = v;
        continue;
      }
      if (k === "tabindex" && Number(v) < 0 && !/^(a|button)$/.test(tag)) continue;
      // states the page's scripts switch (a panel's aria-hidden, a toggle's aria-expanded): the runtime owns them now
      if (k === "aria-hidden" && v === "true" && (r?.menuPanel || this.focusableInside(u))) continue;
      if (k === "aria-expanded" && !r?.menuTrigger) continue;
      a[k] = v;
    }
    if (live["aria-label"]) a["aria-label"] = live["aria-label"];
    if (live.title) a.title = live.title;
    const label = this.labels.get(u);
    if (label) a["aria-label"] = label;
    if (tag === "a") {
      if (live.href) a.href = this.href(live.href);
      if (a.target === "_blank") a.rel = "noopener";
    }
    if (tag === "button" && !a.type) a.type = live.type === "submit" ? "submit" : "button";
    // roles of the runtime
    if (r?.slider?.role === "track") {
      a.id = r.slider.id;
      a["data-slider"] = "";
      if (r.slider.facts.autoplay) a["data-autoplay"] = String(r.slider.facts.autoplay);
      if (r.slider.facts.loop) a["data-loop"] = "";
      // a slider the page lets glide freely (no snapping to slides)
      if (r.slider.facts.free) a["data-free"] = "";
      a.tabindex = "0";
      a["aria-label"] = a["aria-label"] ?? this.sliderLabel(u, r.slider.id);
      // a list of slides stays a list; a box becomes the carousel region
      if (/^(div|span)$/.test(tag)) {
        a.role = "region";
        a["aria-roledescription"] = "carousel";
      }
    }
    if (r?.slider?.role === "slide" && /^(div|span)$/.test(tag)) {
      // a slide is a group; elements with a role of their own (li, article, img) keep it
      a.role = "group";
      a["aria-roledescription"] = "slide";
      a["aria-label"] = `${(r.slider.index ?? 0) + 1} / ${r.slider.count}`;
    }
    if (r?.arrow) {
      a["data-slider-step"] = String(r.arrow.dir);
      a["aria-controls"] = r.arrow.slider;
    }
    if (r?.dots) a["data-slider-dots"] = r.dots.slider;
    if (r?.dot) {
      a["data-slider-dot"] = String(r.dot.index);
      a["aria-controls"] = r.dot.slider;
      for (const k of ["role", "aria-selected", "aria-label", "type", "tabindex"]) delete a[k];
    }
    if (r?.videoToggle) {
      a["data-pause-label"] = this.t("pauseVideo");
      a["data-play-label"] = this.t("playVideo");
      a["data-video-toggle"] = r.videoToggle.video;
      a["aria-controls"] = r.videoToggle.video;
      a["aria-pressed"] = "false";
    }
    if (r?.menuTrigger) {
      a["data-menu-open"] = r.menuTrigger;
      a["aria-expanded"] = "false";
      delete a["aria-controls"];
    }
    const region = this.regions.get(u.key);
    if (region) a["data-region"] = region.id;
    for (const [, rg] of this.regions) {
      const one = rg.states.get(u.key);
      if (!one || one.hover) continue;
      a[one.toggle ? "data-region-toggle" : "data-region-set"] = `${rg.id}:${one.state}`;
      this.regionStateAria(a, one.toggle, false, r);
    }
    // a tab / option of the group whose look is the widget at rest: selecting it brings that back
    const baseOf = this.regionBase.get(u);
    if (baseOf) {
      a["data-region-set"] = `${baseOf}:`;
      this.regionStateAria(a, false, true, r);
    }
    if (r?.marquee?.role === "track") a["data-marquee"] = r.marquee.id;
    // the first copy is read; the others repeat it
    if (r?.marquee?.role === "copy" && (r.marquee.index ?? 0) > 0) {
      a["aria-hidden"] = "true";
    }
    if (r?.marqueeToggle) {
      a["data-marquee-toggle"] = r.marqueeToggle;
      a["aria-pressed"] = "false";
      if (!a["aria-label"]) a["aria-label"] = this.t("pauseAnimation");
      a["data-pause-label"] = this.t("pauseAnimation");
      a["data-play-label"] = this.t("playAnimation");
    }
    if (r?.menuClose) a["data-menu-close"] = "";
    if (r?.menuBack) a["data-menu-back"] = "";
    if (r?.menuPanel) a["data-menu-panel"] = r.menuPanel;
    const extra = this.extraAttrs.get(u);
    if (extra) Object.assign(a, extra);
    // media
    if (tag === "img") return this.imgHtml(u, n, a);
    if (tag === "video") return this.videoHtml(u, n, a);
    if (tag === "svg") return this.svgHtml(u, n, a);
    if (n.kind === "input" || (n.tag === "input" && tag === "input")) return this.inputHtml(n, tag, a, u);
    // a line break the page shows at some widths only keeps its class (display: none elsewhere)
    if (tag === "br") return cls ? `<br class="${cls}">` : "<br>";
    if (u === this.model.root) tag = "body";
    const kids = u.children
      .map((c) => (c.text ? this.textHtml(c) : inner ? inner(c, depth + 1) : this.markup(c, depth + 1)))
      .join("");
    const sr = (this.srOnly.get(u.key) ?? [])
      .map((s) => `<span class="visually-hidden">${esc(s.text)}</span>`)
      .join("");
    const pause = r?.video ? "" : this.addedPause(u);
    const html = `<${tag}${attrs(a)}>${kids}${sr}${pause}</${tag}>`;
    // a repeated copy is hidden from assistive technology: nothing in it takes focus either
    if (r?.marquee?.role === "copy" && (r.marquee.index ?? 0) > 0)
      return html
        .replace(/ tabindex="\d+"/g, "")
        .replace(/<(a|button|input|select|textarea)\b/g, '<$1 tabindex="-1"');
    return html;
  }

  /** a pause control for a moving video the page offers none for (WCAG 2.2.2) */
  addedPause(u: UNode): string {
    const v = u.children.find((c) => this.roles.get(c)?.video);
    if (!v) return "";
    const id = this.roles.get(v)!.video!.id;
    if ([...this.roles.values()].some((r) => r.videoToggle?.video === id)) return "";
    this.report.added.push("pause control for the background video");
    return `<button class="video-toggle" type="button" data-video-toggle="${id}" aria-controls="${id}" aria-pressed="false" aria-label="${this.t("pauseVideo")}" data-pause-label="${this.t("pauseVideo")}" data-play-label="${this.t("playVideo")}"></button>`;
  }

  focusableInside(u: UNode): boolean {
    let f = false;
    eachNode(u, (x) => {
      if (!f && /^(a|button|input|select|textarea|summary)$/.test(this.tags.get(x) ?? "")) f = true;
    });
    return f;
  }

  /** controls of a select group without a captured state of their own: the one selected at rest */
  private regionBaseMap?: Map<UNode, string>;
  get regionBase(): Map<UNode, string> {
    if (this.regionBaseMap) return this.regionBaseMap;
    const m = new Map<UNode, string>();
    for (const [, rg] of this.regions)
      for (const [key, one] of rg.states) {
        if (one.toggle || one.hover) continue;
        const ctl = this.model.byKey.get(key);
        for (const sib of ctl?.parent?.children ?? [])
          if (sib !== ctl && !sib.text && sib.tag === ctl!.tag && !rg.states.has(sib.key)) m.set(sib, rg.id);
      }
    return (this.regionBaseMap = m);
  }

  /** the state a widget's control announces: expanded (an accordion), selected (a tab), pressed (a toggle) */
  regionStateAria(a: Record<string, string>, toggle: boolean, on: boolean, r?: Role) {
    if (r?.videoToggle || r?.marqueeToggle) return;
    // the page's own value at rest wins (the tab selected when the page loads)
    if (a.role === "tab" || a.role === "option") a["aria-selected"] ??= String(on);
    else if (a.role === "radio") a["aria-checked"] ??= String(on);
    else if (!a["aria-pressed"] && !a["aria-expanded"])
      a[toggle ? "aria-expanded" : "aria-pressed"] = String(on);
  }

  inside(x: UNode, a: UNode): boolean {
    for (let p: UNode | undefined = x; p; p = p.parent) if (p === a) return true;
    return false;
  }

  /** a slider's name: the heading of its section, else its number (every carousel named differently) */
  sliderLabel(u: UNode, id: string): string {
    for (let p = u.parent; p; p = p.parent) {
      let h = "";
      eachNode(p, (x) => {
        if (!h && /^h[1-6]$/.test(this.tags.get(x) ?? "") && !this.inside(x, u)) h = this.textOf(x);
      });
      if (h) return h.slice(0, 80);
      if (this.sections.includes(p)) break;
    }
    return this.t("slides", id.replace(/\D+/g, ""));
  }

  /** a link into the page itself stays in the recreation (`#work`), other links point at the live site */
  href(h: string): string {
    const page = this.snap0().url;
    try {
      const u = new URL(h),
        p = new URL(page);
      if (u.origin === p.origin && u.pathname === p.pathname && u.search === p.search)
        return u.hash && u.hash !== "#" ? u.hash : "./";
    } catch {
      /* not absolute */
    }
    return h;
  }

  /** the text of the label pointing at a field */
  labelText(n: SnapElement): string {
    const id = n.attrs?.id;
    if (!id) return "";
    let t = "";
    eachNode(this.model.root, (u) => {
      if (!t && this.el(u)?.aria?.for === id) t = this.textOf(u);
    });
    return t.replace(/\s*\*\s*$/, "");
  }

  private labelIds?: Set<string>;
  /** ids a label points at (`<label for>`): the field keeps its id so its label still names it */
  labelled(): Set<string> {
    if (this.labelIds) return this.labelIds;
    const ids = new Set<string>();
    eachNode(this.model.root, (u) => {
      const ar = this.el(u)?.aria;
      if (ar?.for) ids.add(ar.for);
      for (const k of ["aria-controls", "aria-labelledby", "aria-describedby"])
        for (const id of (ar?.[k] ?? "").split(/\s+/)) if (id) ids.add(id);
    });
    // only ids that are in the page
    const present = new Set<string>();
    eachNode(this.model.root, (u) => {
      const id = this.el(u)?.attrs?.id;
      if (id) present.add(id);
    });
    for (const id of [...ids]) if (!present.has(id)) ids.delete(id);
    return (this.labelIds = ids);
  }

  referenced(id: string): boolean {
    for (const v of this.vs) {
      const want = `#${id}`;
      let hit = false;
      const visit = (n: SnapNode) => {
        if (hit || n.kind === "text") return;
        const e = n as SnapElement;
        if (e.attrs?.href?.endsWith(want)) hit = true;
        for (const c of e.children ?? []) visit(c);
      };
      if (v.snap.root) visit(v.snap.root);
      if (hit) return true;
    }
    return false;
  }

  imgHtml(u: UNode, n: SnapElement, a: Record<string, string>): string {
    // every width's picture: the variants' encodings of one source → srcset; different sources (art direction) → <picture>
    const per = this.vs.map((_, vi) => {
      const e = u.at[vi];
      return isEl(e) ? (e.src ?? null) : null;
    });
    // an image only an open state shows (a flyout's teaser, a submenu's picture): the state's source
    const sn = this.stateNodes.get(u) as SnapElement | undefined;
    if (!per.some(Boolean) && sn?.src) per[per.length - 1] = sn.src;
    const files: { vi: number; file: string; w: number; h: number }[] = [];
    per.forEach((src, vi) => {
      const f = this.assetFor(src);
      if (!f) return;
      const size = imageSize(this.files[f] as Uint8Array);
      const e = (u.at[vi] ?? sn) as SnapElement;
      const w = size?.w || e.natural?.w || Math.round(e.rect.w),
        h = size?.h || e.natural?.h || Math.round(e.rect.h);
      files.push({ vi, file: f, w, h });
    });
    const alt = n.alt ?? "";
    a.alt = alt;
    if (!files.length) {
      // never loaded during the capture (a lazy slide): the live page's picture, at the size the page gave it
      const src = per.find((x) => x && !x.startsWith("data:"));
      const e = (u.at.find(isEl) ?? n) as SnapElement;
      a.src = src ?? "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
      a.width = String(e.natural?.w || Math.round(e.rect.w) || 1);
      a.height = String(e.natural?.h || Math.round(e.rect.h) || 1);
      a.loading = "lazy";
      a.decoding = "async";
      if (src) this.report.added.push(`image ${src.slice(0, 80)} linked to the live page (not captured)`);
      return `<img${attrs(a)}>`;
    }
    const main = files[files.length - 1]!;
    a.src = main.file;
    a.width = String(n.natural?.w || main.w);
    a.height = String(n.natural?.h || main.h);
    const uniq = [...new Map(files.map((f) => [f.file, f])).values()].sort((x, y) => x.w - y.w);
    if (uniq.length > 1) {
      a.srcset = uniq.map((f) => `${f.file} ${f.w}w`).join(", ");
      a.sizes = this.sizes(u);
    }
    if (u === this.lcp) {
      a.fetchpriority = "high";
      this.lcpHref = main.file;
    } else {
      a.loading = "lazy";
    }
    a.decoding = "async";
    return `<img${attrs(a)}>`;
  }

  /** `sizes`: the image's width at each layout range, as a share of the viewport */
  sizes(u: UNode): string {
    const parts: string[] = [];
    for (let vi = this.vs.length - 1; vi >= 0; vi--) {
      const n = u.at[vi];
      if (!isEl(n)) continue;
      const vw = this.vs[vi]!.snap.viewport.width;
      const share = Math.min(100, Math.round((n.rect.w / vw) * 100));
      const q = this.vs[vi]!.minWidth;
      parts.push(q ? `(min-width: ${q}px) ${share}vw` : `${share}vw`);
    }
    if (parts.length && /^\(/.test(parts[parts.length - 1]!)) parts.push("100vw");
    return parts.join(", ");
  }

  videoHtml(u: UNode, n: SnapElement, a: Record<string, string>): string {
    const role = this.roles.get(u)?.video;
    const m = n.media?.kind === "video" ? n.media : undefined;
    const poster = this.assetFor(n.poster ?? n.src);
    const sources: string[] = [];
    const reasons: string[] = [];
    for (const s of m?.sources ?? []) {
      const got = this.input.media?.[s.src];
      if (!got) {
        reasons.push(`not downloaded: ${s.src}`);
        continue;
      }
      const ext = got.type.includes("webm") ? "webm" : got.type.includes("ogg") ? "ogv" : "mp4";
      const file = `media/${slug(nameFromUrl(s.src)) || "video"}-${createHash("sha256").update(got.body).digest("hex").slice(0, 10)}.${ext}`;
      this.files[file] = got.body;
      sources.push(
        `<source src="${file}" type="${attr(s.type ?? got.type)}"${s.media ? ` media="${attr(s.media)}"` : ""}>`,
      );
      this.report.videos.push({ src: s.src, file });
      break;
    }
    if (!sources.length) {
      this.report.videos.push({
        src: m?.sources[0]?.src ?? "",
        reason: m?.stream ? "a stream (no file): poster kept" : (reasons[0] ?? "no source"),
      });
      // no playable file: the frame the capture saw
      const b = { ...a };
      b.alt = "";
      if (poster) b.src = poster;
      if (role) b["data-video-fallback"] = role.id;
      return `<img${attrs(b)}>`;
    }
    if (role) a.id = role.id;
    const frames = this.posters.get(u);
    if (frames?.length) {
      // the frame of each layout range is the video's background (one image per range); loaded first where it is the
      // largest thing in the first screen
      if (u === this.lcp)
        this.lcpLinks = frames.map(({ vi, file }) => {
          const lo = this.vs[vi]!.minWidth,
            hi = this.vs.slice(vi + 1).find((_, k) => frames.some((f) => f.vi === vi + 1 + k))?.minWidth;
          const media = [lo ? `(min-width: ${lo}px)` : "", hi ? `(max-width: ${hi - 0.02}px)` : ""]
            .filter(Boolean)
            .join(" and ");
          return `<link rel="preload" as="image" href="${attr(file)}"${media ? ` media="${media}"` : ""} fetchpriority="high">`;
        });
    } else if (poster) {
      a.poster = poster;
      if (u === this.lcp) this.lcpHref = poster;
    }
    if (m?.autoplay !== false) {
      // started by the runtime once the page has loaded (the poster paints first; nothing under reduced motion)
      a.muted = "";
      a["data-autoplay"] = "";
    }
    if (m?.loop !== false) a.loop = "";
    a.playsinline = "";
    a.preload = "none";
    if (!m?.label) a["aria-hidden"] = "true";
    else a["aria-label"] = m.label;
    a.disablepictureinpicture = "";
    return `<video${attrs(a)}>${sources.join("")}</video>`;
  }

  svgHtml(u: UNode, n: SnapElement, a: Record<string, string>): string {
    const markup = n.svg ?? "";
    const named = /<title>/.test(markup) || !!a["aria-label"] || !!n.attrs?.["aria-label"];
    const extra: Record<string, string> = {
      ...a,
      ...(named ? { role: "img" } : { "aria-hidden": "true", focusable: "false" }),
    };
    delete extra.title;
    return markup.replace(/^<svg\b([^>]*)>/, (_m, rest: string) => {
      const kept = rest.replace(/\s(class|aria-hidden|focusable|role|width|height|style)="[^"]*"/g, "");
      return `<svg${kept}${attrs(extra)}>`;
    });
  }

  inputHtml(n: SnapElement, tag: string, a: Record<string, string>, u?: UNode): string {
    // a checkbox / radio the capture drew as a picture: the control itself, drawn by its captured box
    if (n.kind === "raster" && n.tag === "input") {
      const type = /radio/i.test(n.attrs?.type ?? "") ? "radio" : "checkbox";
      if (n.attrs?.name) a.name = n.attrs.name;
      return `<input${attrs({ ...a, type })}>`;
    }
    // the placeholder of whichever width shows one (a page may show a label above the field instead on wide screens)
    const ph = u ? u.at.map((x) => (isEl(x) ? x.input?.placeholder : "")).find(Boolean) : undefined;
    const i = n.input;
    if (ph || i?.placeholder) a.placeholder = (ph || i?.placeholder)!;
    // a field is named even where its label is hidden (a placeholder in its place on phones)
    if (n.attrs?.name) a.name = n.attrs.name;
    // a button drawn by its value stays an input (its label is no text of the page); its value names it
    if (tag === "button" || i?.type === "button") {
      delete a["aria-label"];
      delete a.placeholder;
      return `<input${attrs({ ...a, type: n.attrs?.type === "submit" ? "submit" : "button", value: i?.value ?? "" })}>`;
    }
    if (!a["aria-label"])
      a["aria-label"] = ph || i?.placeholder || this.labelText(n) || n.attrs?.name || "Input";
    if (tag === "textarea") return `<textarea${attrs(a)}>${esc(i?.value ?? "")}</textarea>`;
    if (tag === "select") return `<select${attrs(a)}><option>${esc(i?.value ?? "")}</option></select>`;
    a.type = i?.type && i.type !== "button" ? i.type : "text";
    if (i?.value && a.type !== "password") a.value = i.value;
    return `<input${attrs(a)}>`;
  }

  // ---------------------------------------------------------------------------------------------- base css

  fontFaces(): { css: string; preload: string[] } {
    if (this.input.fonts === "system") return { css: "", preload: [] };
    const fonts: ImportedFont[] = [];
    const seen = new Set<string>();
    for (const v of [...this.vs].reverse())
      for (const f of v.snap.embeddedFonts ?? []) {
        const k = `${f.family}|${f.weight}|${f.style}|${f.unicodeRange ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        fonts.push(f);
      }
    const rules: string[] = [];
    const files: { file: string; family: string; weight: string; style: string; range?: string }[] = [];
    for (const f of fonts) {
      const d = decodeDataUrl(f.src);
      if (!d) continue;
      const ext = /woff2/.test(d.mime)
        ? "woff2"
        : /woff/.test(d.mime)
          ? "woff"
          : /otf|opentype/.test(d.mime)
            ? "otf"
            : "ttf";
      const file = `fonts/${slug(f.family)}-${slug(f.weight)}-${f.style}-${createHash("sha256").update(d.body).digest("hex").slice(0, 8)}.${ext}`;
      this.files[file] = d.body;
      files.push({
        file,
        family: f.family,
        weight: f.weight,
        style: f.style,
        ...(f.unicodeRange ? { range: f.unicodeRange } : {}),
      });
      rules.push(
        `@font-face { font-family: ${JSON.stringify(f.family)}; src: url("${file}") format("${ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : ext}"); font-weight: ${f.weight}; font-style: ${f.style}; font-display: swap;${f.unicodeRange ? ` unicode-range: ${f.unicodeRange};` : ""}${f.stretch ? ` font-stretch: ${f.stretch};` : ""} }`,
      );
    }
    // the faces the first screen's texts use (Latin subset) load first: no text moves when they arrive
    const used = new Map<string, number>();
    for (const vi of [0, this.vs.length - 1]) {
      const v = this.vs[vi]!;
      for (const n of this.model.walks[vi]![0]!.byKey.values()) {
        if (!isTextNode(n) || !n.lines[0] || n.lines[0].y > v.snap.viewport.height) continue;
        const k = `${n.font.family}|${n.font.weight}|${n.font.italic ? "italic" : "normal"}`;
        used.set(k, (used.get(k) ?? 0) + n.text.length);
      }
    }
    const latin = (r?: string) => !r || /U\+0+(-|,|$)|U\+0+-0*FF|U\+0-FF/i.test(r);
    const covers = (w: string, want: number) => {
      const [a, b] = w.split(" ").map(Number);
      return b ? want >= a! && want <= b : a === want;
    };
    const preload = [...used]
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => {
        const [fam, w, st] = k.split("|");
        // the Latin subset when the faces are split by script, else the smallest file of the face
        return files
          .filter((f) => f.family === fam && f.style === st && covers(f.weight, Number(w)) && latin(f.range))
          .sort(
            (a, b) =>
              Number(!a.range) - Number(!b.range) ||
              (this.files[a.file]?.length ?? 0) - (this.files[b.file]?.length ?? 0),
          )[0];
      })
      .filter((f): f is (typeof files)[0] => !!f)
      .map((f) => f.file)
      .filter((f, i, all) => all.indexOf(f) === i)
      .slice(0, 3);
    return { css: rules.join("\n"), preload };
  }

  baseCss(fontCss: string): string {
    // colours used more than twice become tokens
    const tokens = [...this.colors].filter(([, n]) => n > 2).sort((a, b) => b[1] - a[1]);
    const names = new Map<string, string>();
    tokens.forEach(([c], k) => names.set(c, k === 0 ? "--color-text" : `--color-${k}`));
    const accent = tokens.find(([c]) => saturated(c))?.[0] ?? tokens[0]?.[0] ?? "#005fcc";
    const bodyBg = normColor(this.snap0().page.background || "#fff");
    const body = [...this.bodyText].map(([k, v]) => `${k}: ${v};`).join(" ");
    return `/* Recreated with CDR: one DOM for every width, mobile first, at the page's own breakpoints (${
      this.vs
        .map((v) => v.minWidth)
        .filter(Boolean)
        .join(", ") || "none"
    } px). */
${fontCss}
:root { ${[...names].map(([c, n]) => `${n}: ${c};`).join(" ")} --focus-ring: ${accent}; color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { background: ${bodyBg}; ${body} -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; overflow-x: clip; }
:where(img, picture, video, canvas, svg) { display: block; max-width: 100%; }
:where(img, video) { height: auto; }
:where(input, button, textarea, select) { font: inherit; color: inherit; letter-spacing: inherit; }
:where(button) { background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
:where(input, textarea, select) { border: 0; background: none; }
:where(fieldset) { border: 0; padding: 0; min-width: 0; }
:where(legend) { padding: 0; }
::placeholder { color: var(--placeholder, currentColor); opacity: 1; }
:where(input[type="checkbox"], input[type="radio"]):checked { background-image: radial-gradient(currentColor 40%, transparent 45%); }
:where(ul, ol) { list-style: none; padding: 0; }
:where(a) { color: inherit; text-decoration: none; }
:where(h1, h2, h3, h4, h5, h6) { font-size: inherit; font-weight: inherit; }
:where(p, h1, h2, h3, h4, h5, h6, li) { overflow-wrap: break-word; }
:where(iframe) { border: 0; }
:where(table) { border-collapse: collapse; }
:focus-visible { outline: 3px solid var(--focus-ring); outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) { :root { interpolate-size: allow-keywords; } }
.visually-hidden { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 8px; top: -100px; z-index: 1000; padding: 8px 16px; background: #fff; color: #000; }
.skip-link:focus { top: 8px; }
[data-slider] { overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory; scroll-behavior: smooth; scrollbar-width: none; }
[data-slider]::-webkit-scrollbar { display: none; }
@media (pointer: fine) { [data-slider] { cursor: grab; } }
[data-slider][data-dragging] { cursor: grabbing; scroll-snap-type: none; scroll-behavior: auto; user-select: none; }
[data-slider][data-free] { scroll-snap-type: none; }
[data-slider] :where(img, a) { -webkit-user-drag: none; }
[data-slider] > * { scroll-snap-align: start; }
[data-slider-step][aria-disabled="true"] { cursor: default; }
[data-slider-dot][aria-current="true"] { opacity: 1; }
.video-toggle { position: absolute; right: 16px; bottom: 16px; z-index: 2; width: 40px; height: 40px; border-radius: 50%; border: 2px solid currentColor; color: #fff; background: rgb(0 0 0 / 0.35); }
.video-toggle::before { content: ""; display: block; margin: auto; width: 12px; height: 14px; border-inline: 4px solid currentColor; }
.video-toggle[aria-pressed="true"]::before { width: 0; height: 0; border: 0; border-block: 7px solid transparent; border-left: 12px solid currentColor; margin-left: 15px; }
:root[data-menu] { overflow: hidden; }
@keyframes cdr-marquee { to { translate: var(--marquee-shift, -50%) 0; } }
[data-marquee]:hover, [data-marquee][data-paused] { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) { [data-marquee] { animation: none !important; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}
`;
  }
}

// ------------------------------------------------------------------------------------------------- helpers

const EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

const TAG_NAMES: Record<string, string> = {
  div: "box",
  span: "label",
  p: "text",
  a: "link",
  img: "image",
  video: "video",
  svg: "icon",
  ul: "list",
  ol: "list",
  li: "item",
  button: "button",
  h1: "title",
  h2: "heading",
  h3: "subheading",
  h4: "subheading",
  h5: "subheading",
  h6: "subheading",
  section: "section",
  header: "header",
  footer: "footer",
  nav: "nav",
  figure: "figure",
  article: "card",
  main: "main",
  input: "field",
  form: "form",
};

/** ARIA in HTML: the roles an element may take (elements not listed take any role; empty: none) */
const ALLOWED_ROLES: Record<string, string> = {
  li: "menuitem menuitemcheckbox menuitemradio option radio separator tab treeitem",
  ul: "directory group listbox menu menubar radiogroup tablist toolbar tree",
  ol: "directory group listbox menu menubar radiogroup tablist toolbar tree",
  a: "button checkbox menuitem menuitemcheckbox menuitemradio option radio switch tab treeitem",
  button: "checkbox combobox link menuitem menuitemcheckbox menuitemradio option radio switch tab",
  article: "application document feed main region",
  section:
    "alert alertdialog application banner complementary contentinfo dialog document feed group log main marquee navigation note search status tabpanel",
  nav: "menu menubar tablist",
  header: "group",
  footer: "group",
  main: "",
  aside: "feed note region search",
  h1: "tab",
  h2: "tab",
  h3: "tab",
  h4: "tab",
  h5: "tab",
  h6: "tab",
  p: "",
  img: "button checkbox link menuitem menuitemcheckbox menuitemradio meter option progressbar radio scrollbar separator slider switch tab treeitem",
  input: "",
  select: "",
  textarea: "",
  video: "application",
  figure: "",
  form: "search",
};
function roleAllowed(tag: string, role: string): boolean {
  const list = ALLOWED_ROLES[tag];
  return list === undefined || list.split(" ").includes(role);
}

function attrs(a: Record<string, string>): string {
  return Object.entries(a)
    .map(([k, v]) =>
      v === "" && /^(autoplay|muted|loop|playsinline|disablepictureinpicture|data-.*|hidden)$/.test(k)
        ? ` ${k}`
        : ` ${k}="${attr(v)}"`,
    )
    .join("");
}

function nameFromUrl(u: string): string {
  if (u.startsWith("data:video/")) return "video";
  if (u.startsWith("data:")) return "image";
  try {
    const p = new URL(u).pathname.split("/").filter(Boolean).pop() ?? "";
    return p.replace(/\.\w+$/, "");
  } catch {
    return "";
  }
}

/**
 * The readable words of a class attribute: each class a name (BEM `block__element` joined, a `--modifier` as its own
 * word), hashes, states and utilities dropped, at most three words each
 */
export function classWords(cls: string): string[] {
  const out: string[] = [];
  for (const c of cls.split(/\s+/)) {
    if (
      !c ||
      /^(js-|is-|has-|u-|wp-|elementor-|css-|sc-|jsx-|svelte-|ng-|_|swiper-|animate|animated|fade|slow|fast|delay)/.test(
        c,
      )
    )
      continue;
    if (/[0-9a-f]{5,}|\d{3,}|^[a-z]{1,2}\d|[A-Z]{3,}|^(col|row)-(xs|sm|md|lg|xl)/.test(c)) continue;
    const [base, mod] = c.split("--");
    for (const part of [base, mod]) {
      if (!part) continue;
      const w = slug(part.replace(/__/g, "-"), 40).split("-").slice(0, 3).join("-");
      if (w.length >= 3 && /[a-z]{3}/.test(w) && !out.includes(w)) out.push(w);
    }
  }
  return out;
}

/** a readable name from the page's classes: the first that is a word, BEM parts joined, hashes and states dropped */
export function cleanClass(cls: string): string {
  for (const c of cls.split(/\s+/)) {
    if (
      !c ||
      /^(js-|is-|has-|u-|wp-|elementor-|css-|sc-|jsx-|svelte-|ng-|_|swiper-slide-(active|next|prev|visible|duplicate))/.test(
        c,
      )
    )
      continue;
    if (/[0-9a-f]{5,}|\d{3,}|^[a-z]{1,2}\d|[A-Z]{3,}/.test(c)) continue;
    const s = slug(c.replace(/__/g, "-").replace(/--.*$/, ""), 28);
    if (s.length >= 3 && /[a-z]{3}/.test(s)) return s.split("-").slice(0, 3).join("-");
  }
  return "";
}

/** colours as short hex (alpha kept as rgb()/a) */
export function normColor(c: string): string {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(c.trim());
  if (!m) return c;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => Math.round(Number(x)));
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (a >= 1) {
    const hex = [r, g, b].map((x) => x!.toString(16).padStart(2, "0")).join("");
    return /^(.)\1(.)\2(.)\3$/.test(hex) ? `#${hex[0]}${hex[2]}${hex[4]}` : `#${hex}`;
  }
  if (a === 0) return "transparent";
  return `rgb(${r} ${g} ${b} / ${Math.round(a * 1000) / 1000})`;
}

function saturated(c: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (!m) return false;
  const h =
    m[1]!.length === 3
      ? m[1]!
          .split("")
          .map((x) => x + x)
          .join("")
      : m[1]!;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 60;
}

/** the value a property goes back to where a wider range no longer sets it */
function resetOf(k: string, tag: string): string {
  if (k === "display") return defaultDisplay(tag);
  if (INHERITED.has(k)) return "inherit";
  return RESET[k] ?? "unset";
}

const RESET: Record<string, string> = {
  width: "auto",
  height: "auto",
  "min-width": "0",
  "min-height": "0",
  "max-width": "none",
  "max-height": "none",
  margin: "0",
  padding: "0",
  gap: "normal",
  flex: "0 1 auto",
  "flex-direction": "row",
  "flex-wrap": "nowrap",
  "flex-shrink": "1",
  "flex-basis": "auto",
  "justify-content": "normal",
  "align-items": "normal",
  "align-self": "auto",
  "grid-template-columns": "none",
  "grid-column": "auto",
  "grid-row": "auto",
  position: "static",
  "z-index": "auto",
  top: "auto",
  left: "auto",
  right: "auto",
  bottom: "auto",
  inset: "auto",
  "background-color": "transparent",
  "background-image": "none",
  border: "0",
  "border-top": "0",
  "border-right": "0",
  "border-bottom": "0",
  "border-left": "0",
  "border-radius": "0",
  "box-shadow": "none",
  opacity: "1",
  transform: "none",
  translate: "none",
  scale: "none",
  filter: "none",
  overflow: "visible",
  "aspect-ratio": "auto",
  "object-fit": "fill",
  "object-position": "50% 50%",
  outline: "revert",
  "text-decoration": "none",
  "list-style": "none",
  "clip-path": "none",
  "mix-blend-mode": "normal",
  transition: "none",
  cursor: "auto",
  float: "none",
};

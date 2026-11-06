// Ported from an earlier private project by the same author (see THIRD_PARTY_NOTICES.md).
// Design-system packages: the project's component sets (catalog.ts componentApi = their props), tokens and styles as a
// ready-to-use library for React, Lit (web components) or Angular — typed props, one component per set, variants as
// props, tokens as CSS variables, a docs page listing every component. Built from one framework-neutral model
// (model.ts: templates + styles per variant derived from the mains, so default props render exactly like the main).
import type { SceneComponentDef, SceneDesignSystem } from "@harness/protocol";
import type { FileMap } from "../bundle.js";
import { buildModel, type DsModel } from "./model.js";
import { defaultPackageName, npmName } from "./names.js";
import { reactPackage, reactUsage } from "./emitReact.js";
import { litPackage, litUsage } from "./emitLit.js";
import { angularPackage, angularUsage } from "./emitAngular.js";

export type DsFramework = "react" | "lit" | "angular";
export const DS_FRAMEWORKS: readonly DsFramework[] = ["react", "lit", "angular"];
export const DS_FRAMEWORK_LABELS: Record<DsFramework, string> = {
  react: "React",
  lit: "Lit (web components)",
  angular: "Angular",
};

export interface DsPackageOptions {
  /** npm package name (default: from the design system's name) */
  packageName?: string;
  /** fonts to bundle (as the HTML / React exports get them) */
  fonts?: { family: string; file: string; weight?: string; style?: string; data: Uint8Array }[];
  /** prefix of custom element tags / CSS classes (default: the system's first word, e.g. `bvg`) */
  prefix?: string;
  /** package version (default 0.1.0) */
  version?: string;
}

const models = new WeakMap<SceneDesignSystem, Map<string, DsModel>>();

/** The framework-neutral model of a design system (memoised per design-system object and prefix). */
export function designSystemModel(ds: SceneDesignSystem, prefix?: string): DsModel {
  let byPrefix = models.get(ds);
  if (!byPrefix) {
    byPrefix = new Map();
    models.set(ds, byPrefix);
  }
  const key = prefix ?? "";
  let m = byPrefix.get(key);
  if (!m) {
    m = buildModel(ds, { prefix });
    byPrefix.set(key, m);
  }
  return m;
}

/** Package name for a framework: the given one, else `<system>-ui-<framework>`. */
export const packageNameFor = (ds: SceneDesignSystem, fw: DsFramework, given?: string) =>
  npmName(given?.trim() || defaultPackageName(ds.name, fw));

/** A buildable package (package.json, sources, tokens.css, README, docs) for one framework. */
export function buildDesignSystemPackage(
  ds: SceneDesignSystem,
  fw: DsFramework,
  o: DsPackageOptions = {},
): FileMap {
  const model = designSystemModel(ds, o.prefix);
  const packageName = packageNameFor(ds, fw, o.packageName);
  const fonts = (o.fonts ?? []).map((f) => ({
    ...f,
    file: f.file.startsWith("fonts/") ? f.file : `fonts/${f.file.split("/").pop()}`,
  }));
  const opts = { packageName, fonts, version: o.version };
  return fw === "react"
    ? reactPackage(model, opts)
    : fw === "lit"
      ? litPackage(model, opts)
      : angularPackage(model, opts);
}

/** How to use one component in a framework, with the given prop values (the component library's "Code" tab). */
export function usageSnippet(
  def: SceneComponentDef,
  ds: SceneDesignSystem,
  fw: DsFramework,
  values: Record<string, string | boolean> = {},
  o: { packageName?: string; prefix?: string } = {},
): string {
  const model = designSystemModel(ds, o.prefix);
  const spec = model.byId.get(def.id);
  const packageName = packageNameFor(ds, fw, o.packageName);
  if (!spec) return `// “${def.name}” has no main to export`;
  return fw === "react"
    ? reactUsage(spec, values, packageName)
    : fw === "lit"
      ? litUsage(spec, values, packageName)
      : angularUsage(spec, values, packageName);
}

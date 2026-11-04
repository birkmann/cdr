// Colorful file and folder icons from the Material Icon Theme (MIT, https://github.com/material-extensions/vscode-material-icon-theme),
// resolved the way VS Code does: exact file name, then the longest matching extension.
import manifest from "material-icon-theme/dist/material-icons.json";
import { useEffect, useState } from "react";

type Map = Record<string, string>;
interface Manifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileNames: Map;
  fileExtensions: Map;
  folderNames: Map;
  folderNamesExpanded: Map;
  file: string;
  folder: string;
  folderExpanded: string;
  light: { fileNames?: Map; fileExtensions?: Map; folderNames?: Map; folderNamesExpanded?: Map };
}
const m = manifest as unknown as Manifest;

// Every icon as an asset URL (copied to dist; never inlined into the JS bundle).
const urls = import.meta.glob("../node_modules/material-icon-theme/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;
const byName = new Map<string, string>();
for (const [path, url] of Object.entries(urls)) byName.set(path.slice(path.lastIndexOf("/") + 1, -4), url);

function pick(
  map: Map | undefined,
  lightMap: Map | undefined,
  key: string,
  light: boolean,
): string | undefined {
  return (light ? lightMap?.[key] : undefined) ?? map?.[key];
}

/** Icon id (an SVG name) for a file, by exact name then the longest extension (`d.ts` before `ts`). */
export function fileIconName(path: string, light = false): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const exact = pick(m.fileNames, m.light.fileNames, name, light);
  if (exact) return exact;
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const hit = pick(m.fileExtensions, m.light.fileExtensions, ext, light);
    if (hit) return hit;
  }
  return m.file;
}

export function folderIconName(path: string, open: boolean, light = false): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const hit = open
    ? pick(m.folderNamesExpanded, m.light.folderNamesExpanded, name, light)
    : pick(m.folderNames, m.light.folderNames, name, light);
  return hit ?? (open ? m.folderExpanded : m.folder);
}

export function iconUrl(id: string): string | undefined {
  const def = m.iconDefinitions[id];
  const file = def ? def.iconPath.slice(def.iconPath.lastIndexOf("/") + 1, -4) : id;
  return byName.get(file) ?? byName.get(id);
}

// ------------------------------------------------------------------ preference

export type IconStyle = "colorful" | "monochrome";
const KEY = "morrow.studio.icons";
const EVENT = "studio:icon-style";

export function getIconStyle(): IconStyle {
  try {
    return localStorage.getItem(KEY) === "monochrome" ? "monochrome" : "colorful";
  } catch {
    return "colorful";
  }
}

export function setIconStyle(style: IconStyle) {
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* storage unavailable: the choice lasts for this window */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: style }));
}

/** Current icon style; re-renders when it changes. */
export function useIconStyle(): IconStyle {
  const [style, setStyle] = useState(getIconStyle);
  useEffect(() => {
    const h = (e: Event) => setStyle((e as CustomEvent<IconStyle>).detail);
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
  return style;
}

/** Light themes use the theme's light variants where it has them. */
export function useLightTheme(): boolean {
  const read = () => document.documentElement.dataset.theme === "light";
  const [light, setLight] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setLight(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return light;
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessHome } from "@harness/core";
import { isDesign, type TerminalDesign } from "./widgets.js";

/** Terminal preferences live next to the other user-wide state, in `<harness home>/tui.json`. */
const file = () => join(harnessHome(), "tui.json");

export function loadDesign(): TerminalDesign {
  try {
    const { design } = JSON.parse(readFileSync(file(), "utf8")) as { design?: string };
    return design && isDesign(design) ? design : "default";
  } catch {
    return "default";
  }
}

/** Remember the design for the next start. Returns false when the file cannot be written. */
export function saveDesign(design: TerminalDesign): boolean {
  try {
    let prefs: Record<string, unknown> = {};
    try {
      prefs = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    } catch {
      // first write, or an unreadable file we replace
    }
    mkdirSync(harnessHome(), { recursive: true });
    writeFileSync(file(), JSON.stringify({ ...prefs, design }, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

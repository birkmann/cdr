import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace, normalizeSpec } from "@harness/design-system";

/** node_modules of @harness/design-system (lit, @lit/react, react, @types/react are its dev dependencies). */
export const DS_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

/** Write a generated workspace to a temp folder (node_modules linked to the dev dependencies). */
export function writeWorkspace(primary = "#0f5132") {
  const ws = buildWorkspace(
    normalizeSpec({
      name: "Acme Outdoor",
      colors: { primary },
      radius: { control: 999, container: 12 },
      controlHeight: 48,
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), "cdr-ds-"));
  for (const [p, c] of Object.entries(ws.files)) {
    const f = join(dir, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, c);
  }
  symlinkSync(DS_MODULES, join(dir, "node_modules"), "dir");
  return { dir, ws };
}

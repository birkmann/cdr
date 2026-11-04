import { describe, expect, it } from "vitest";
import { stepZoom, ZOOM_LEVELS } from "./zoom";

describe("zoom levels", () => {
  it("steps through levels and clamps at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(ZOOM_LEVELS.at(-1)!, 1)).toBe(ZOOM_LEVELS.at(-1));
    expect(stepZoom(ZOOM_LEVELS[0], -1)).toBe(ZOOM_LEVELS[0]);
  });
});

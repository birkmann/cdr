import { describe, expect, it } from "vitest";
import { splitRows } from "./diff-split";
import type { DiffLine } from "./ipc";

const ctx = (o: number, n: number, text = "c"): DiffLine => ({ kind: "context", oldNo: o, newNo: n, text });
const del = (o: number, text = "d"): DiffLine => ({ kind: "del", oldNo: o, text });
const add = (n: number, text = "a"): DiffLine => ({ kind: "add", newNo: n, text });

describe("splitRows", () => {
  it("puts context on both sides", () => {
    const c = ctx(1, 1);
    expect(splitRows([c])).toEqual([{ left: c, right: c }]);
  });

  it("pairs a deletion run with the addition run after it and pads the shorter side", () => {
    const lines = [del(2), del(3), add(2), add(3), add(4)];
    expect(splitRows(lines)).toEqual([
      { left: lines[0], right: lines[2] },
      { left: lines[1], right: lines[3] },
      { left: undefined, right: lines[4] },
    ]);
  });

  it("keeps pure additions and deletions on their own side", () => {
    const a = add(5);
    const d = del(9);
    const c = ctx(6, 6);
    expect(splitRows([a, c, d])).toEqual([{ left: undefined, right: a }, { left: c, right: c }, { left: d }]);
  });
});

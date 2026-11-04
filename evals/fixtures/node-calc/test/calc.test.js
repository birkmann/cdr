import { test } from "node:test";
import assert from "node:assert/strict";
import { add, average } from "../src/calc.js";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("average", () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([]), 0);
});

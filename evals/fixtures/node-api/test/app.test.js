import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/app.js";

test("health", () => {
  assert.deepEqual(handle("GET", "/health"), { status: 200, body: { ok: true } });
});

test("users", () => {
  assert.equal(handle("GET", "/users").body.length, 2);
});

test("unknown route", () => {
  assert.equal(handle("GET", "/nope").status, 404);
});

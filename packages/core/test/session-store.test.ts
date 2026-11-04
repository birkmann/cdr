import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@harness/core";

describe("shared session log tailing", () => {
  it("waits for a complete UTF-8 record and never repeats an already consumed event", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "session-tail-")));
    const record = (seq: number, text: string) => ({
      v: 1,
      sessionId: "shared",
      seq,
      ts: new Date().toISOString(),
      type: "message.delta",
      id: "msg",
      text,
    });
    const first = record(1, "hello");
    appendFileSync(store.path("shared"), JSON.stringify(first) + "\n");
    const initial = store.readAfter("shared", 0, 0);
    expect(initial.events).toEqual([first]);
    const second = record(2, "Ready 🌅");
    const bytes = Buffer.from(JSON.stringify(second) + "\n");
    const split = bytes.indexOf(Buffer.from("🌅")) + 2;
    appendFileSync(store.path("shared"), bytes.subarray(0, split));
    expect(store.readAfter("shared", initial.offset, 1)).toEqual({ events: [], offset: initial.offset });
    appendFileSync(store.path("shared"), bytes.subarray(split));
    const next = store.readAfter("shared", initial.offset, 1);
    expect(next.events).toEqual([second]);
    expect(store.readAfter("shared", next.offset, 2)).toEqual({ events: [], offset: next.offset });
  });
});

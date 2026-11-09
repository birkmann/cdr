import { describe, expect, it } from "vitest";
import { messageHash, normaliseMessage, signatureOf } from "@harness/autopilot";

describe("message normalisation", () => {
  it("removes what differs between sites", () => {
    expect(
      normaliseMessage(
        "desktop /de: parity 0.91 < 0.97 (diff verify/visual/desktop/index.diff.png) at https://www.bvg.de/x.css on 127.0.0.1:4310",
      ),
    ).toBe("<viewport> <path>: parity <n> < <n> (diff <path>) at <url> on <host>");
  });

  it("maps two sites hitting one code path to one message", () => {
    const a =
      "ENOENT: no such file /tmp/run-a/.harness/recreate/20261108-082041-bvg-de-1z9/out/app.js on www.bvg.de";
    const b =
      "ENOENT: no such file /var/x/.harness/recreate/20261108-101802-ibm-com-xrl/out/app.js on www.ibm.com";
    expect(normaliseMessage(a)).toBe(normaliseMessage(b));
    expect(messageHash(a)).toBe(messageHash(b));
  });

  it("replaces numbers, ids and uuids, and site ids it is told about", () => {
    expect(normaliseMessage("step 12 took 3.5 s on run deadbeef01 at mobile")).toBe(
      "step <n> took <n> s on run <id> at <viewport>",
    );
    expect(normaliseMessage("8f14e45f-ceea-4af3-b7c4-2f5a6d8e9a10 failed")).toBe("<id> failed");
    expect(normaliseMessage("bvg broke", ["bvg"])).toBe("<site> broke");
  });

  it("keeps a different message different", () => {
    expect(messageHash("connection refused")).not.toBe(messageHash("connection timed out"));
  });
});

describe("signatures", () => {
  it("has the forms of the plan", () => {
    expect(signatureOf("mirror", { code: "visual.parity", cause: "CSS_MISSING", message: "x" })).toBe(
      "mirror:visual.parity:CSS_MISSING",
    );
    expect(signatureOf("mirror", { code: "PIPELINE_BUG", cause: "CHECK_CRASHED:links", message: "x" })).toBe(
      "mirror:PIPELINE_BUG:CHECK_CRASHED:links",
    );
    expect(signatureOf("design-system", { code: "BUILD_FAILED", cause: "tsc", message: "x" })).toBe(
      "design-system:BUILD_FAILED:tsc",
    );
    expect(signatureOf("freeze", { code: "REPLAY_404", cause: "stylesheet", message: "x" })).toBe(
      "freeze:REPLAY_404:stylesheet",
    );
    expect(signatureOf("health", { code: "STAGE_SLOW", cause: "appbuild", message: "x" })).toBe(
      "health:STAGE_SLOW:appbuild",
    );
  });

  it("hashes the normalised message when a code has no cause, but not a gate id", () => {
    expect(signatureOf("mirror", { code: "BROKEN_LINK", message: "internal link /a returns 500" })).toMatch(
      /^mirror:BROKEN_LINK:[0-9a-f]{8}$/,
    );
    expect(signatureOf("mirror", { code: "links.broken", message: "whatever" })).toBe("mirror:links.broken");
    const a = signatureOf("mirror", {
      code: "BROKEN_LINK",
      message: "internal link /about returns 404 on www.bvg.de",
    });
    const b = signatureOf("mirror", {
      code: "BROKEN_LINK",
      message: "internal link /kontakt returns 404 on www.ibm.com",
    });
    expect(a).toBe(b);
  });

  it("treats the host-and-number variants of a message as one signature", () => {
    const a = signatureOf("mirror", {
      code: "BROKEN_LINK",
      message: "link at https://www.bvg.de/a/b returns 500",
    });
    const b = signatureOf("mirror", {
      code: "BROKEN_LINK",
      message: "link at https://www.ibm.com/x/y returns 503",
    });
    expect(a).toBe(b);
  });
});

import { describe, expect, it } from "vitest";
import { designSystemCommand, parseDesignSystemArgs } from "../src/design-system-command.js";

const sink = () => {
  let text = "";
  return {
    out: { write: (s: string) => ((text += s), true) } as unknown as NodeJS.WritableStream,
    text: () => text,
  };
};

describe("cdr design-system arguments", () => {
  it("takes a URL with every option", () => {
    expect(
      parseDesignSystemArgs([
        "https://example.com",
        "--out",
        "ds",
        "--frameworks",
        "react,angular",
        "--name",
        "Acme",
        "--prefix",
        "acme",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      url: "https://example.com",
      out: "ds",
      frameworks: ["react", "angular"],
      name: "Acme",
      prefix: "acme",
      yes: true,
      json: true,
    });
  });

  it("takes --run and defaults to React", () => {
    expect(parseDesignSystemArgs(["--run", "20261109-x", "--out", "ds"])).toMatchObject({
      run: "20261109-x",
      frameworks: ["react"],
      yes: false,
    });
  });

  it.each([
    [["--out", "ds"], /URL or --run/],
    [["u", "--run", "x", "--out", "ds"], /not both/],
    [["u"], /--out/],
    [["u", "--out", "ds", "--frameworks", "vue"], /Unknown framework vue/],
    [["u", "--out", "ds", "--prefix", "A1"], /--prefix/],
    [["u", "--out"], /--out needs a value/],
    [["u", "--out", "ds", "--nope"], /Unknown option --nope/],
    [["u", "extra", "--out", "ds"], /Unexpected argument extra/],
  ] as [string[], RegExp][])("refuses %j", (argv, re) => {
    const r = parseDesignSystemArgs(argv);
    expect("error" in r && r.error).toMatch(re);
  });
});

describe("cdr design-system command", () => {
  const fakeResult = (ok: boolean) =>
    ({
      ok,
      runId: "r",
      runDir: "/r",
      out: "/x/ds",
      report: { name: "Acme", scope: "@acme-ds" },
      gates: [{ id: "npm.build", pass: ok, hard: true, value: ok }],
      issues: [],
    }) as never;

  it("needs consent before anything runs", async () => {
    const s = sink();
    let called = false;
    const code = await designSystemCommand(["https://x", "--out", "ds"], {
      cwd: "/tmp",
      out: s.out,
      build: async () => ((called = true), fakeResult(true)),
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(s.text()).toMatch(/--yes/);
  });

  it("exits 0 only when the build's gates pass", async () => {
    for (const ok of [true, false]) {
      const s = sink();
      const code = await designSystemCommand(["https://x", "--out", "ds", "--yes"], {
        cwd: "/tmp",
        out: s.out,
        build: async (o) => {
          expect(o.out).toBe("/tmp/ds");
          expect(o.frameworks).toEqual(["react"]);
          return fakeResult(ok);
        },
      });
      expect(code).toBe(ok ? 0 : 1);
      expect(s.text()).toContain(ok ? "pass  npm.build" : "FAIL  npm.build");
    }
  });

  it("prints usage on bad arguments and exits non-zero", async () => {
    const s = sink();
    expect(await designSystemCommand(["--out", "x"], { cwd: "/tmp", out: s.out })).toBe(1);
    expect(s.text()).toMatch(/Usage: cdr design-system/);
  });
});

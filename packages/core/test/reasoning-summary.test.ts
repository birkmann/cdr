import { describe, expect, it } from "vitest";
import { Harness, MockProvider, parseSummary } from "@harness/core";
import { initialSessionState, reduceSession } from "@harness/client";
import { MOCK_MODELS, tempProject } from "./helpers.js";

const LONG_THOUGHTS = "I weigh a few options for storing the saved journeys. ".repeat(80); // > 1 chunk

function setup(extra: object = {}) {
  const summaryRequests: string[] = [];
  const mock = new MockProvider({
    handler: (req) => {
      const sys = req.messages[0]?.content ?? "";
      if (sys.startsWith("You watch a coding agent think")) {
        summaryRequests.push(req.messages[1].content as string);
        return {
          text: summaryRequests.length === 1 ? "- Uses localStorage for saved journeys\nNONE" : "NONE",
        };
      }
      return { reasoning: LONG_THOUGHTS, text: "Done." };
    },
  });
  const h = new Harness({
    providers: { mock },
    skipGlobalConfig: true,
    loadEnv: false,
    configOverrides: { ...MOCK_MODELS, ...extra },
  });
  return { h, summaryRequests };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("thinking summaries", () => {
  it("parses decision lines and ignores NONE", () => {
    expect(parseSummary("NONE")).toEqual([]);
    expect(parseSummary("1. Uses a grid\n• “Skips the cart”\nThird line")).toEqual([
      "Uses a grid",
      "Skips the cart",
    ]);
  });

  it("turns long thinking into reasoning.summary events the client shows as decisions", async () => {
    const { h, summaryRequests } = setup();
    const s = h.createSession({ projectPath: tempProject({}), permissionMode: "auto" });
    await s.chat("Build a journey planner");
    await until(() => s.events.some((e) => e.type === "reasoning.summary"));
    const summaries = s.events.filter((e) => e.type === "reasoning.summary");
    expect(summaries.map((e) => (e as { text: string }).text)).toEqual([
      "Uses localStorage for saved journeys",
    ]);
    expect(summaryRequests[0]).toContain("Build a journey planner");
    const msgId = (summaries[0] as { id: string }).id;
    const state = s.events.reduce(reduceSession, initialSessionState());
    expect(state.messages[msgId].decisions).toEqual(["Uses localStorage for saved journeys"]);
    expect(s.events.some((e) => e.type === "usage" && e.model === "mock/m" && e.outputTokens >= 0)).toBe(
      true,
    );
  });

  it("can be turned off with context.reasoningSummaries = false", async () => {
    const { h, summaryRequests } = setup({ context: { reasoningSummaries: false } });
    const s = h.createSession({ projectPath: tempProject({}), permissionMode: "auto" });
    await s.chat("Build a journey planner");
    await new Promise((r) => setTimeout(r, 50));
    expect(summaryRequests).toEqual([]);
    expect(s.events.some((e) => e.type === "reasoning.summary")).toBe(false);
  });
});

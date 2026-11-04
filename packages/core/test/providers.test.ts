import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider, AnthropicProvider, collect, toAnthropicMessages } from "@harness/core";

function sseResponse(chunks: unknown[], status = 200): Response {
  const body = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function fakeFetch(responses: (Response | ((body: any) => Response))[]) {
  const bodies: any[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return typeof r === "function" ? r(body) : r;
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe("OpenAI-compatible provider", () => {
  it("sends DeepSeek's native thinking controls, leaving defaults and unrelated APIs untouched", async () => {
    const f = fakeFetch(Array.from({ length: 7 }, () => sseResponse(["[DONE]"])));
    const p = new OpenAICompatibleProvider({
      id: "custom-name",
      baseURL: "https://api.deepseek.com/v1",
      fetch: f.fn,
    });
    expect(p.capabilities("deepseek-flash").reasoningEfforts).toEqual(["none", "low", "high", "max"]);
    for (const reasoningEffort of [undefined, "auto", "none", "low", "high", "max"] as const)
      await collect(p.stream({ model: "deepseek-flash", messages: [], reasoningEffort }));
    expect(f.bodies[0]).not.toHaveProperty("thinking");
    expect(f.bodies[1]).not.toHaveProperty("reasoning_effort");
    expect(f.bodies[2]).toMatchObject({ thinking: { type: "disabled" } });
    expect(f.bodies[2]).not.toHaveProperty("reasoning_effort");
    for (let i = 3; i < 6; i++)
      expect(f.bodies[i]).toMatchObject({
        thinking: { type: "enabled" },
        reasoning_effort: ["low", "high", "max"][i - 3],
      });
    const other = new OpenAICompatibleProvider({
      id: "deepseek",
      baseURL: "https://example.test/v1",
      fetch: f.fn,
    });
    await collect(other.stream({ model: "deepseek-flash", messages: [], reasoningEffort: "high" }));
    expect(f.bodies[6]).not.toHaveProperty("thinking");
    expect(f.bodies[6]).not.toHaveProperty("reasoning_effort");
  });

  it("supports explicitly configured effort levels for compatible gateways", async () => {
    const f = fakeFetch([sseResponse(["[DONE]"])]);
    const p = new OpenAICompatibleProvider({
      id: "gateway",
      baseURL: "https://example.test/v1",
      fetch: f.fn,
      models: { custom: { reasoningEfforts: ["low", "medium", "high"] } },
    });
    await collect(p.stream({ model: "custom", messages: [], reasoningEffort: "medium" }));
    expect(f.bodies[0].reasoning_effort).toBe("medium");
    expect(f.bodies[0]).not.toHaveProperty("thinking");
  });

  it("streams text, reasoning, assembles tool call deltas and usage", async () => {
    const f = fakeFetch([
      sseResponse([
        { choices: [{ delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ delta: { content: "Let me " } }] },
        { choices: [{ delta: { content: "look." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "read_", arguments: '{"pa' } }],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.ts"}' } }] } },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "call_2", function: { name: "glob", arguments: '{"pattern":"*"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
        "[DONE]",
      ]),
    ]);
    const p = new OpenAICompatibleProvider({ id: "t", baseURL: "http://x/v1", apiKey: "k", fetch: f.fn });
    const r = await collect(
      p.stream({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "", parameters: {} }],
      }),
    );
    expect(r.text).toBe("Let me look.");
    expect(r.reasoning).toBe("thinking...");
    expect(r.toolCalls).toEqual([
      { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { id: "call_2", name: "glob", arguments: '{"pattern":"*"}' },
    ]);
    expect(r.usage).toEqual({ input: 100, output: 20 });
    expect(f.bodies[0].tools[0].function.name).toBe("read_file");
    expect(f.bodies[0].stream).toBe(true);
  });

  it("serialises assistant tool calls and tool results", async () => {
    const f = fakeFetch([sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"])]);
    const p = new OpenAICompatibleProvider({ id: "t", baseURL: "http://x/v1", fetch: f.fn });
    await collect(
      p.stream({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }],
            reasoning: "r",
          },
          { role: "tool", toolCallId: "c1", name: "read_file", content: "data" },
        ],
      }),
    );
    expect(f.bodies[0].messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        reasoning_content: "r",
      },
      { role: "tool", tool_call_id: "c1", content: "data" },
    ]);
  });

  it("retries on 429/5xx", async () => {
    const f = fakeFetch([
      new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }),
      new Response("oops", { status: 503 }),
      sseResponse([{ choices: [{ delta: { content: "ok" } }] }, "[DONE]"]),
    ]);
    const p = new OpenAICompatibleProvider({ id: "t", baseURL: "http://x/v1", fetch: f.fn });
    const r = await collect(p.stream({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    expect(r.text).toBe("ok");
    expect(f.bodies).toHaveLength(3);
  });

  it("does not retry 4xx", async () => {
    const f = fakeFetch([new Response("bad key", { status: 401 })]);
    const p = new OpenAICompatibleProvider({ id: "t", baseURL: "http://x/v1", fetch: f.fn });
    await expect(collect(p.stream({ model: "m", messages: [] }))).rejects.toThrow(/HTTP 401 bad key/);
  });

  it("falls back to the text protocol when the model does not support tools", async () => {
    const f = fakeFetch([
      new Response('{"error":{"message":"registry.ollama.ai/library/gemma does not support tools"}}', {
        status: 400,
      }),
      (body) => {
        expect(body.tools).toBeUndefined();
        expect(body.messages[0].content).toContain("Tool calling protocol");
        return sseResponse([
          {
            choices: [
              { delta: { content: 'Reading\n```tool\n{"name":"read_file","arguments":{"path":"x"}}\n```' } },
            ],
          },
          "[DONE]",
        ]);
      },
    ]);
    const p = new OpenAICompatibleProvider({ id: "t", baseURL: "http://x/v1", fetch: f.fn });
    const r = await collect(
      p.stream({
        model: "gemma",
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        tools: [{ name: "read_file", description: "read", parameters: {} }],
      }),
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe("read_file");
    expect(p.capabilities("gemma").tools).toBe(false);
  });
});

describe("Anthropic provider", () => {
  it("converts messages and parses the event stream", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "glob" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"pattern":' },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"*.ts"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
    ];
    const f = fakeFetch([
      new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        status: 200,
      }),
    ]);
    const p = new AnthropicProvider({ id: "a", apiKey: "k", fetch: f.fn });
    const r = await collect(
      p.stream({
        model: "claude",
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "U" },
        ],
        tools: [{ name: "glob", description: "d", parameters: { type: "object" } }],
      }),
    );
    expect(r.text).toBe("Hi");
    expect(r.toolCalls).toEqual([{ id: "tu_1", name: "glob", arguments: '{"pattern":"*.ts"}' }]);
    expect(r.usage).toEqual({ input: 50, output: 31 });
    expect(f.bodies[0].system[0]).toMatchObject({ text: "S", cache_control: { type: "ephemeral" } });
    expect(f.bodies[0].tools[0].input_schema).toEqual({ type: "object" });
  });

  it("groups tool results into a single user turn", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "1", name: "a", arguments: "{}" },
          { id: "2", name: "b", arguments: '{"x":1}' },
        ],
      },
      { role: "tool", toolCallId: "1", name: "a", content: "r1" },
      { role: "tool", toolCallId: "2", name: "b", content: "r2" },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[1].content.map((c: any) => c.type)).toEqual(["tool_use", "tool_use"]);
    expect(messages[2].content.map((c: any) => c.tool_use_id)).toEqual(["1", "2"]);
  });
});

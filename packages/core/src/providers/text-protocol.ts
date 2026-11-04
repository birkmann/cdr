/**
 * Text-protocol tool calling for models without native tool support.
 * The model is told to emit fenced ```tool blocks containing JSON; the harness parses them.
 */
import type { ChatMessage, ToolCall } from "@harness/protocol";
import type { ToolSpec } from "./types.js";
import { newId } from "../util.js";

export function textProtocolInstructions(tools: ToolSpec[]): string {
  const lines = [
    "# Tool calling protocol",
    "You can call tools. To call a tool, output a fenced code block with the language `tool` containing one JSON object:",
    "```tool",
    '{"name": "read_file", "arguments": {"path": "src/index.ts"}}',
    "```",
    "You may emit several tool blocks in one reply. After your tool blocks, STOP and wait: the results arrive in the next message.",
    "When you are completely done and need no more tools, reply with plain text and no tool block.",
    "",
    "## Available tools",
  ];
  for (const t of tools) {
    lines.push(`### ${t.name}`, t.description, "Arguments JSON schema:", JSON.stringify(t.parameters), "");
  }
  return lines.join("\n");
}

const BLOCK_RE = /```(?:tool|tool_call|json)?\s*\n([\s\S]*?)```/g;

export function parseTextToolCalls(text: string, toolNames: Set<string>): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const body = m[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = (o.name ?? o.tool) as string | undefined;
      if (!name || !toolNames.has(name)) continue;
      const args = o.arguments ?? o.args ?? o.parameters ?? {};
      calls.push({
        id: newId("call_"),
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
    }
  }
  return calls;
}

/** Rewrite native tool messages into plain text for models without tool support. */
export function toTextProtocolMessages(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const instructions = textProtocolInstructions(tools);
  let injected = false;
  for (const m of messages) {
    if (m.role === "system" && !injected) {
      out.push({ role: "system", content: `${m.content}\n\n${instructions}` });
      injected = true;
    } else if (m.role === "assistant") {
      let content = m.content;
      if (m.toolCalls?.length && !content.includes("```tool")) {
        content +=
          "\n" +
          m.toolCalls
            .map(
              (c) =>
                "```tool\n" + JSON.stringify({ name: c.name, arguments: safeParse(c.arguments) }) + "\n```",
            )
            .join("\n");
      }
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const prev = out[out.length - 1];
      const block = `Result of tool \`${m.name}\`:\n${m.content}`;
      if (prev && prev.role === "user" && prev.content.startsWith("Result of tool")) {
        prev.content += `\n\n${block}`;
      } else out.push({ role: "user", content: block });
    } else out.push(m);
  }
  if (!injected) out.unshift({ role: "system", content: instructions });
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Provider } from "./providers/types.js";
import { redact } from "./util.js";

export interface ProjectSummary {
  /** A short human title, e.g. "Snake game in the browser". */
  title: string;
  /** One or two sentences on what the project is. */
  summary: string;
}

const SYSTEM = `You name and describe software projects for a project picker.
Reply with JSON only: {"title": "...", "summary": "..."}
- title: 2 to 6 words saying what the project is (for example "Snake game in the browser" or "Accessories store storefront"). Not the folder name alone, no quotes, no trailing period.
- summary: one or two plain sentences (at most 220 characters) saying what the project does and its main technology.
- Describe only what the files and conversation titles show. If the folder is empty or unclear, say so plainly.`;

const README = /^readme(\.(md|markdown|txt|rst))?$/i;
const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "go.mod", "composer.json", "Gemfile"];

function readHead(path: string, max: number): string {
  try {
    if (!statSync(path).isFile()) return "";
    return readFileSync(path, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

/** What the model sees: a top-level listing, the README head and manifests. No file is read in full. */
export function projectContext(root: string, conversationTitles: string[] = []): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, 80);
  } catch {
    /* unreadable: summarise from the titles alone */
  }
  const parts = [`Folder name: ${basename(root)}`];
  parts.push(entries.length ? `Top-level entries:\n${entries.join("\n")}` : "The folder is empty.");
  const readme = entries.find((e) => README.test(e));
  if (readme) parts.push(`${readme} (start):\n${readHead(join(root, readme), 3000)}`);
  for (const m of MANIFESTS)
    if (existsSync(join(root, m))) parts.push(`${m} (start):\n${readHead(join(root, m), 1500)}`);
  const titles = [...new Set(conversationTitles.map((t) => t.trim()).filter(Boolean))].slice(0, 15);
  if (titles.length)
    parts.push(`Conversations held in this project:\n${titles.map((t) => `- ${t}`).join("\n")}`);
  return redact(parts.join("\n\n"));
}

/** Parse the model reply; tolerates code fences and prose around the JSON object. */
export function parseProjectSummary(text: string): ProjectSummary | null {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { title?: unknown; summary?: unknown };
    const title = typeof obj.title === "string" ? obj.title.trim().replace(/^["']|["'.]$/g, "") : "";
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!title) return null;
    return { title: title.slice(0, 80), summary: summary.slice(0, 300) };
  } catch {
    return null;
  }
}

export async function generateProjectSummary(o: {
  root: string;
  provider: Provider;
  model: string;
  conversationTitles?: string[];
  signal?: AbortSignal;
}): Promise<ProjectSummary> {
  let text = "";
  for await (const ev of o.provider.stream({
    model: o.model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: projectContext(o.root, o.conversationTitles) },
    ],
    temperature: 0.2,
    maxTokens: 300,
    reasoningEffort: "none",
    signal: o.signal,
  })) {
    if (ev.type === "text") text += ev.text;
  }
  const parsed = parseProjectSummary(text);
  if (!parsed) throw new Error("The model did not return a project summary.");
  return { title: redact(parsed.title), summary: redact(parsed.summary) };
}

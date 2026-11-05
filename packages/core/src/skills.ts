import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessConfig } from "@harness/protocol";
import { harnessHome } from "./config.js";

/**
 * Skills: folders with a SKILL.md (Agent Skills format: YAML frontmatter with `name` and `description`,
 * then Markdown instructions) plus optional reference files. Only names and descriptions go into every
 * system prompt; the body is loaded on demand with `load_skill`, or injected up front when a skill's
 * `triggers` match the task in a sandbox session.
 */
export interface Skill {
  name: string;
  description: string;
  /** Case-insensitive patterns matched against the task for auto-activation. */
  triggers: RegExp[];
  /** Where auto-activation is allowed: sandbox sessions only (default), every session, or never. */
  auto: "sandbox" | "always" | "never";
  /** Markdown instructions without the frontmatter. */
  body: string;
  /** Absolute folder of the skill (reference files are resolved inside it). */
  dir: string;
  source: "project" | "config" | "user" | "builtin";
}

const MAX_SKILL_BYTES = 200_000;

/** Built-in skills ship next to the compiled code (packages/core/skills) or the single-file bundle (./skills). */
export function builtinSkillsDir(): string | null {
  if (process.env.HARNESS_BUILTIN_SKILLS) return process.env.HARNESS_BUILTIN_SKILLS;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, "..", "skills"), join(here, "skills")]) if (hasSkillFolders(dir)) return dir;
  return null;
}

function hasSkillFolders(dir: string): boolean {
  try {
    return readdirSync(dir).some((d) => existsSync(join(dir, d, "SKILL.md")));
  } catch {
    return false;
  }
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Minimal YAML frontmatter parser: `key: value`, `key: [a, b]` and `key:` followed by `- item` lines. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(raw) ?? /^-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = null;
    if (!value.trim()) {
      data[key] = [];
      listKey = key;
    } else if (value.trim().startsWith("[") && value.trim().endsWith("]")) {
      data[key] = value.trim().slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else data[key] = unquote(value);
  }
  return { data, body: text.slice(m[0].length) };
}

function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(" ") : (v ?? "");
}

/** Parse one skill folder. Returns null when SKILL.md is missing or has no name/description. */
export function readSkill(dir: string, source: Skill["source"]): Skill | null {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_SKILL_BYTES) return null;
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  const name = str(data.name).trim();
  const description = str(data.description).replace(/\s+/g, " ").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !description) return null;
  const triggers: RegExp[] = [];
  for (const t of Array.isArray(data.triggers) ? data.triggers : data.triggers ? [data.triggers] : []) {
    try {
      triggers.push(new RegExp(t, "i"));
    } catch {
      /* ignore invalid patterns */
    }
  }
  const auto = str(data.auto).trim();
  return {
    name,
    description,
    triggers,
    auto: auto === "always" || auto === "never" ? auto : "sandbox",
    body: body.trim(),
    dir: realpathSync(dir),
    source,
  };
}

function skillsIn(base: string, source: Skill["source"]): Skill[] {
  if (!existsSync(base)) return [];
  let entries: string[];
  try {
    entries = readdirSync(base).sort();
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const e of entries) {
    const dir = join(base, e);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const s = readSkill(dir, source);
      if (s) out.push(s);
    } catch {
      /* unreadable folder */
    }
  }
  return out;
}

/** Discover skills. Earlier locations win on name clashes: project → config paths → user → built-in. */
export function discoverSkills(projectRoot: string, config?: HarnessConfig): Skill[] {
  const cfg = config?.skills;
  if (cfg?.enabled === false) return [];
  const locations: [string, Skill["source"]][] = [[join(projectRoot, ".harness", "skills"), "project"]];
  for (const p of cfg?.paths ?? [])
    locations.push([
      isAbsolute(p) ? p : resolve(projectRoot, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")),
      "config",
    ]);
  locations.push([join(harnessHome(), "skills"), "user"]);
  const builtin = builtinSkillsDir();
  if (builtin) locations.push([builtin, "builtin"]);
  const disabled = new Set(cfg?.disabled ?? []);
  const seen = new Map<string, Skill>();
  for (const [dir, source] of locations)
    for (const s of skillsIn(dir, source))
      if (!seen.has(s.name) && !disabled.has(s.name)) seen.set(s.name, s);
  return [...seen.values()];
}

/** System-prompt section listing the available skills (names and descriptions only). */
export function skillsIndex(skills: Skill[], active: string[] = []): string {
  if (!skills.length) return "";
  const lines = skills.map(
    (s) => `- **${s.name}**${active.includes(s.name) ? " (already loaded below)" : ""}: ${s.description}`,
  );
  return `# Skills\nSkills are expert instructions for specific kinds of work. Before starting work that a skill covers, call \`load_skill\` with its name and follow it. Skills marked as loaded are already included in this prompt.\n${lines.join("\n")}`;
}

/** Skills whose triggers match the task and whose `auto` scope allows this session. */
export function matchSkills(skills: Skill[], task: string, opts: { sandbox: boolean }): Skill[] {
  return skills.filter((s) => {
    if (s.auto === "never" || (s.auto === "sandbox" && !opts.sandbox)) return false;
    return s.triggers.some((t) => t.test(task));
  });
}

/** Full skill text as injected into a prompt or returned by load_skill. */
export function renderSkill(s: Skill): string {
  const refs = listSkillFiles(s);
  return `<skill name="${s.name}">\n${s.body}${refs.length ? `\n\nReference files (read with load_skill { name: "${s.name}", file }): ${refs.join(", ")}` : ""}\n</skill>`;
}

/** Files inside the skill folder other than SKILL.md (relative, `/`-separated, max depth 3). */
export function listSkillFiles(s: Skill): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const e of readdirSync(dir).sort()) {
      if (e.startsWith(".")) continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, depth + 1);
      else if (p !== join(s.dir, "SKILL.md")) out.push(relative(s.dir, p).split(sep).join("/"));
    }
  };
  try {
    walk(s.dir, 0);
  } catch {
    /* ignore */
  }
  return out;
}

/** Resolve a reference file inside a skill folder; rejects `..`, absolute paths and symlink escapes. */
export function resolveSkillFile(s: Skill, file: string): string {
  if (!file || isAbsolute(file)) throw new Error(`Invalid skill file "${file}".`);
  const abs = resolve(s.dir, file);
  if (!existsSync(abs)) throw new Error(`Skill "${s.name}" has no file "${file}".`);
  const real = realpathSync(abs);
  if (!real.startsWith(s.dir + sep)) throw new Error(`File "${file}" is outside the skill folder.`);
  if (!statSync(real).isFile()) throw new Error(`"${file}" is not a file.`);
  return real;
}

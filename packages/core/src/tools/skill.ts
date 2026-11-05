import { readFileSync, statSync } from "node:fs";
import type { Tool } from "./types.js";
import { discoverSkills, listSkillFiles, renderSkill, resolveSkillFile } from "../skills.js";
import { truncateMiddle } from "../util.js";

const MAX_FILE_CHARS = 120_000;

export const loadSkillTool: Tool = {
  name: "load_skill",
  description:
    "Load a skill's full instructions (listed under # Skills in the system prompt) before starting work it covers. " +
    "Pass `file` to read one of the skill's reference files instead.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name, e.g. web-app." },
      file: {
        type: "string",
        description: "Optional reference file inside the skill, e.g. reference/patterns.md.",
      },
    },
    required: ["name"],
  },
  readOnly: true,
  risk: () => "low",
  async execute(args: { name: string; file?: string }, ctx) {
    const skills = discoverSkills(ctx.projectRoot, ctx.config);
    const skill = skills.find((s) => s.name === args.name);
    if (!skill)
      return {
        ok: false,
        output: `Unknown skill "${args.name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}.`,
      };
    if (!args.file) {
      ctx.emit({ type: "log", level: "info", message: `Skill ${skill.name} loaded` });
      return { ok: true, output: renderSkill(skill) };
    }
    try {
      const abs = resolveSkillFile(skill, args.file);
      if (statSync(abs).size > 2_000_000) return { ok: false, output: `${args.file} is too large to read.` };
      return { ok: true, output: truncateMiddle(readFileSync(abs, "utf8"), MAX_FILE_CHARS).text };
    } catch (e) {
      return {
        ok: false,
        output: `${(e as Error).message} Files: ${listSkillFiles(skill).join(", ") || "(none)"}.`,
      };
    }
  },
};

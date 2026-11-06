# Configuration

`cdr.config.json` in the project (or `.cdr/config.json`), merged over `~/.harness/config.json` and the defaults. `harness.config.json` and `.harness/config.json` are also read when no CDR config exists. `cdr init` preserves an existing config instead of creating a competing file.

Saved sessions, tokens, and project artifacts live under `.harness`. `CDR_HOME` overrides the global directory; `HARNESS_HOME` is read when `CDR_HOME` is not set.

Example configuration:

```jsonc
{
  "models": {
    "executor": "deepseek/deepseek-flash",
    "planner": "deepseek/deepseek-v4-pro",
    "reviewer": "deepseek/deepseek-v4-pro",
    "summarizer": "local/qwen3.8:latest",
  },
  "providers": {
    // built in: deepseek, ollama (cloud), local (Ollama on :11434), openrouter, anthropic
    "lmstudio": {
      "type": "openai-compatible",
      "baseURL": "http://localhost:1234/v1",
      "models": { "my-model": { "tools": false, "contextWindow": 32000 } },
    },
  },
  "verify": { "build": "pnpm build", "test": "pnpm test", "lint": "pnpm lint", "maxAttempts": 3 },
  "permissions": { "mode": "ask", "bash": { "allow": ["pnpm test*", "git diff*"], "deny": ["git push*"] } },
  "hooks": { "afterEdit": "pnpm tsc --noEmit", "onStop": "pnpm test" },
  "sandbox": "bwrap",
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  },
  "workflows": {
    "careful": {
      "name": "careful",
      "freshContextPerStep": true,
      "phases": [
        { "phase": "plan", "gate": true },
        { "phase": "execute" },
        { "phase": "verify" },
        { "phase": "review" },
        { "phase": "finish" },
      ],
    },
  },
  "limits": { "maxTurns": 60, "timeoutMs": 3600000 },
}
```

`outputDir` is where a chat saves the files it creates (default in the terminal app: `$CDR_OUTPUT_DIR` or `~/Documents/CDR`, one subfolder per chat); `false` writes new files into the project. `cdr serve` (web and desktop) and other front ends leave it unset until you configure it. See [docs/cli.md](cli.md).

`verify` commands are auto-detected (package.json scripts, pyproject, Cargo, go.mod, Makefile) when not configured. JSON schema: [packages/protocol/schema/config.schema.json](../packages/protocol/schema/config.schema.json).

There is no default token or cost cap. Optional `limits.maxTokens` and `limits.maxCost` are local limits for each run, separate from your provider balance. Token usage adds input and output across every model call, including context sent again; it is not the model's context-window size. Set a positive limit to opt in, or `0` to disable a limit inherited from another config. The default limits are 150 turns per agent and three hours of active work per run, enough for long jobs such as a 1:1 recreation followed by component generation; compaction (below) keeps each turn of such a job about as cheap as an early one.

### Context size and compaction

Every model call resends the agent's whole working context, and later tokens cost more to generate than earlier ones, so a smaller context means lower spend per turn. `context` controls how large it may grow:

| Key             | Default | Meaning                                                                                                                                                                            |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxContext`    | `64000` | Token budget for one agent's context. Compaction starts at `compactAt` × min(model context window, `maxContext`), so about 45K tokens by default. `0` uses the model window alone. |
| `compactAt`     | `0.7`   | Fraction of the budget at which the agent compacts.                                                                                                                                |
| `keepRecent`    | `6`     | Most recent messages kept word for word.                                                                                                                                           |
| `maxToolOutput` | `20000` | Characters per tool result. It is also capped at a quarter of the context budget.                                                                                                  |

Compaction runs before a model call once the context, measured from the provider's reported input tokens, passes the threshold. It first trims old tool output and drops old images. When that is enough, no model call is made. Otherwise the summarizer model replaces older history with an execution brief: the objective, established facts, applied changes, verification, dead ends, user instructions and the remaining plan. The system prompt, the task and the recent messages stay as they were. A later compaction updates the earlier brief instead of summarizing it again. Loaded skill instructions (`load_skill` results) are never trimmed and are carried into the brief word for word, and the brief keeps run ids and the current stage of multi-stage jobs. Removed raw history is appended (with secrets redacted) to `.harness/history/<session>-<agent>.log`, which the agent can search with `grep` or `read_file`. Read-only sessions keep no log. Each compaction emits a `context.compacted` event, shown as a single line in the CLI, TUI and web UI.

The 64K default leaves room for recreate's measurement images and section markup in the recent messages. `48000` is cheaper and was safe for frontier models in the NVIDIA study; small local models with verbose output may need more. Use `cdr eval --max-context` to check a value.

Project rules come from `AGENTS.md` / `CLAUDE.md` (project and parent dirs); memory from `.harness/memory/*.md` and `~/.harness/memory/*.md` (the agent adds facts with `remember`, corrects one with `remember` + `replaces`, and removes one with `forget`). Facts that look like secrets are refused. In `ask` mode, writes to user-wide memory need approval; project memory is written without asking.

Skills come from `.harness/skills/`, `~/.harness/skills/`, any folders in `skills.paths`, and the built-in set. `skills.disabled` hides skills by name, and `"skills": { "enabled": false }` turns them off. See [skills.md](skills.md).

## Checkpoints

Before every turn CDR snapshots the project's files into a separate git repository under `~/.harness/checkpoints/` (it never touches the project's own git history, index or branches). Any change is covered, including edits and deletions made through shell commands. Restoring a checkpoint (web: **Restore files to here** on a message; CLI: `/rewind`) first snapshots the current files, so every restore can be undone.

Snapshots honor the project's `.gitignore` and leave out `node_modules/`, virtualenvs, build caches and `.harness/`, except recreation outputs in `.harness/recreate/*/` (without the capture and measure artifacts). Environment files (`.env`, `.env.*`) are never captured, since they usually hold secrets. Files that are left out are never changed by a restore. Checkpoints are off for subagents, read-only sessions, sessions rooted at the home directory, and projects with more than 50,000 files their own git does not track (all files, outside a git repository). `"checkpoints": { "enabled": false }` turns them off.

## Unsplash photos for generated pages

Set `UNSPLASH_ACCESS_KEY` to your Unsplash application's Access Key. `UNSPLASH_SECRET_KEY` is optional and is not used for public photo search. Both credentials stay out of shell-tool environments and are redacted from session events.

When a page needs photography, CDR can use `search_unsplash` (query, optional orientation and 1–10 results), then `use_unsplash_photo` for each image it selects. Search returns image URLs, alt text, dimensions, and photographer credits. The agent embeds the returned CDN URLs and adds visible attribution links; selecting a photo records its use with Unsplash, following the [Unsplash API guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines). The generated page needs no API key. Missing keys, rate limits, and network errors return actionable tool errors rather than stopping the whole job.

`recreate` configures the 1:1 page recreation: whether it is enabled, the asset and font policies, robots.txt, localhost captures, budgets, gates, the model per stage, extra emitters and the capture driver. See [recreate.md](recreate.md#configuration).

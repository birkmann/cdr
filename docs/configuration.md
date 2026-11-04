# Configuration

`cdr.config.json` in the project (or `.cdr/config.json`), merged over `~/.harness/config.json` and the defaults. Legacy `morrow.config.json`, `.morrow/config.json`, `harness.config.json` and `.harness/config.json` are still read when no CDR config exists. `cdr init` preserves an existing config instead of creating a competing file.

Saved sessions, tokens, and project artifacts retain their existing `.harness` locations. `CDR_HOME` can override the global directory; `MORROW_HOME` and `HARNESS_HOME` remain supported, in that priority order after `CDR_HOME`. Internal `@harness/*` package imports are unchanged.

Example configuration:

```jsonc
{
  "models": {
    "executor": "deepseek/deepseek-flash",
    "planner": "deepseek/deepseek-v4-pro",
    "reviewer": "deepseek/deepseek-v4-pro",
    "summarizer": "local/qwen3.8:latest"
  },
  "providers": {
    // built in: deepseek, ollama (cloud), local (Ollama on :11434), openrouter, anthropic
    "lmstudio": { "type": "openai-compatible", "baseURL": "http://localhost:1234/v1",
                  "models": { "my-model": { "tools": false, "contextWindow": 32000 } } }
  },
  "verify": { "build": "pnpm build", "test": "pnpm test", "lint": "pnpm lint", "maxAttempts": 3 },
  "permissions": { "mode": "ask", "bash": { "allow": ["pnpm test*", "git diff*"], "deny": ["git push*"] } },
  "hooks": { "afterEdit": "pnpm tsc --noEmit", "onStop": "pnpm test" },
  "sandbox": "bwrap",
  "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } },
  "workflows": { "careful": { "name": "careful", "freshContextPerStep": true,
                  "phases": [{ "phase": "plan", "gate": true }, { "phase": "execute" }, { "phase": "verify" }, { "phase": "review" }, { "phase": "finish" }] } },
  "limits": { "maxTurns": 60, "timeoutMs": 3600000 }
}
```

`verify` commands are auto-detected (package.json scripts, pyproject, Cargo, go.mod, Makefile) when not configured. JSON schema: [packages/protocol/schema/config.schema.json](../packages/protocol/schema/config.schema.json).

There is no default token or cost cap. Optional `limits.maxTokens` and `limits.maxCost` are local limits for each run, separate from your provider balance. Token usage adds input and output across every model call, including context sent again; it is not the model's context-window size. Set a positive limit to opt in, or `0` to disable a limit inherited from another config. The default limits remain 60 turns per agent and one hour of active work per run.

Project rules come from `AGENTS.md` / `CLAUDE.md` (project and parent dirs); memory from `.harness/memory/*.md` and `~/.harness/memory/*.md` (the agent can add facts with the `remember` tool).

## Unsplash photos for generated pages

Set `UNSPLASH_ACCESS_KEY` to your Unsplash application's Access Key. `UNSPLASH_SECRET_KEY` is optional and is not used for public photo search. Both credentials stay out of shell-tool environments and are redacted from session events.

When a page needs photography, CDR can use `search_unsplash` (query, optional orientation and 1–10 results), then `use_unsplash_photo` for each image it selects. Search returns image URLs, alt text, dimensions, and photographer credits. The agent embeds the returned CDN URLs and adds visible attribution links; selecting a photo records its use with Unsplash, following the [Unsplash API guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines). The generated page needs no API key. Missing keys, rate limits, and network errors return actionable tool errors rather than stopping the whole job.


# Terminal (CLI)

The `cdr` command runs the harness in your terminal: a full-screen workspace for conversations and tasks, plus one-shot commands for scripts and CI.

```bash
cdr                                   # interactive session in the current directory
cdr run "add a /hello endpoint"      # plan → approve → execute → verify → review → report
cdr run "fix the failing test" -w quick-fix --yes
cdr plan "migrate to ESM"             # plan only, no edits
cdr review                            # review the current git diff
cdr resume <session-id>               # continue a session
cdr serve                             # HTTP + SSE server for frontends (prints a token once)
cdr models --remote                   # configured roles + models the providers offer
cdr init                              # cdr.config.json + AGENTS.md for this project
cdr eval --model deepseek/deepseek-flash
```

Useful flags: `-m provider/model` (all roles), `--executor/--planner/--reviewer`, `--mode ask|auto|yolo`, `--no-plan`, `--commit` (commit on a `harness/<slug>` branch), `--json` (JSONL events on stdout), `-v`.

`cdr` opens a full-screen terminal workspace with a custom wordmark, graphite and lime styling, a multiline composer, streaming conversation, tool diffs, and a workspace sidebar on wide terminals. Type naturally or use `/run`, `/quick`, `/plan`, and `/review`.

Each mode has its own accent: Chat is teal, Build lime, Plan blue, Quick fix gold, and Review purple. Thinking animates while the model is working, even between streamed updates. Plan-only mode produces a plan; select Build to implement it and create a runnable preview.

| Shortcut | Action |
| --- | --- |
| **Enter** / **Ctrl+J** | Send / insert a newline |
| **Tab** / **Shift+Tab** | Next / previous task mode |
| **Ctrl+P** or **/** | Search commands |
| **Ctrl+O** | Choose a model; **Ctrl+F** inside discovers provider models |
| **Ctrl+R** | Resume a saved conversation |
| **↑/↓** | Move through multiline input or prompt history |
| **PageUp/PageDown** | Scroll the conversation |
| **Ctrl+T** / **Ctrl+B** | Toggle tool and reasoning details / workspace sidebar |
| **Esc** / **Ctrl+C** | Cancel a running turn |
| **Ctrl+D** | Exit and restore the shell |

Approval dialogs support keyboard selection; plans can be edited before approval. Bracketed paste keeps multiline text in the draft until you send it. Use `cdr --plain` for the simple text interface with Tab command completion and `\` multiline continuation. Pipes, `--json`, and dumb terminals use the text interface automatically.

In approval dialogs, use arrow keys or Tab to select and Enter to confirm. Permission shortcuts **1**, **2**, and **3** immediately choose Allow once, Always, and Deny. The run timeout (`limits.timeoutMs`, one hour by default) counts active work; waiting for permissions, plan decisions, or answers pauses it. The terminal displays **Waiting for you** and pauses its elapsed timer until you respond.

- `/model provider/model` switches all roles, with changes saved to the session. `/models` lists configured models; `/models remote` discovers provider models.
- `/mode ask|auto|yolo` changes and persists permissions.
- `/attach path` attaches a project file or image to the next chat/task. `/attachments clear` removes pending files.
- `/new`, `/sessions`, and `/resume <id>` manage conversations without restarting the CLI. `/new` in a sandbox creates a fresh sandbox with the same confinement policy. Resume restores the transcript and prompt history.
- `/continue` continues the last failed or stopped job in the same session. It reuses the approved plan and executor context, restores the checklist, preserves files, and starts a fresh run budget. The web app exposes the same action as **Continue job** above the composer. Unapproved plans still require approval; verification and review run again as configured.
- `/status`, `/cost`, `/diff`, and `/clear` show context, usage, changes, and a fresh terminal screen.
- `/help` lists all commands. Streaming output, tool results, diffs, elapsed time, permissions, and cancellation work in the terminal; `--json` keeps stdout as machine-readable events.

Without installing a global command, run `pnpm cdr` for the console or `pnpm cdr serve` for the web app.

Starting a new session from your home directory, the filesystem root, or CDR's sandbox container creates a fresh sandbox automatically. Starting inside a project keeps that project as the workspace. Files and previews stay within that workspace. Older sessions rooted in a home directory show only successfully edited files and the folders containing their published previews, rather than listing your home directory. Existing files are not moved.

## Installing the command and credentials

Optionally link the binary: `pnpm --filter @harness/cli link --global` → `cdr` (the `harness` alias still works).

From a fresh terminal, use `cdr` after linking, or change into this repository and run `pnpm cdr`. If the linked command is not found, ensure pnpm's global binary directory is on your `PATH`. After updating the repository, run `pnpm build`, restart `cdr serve` when its jobs have finished, and refresh the browser to load the new UI and server behavior.

See [.env.example](../.env.example) for provider and optional Unsplash credentials. Copy it to `.env` only if you do not already have one; otherwise add the missing variables to your existing file. To make credentials available when starting CDR from any directory, put them in `~/.harness/.env` (or `$CDR_HOME/.env`). Existing shell variables take precedence. `cdr serve` also loads the launch directory's `.env` for new web sandboxes. Restart the server after changing keys.

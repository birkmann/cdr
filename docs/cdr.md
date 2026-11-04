# CDR

CDR is the product name for this provider-independent coding workspace. The console command is `cdr`; the web app is served by `cdr serve` (also `cdr web`). The `harness` binary, internal package names, existing event logs, and data directories remain compatible.

## Reference review

The local `opencode-dev` checkout was inspected as a reference, particularly:

- `packages/tui/src/mini/prompt.shared.ts`: draft/history navigation and command handling.
- `packages/tui/src/mini/footer.command.tsx`: discoverable commands, model selection, keyboard navigation.
- `packages/tui/src/mini/turn-summary.ts`: agent/model/duration summaries.
- `packages/tui/src/config/keybind.ts`: terminal command and input shortcuts.
- `packages/tui/src/routes/home.tsx`, `mini/splash.ts`, and `mini/theme.ts`: full-screen welcome layout, branding, and terminal colors.

CDR implements its own full-screen terminal interface in `packages/cli/src/tui`. The welcome screen uses an original block wordmark, graphite background, and mode-colored composer (lime for Build, blue for Plan). Conversations render streamed messages, code blocks, tool results, diffs, workflow phases, usage, and tasks. Wide terminals show a workspace sidebar; smaller terminals keep the conversation and composer. Command, model, and session pickers are searchable. Permission, question, and plan dialogs connect to the existing session APIs, including editing a plan before approval.

The terminal and web clients use the same event reducer. Input editing, scrolling, pickers, and other presentation state stay in the terminal client. Model and permission changes are persisted as session events. The terminal renderer sanitizes untrusted escape sequences, handles bracketed paste without submitting its contents, repaints changed rows, responds to resizing, and restores raw mode and the alternate screen when it exits. `--plain`, piped input, and JSONL output retain the simpler console.

This is not a claim of full OpenCode feature parity: CDR does not yet have LSP integration or its plugin ecosystem. Model quality is determined by the configured provider and model. Automated validation uses mock providers; no model-quality benchmark is implied.

## Terminal shortcuts

Use Enter to send and Ctrl+J for a newline. Tab cycles Chat, Build, Plan, Quick fix, and Review. Ctrl+P opens commands, Ctrl+O models, and Ctrl+R saved conversations. Ctrl+F in the model picker discovers provider models. PageUp/PageDown scroll, Ctrl+T expands tool output and reasoning, and Ctrl+B toggles the sidebar. Esc cancels a turn or closes a dialog. Ctrl+C cancels a running turn, clears an idle draft, or exits when idle with no draft. Ctrl+D exits. `/attach path` adds a project file or image to the next turn.

## Web experience

The supplied Claude screenshot informed the narrow sidebar, sans-serif greeting, generous central workspace, and restrained composer. The default Graphite palette follows the supplied DeepSeek usage screenshot: neutral charcoal backgrounds, lighter gray cards, bright text and primary buttons, and lime accents. CDR has its own angular C-and-cursor mark, monospace wordmark, and name. Navigation connects to real session and project data; the Creations view derives entries from persisted `preview.ready` events. No generated sample history or fake artifact thumbnails are shown.

Settings → Appearance offers Graphite (the default), Paper light, Midnight, Forest, High contrast, and a System option. Theme changes apply immediately, persist across reloads, and load before the first paint. System mode follows device changes. Main text, secondary text, accents, and code comments are checked for at least 4.5:1 contrast against their relevant surfaces in the browser suite.

On desktop, drag the sidebar edge or the divider between chat and details to resize the columns. Widths are saved in this browser. Focus a divider and use Left/Right (Shift for larger steps), Home/End for the limits, or Enter to reset; double-click also resets. Narrow screens retain the stacked layout and mobile navigation drawer.

Opening a conversation loads its saved history as one snapshot, then subscribes to events after that snapshot's cursor. Saved tokens and workflow phases do not replay on screen. The last eight visited threads are cached in memory per authenticated client and refreshed with only newer events; live events are rendered in short batches. Scroll position and the selected details tab are kept in this tab's session storage across navigation and reloads. Conversation content is not written to browser storage.

Conversations automatically follow short updates while you are at the bottom. Following pauses when a response grows beyond roughly two-thirds of the reading area, or when you scroll back, so long answers and plans do not lose their opening lines. Jump to latest resumes following compact updates; Review plan jumps to the beginning of the pending plan. These controls are centered and anchored at the bottom of the message area, with reserved space so they never cover conversation text or shift the composer when they appear or disappear.

Each request shows a compact animated activity row by default. View steps expands its intermediate messages, reasoning, tools, phases, verification, and review results; each thread remembers its expanded sections. The final answer and latest preview cards remain outside that disclosure, as do errors, failed outcomes, and major review findings. Pending approvals and questions always remain visible. The details panel starts closed for a new conversation and opens when a preview is published.

Within the expanded steps, thinking can be opened to read formatted Markdown and code from the beginning. Its Jump to latest control explicitly enables live following; scrolling back pauses it. Completing a response preserves your expansion choice. Keyboard focus indicators and reduced-motion preferences are supported.

Both clients operate on the same core sessions and events. UI preferences (theme, navigation, search) stay in the browser. Model and permission changes use `session.settings`; the CLI no longer mutates permission state without recording an event. Existing generated-page preview isolation is retained.

Terminal and web processes tail the same session log. An open browser conversation receives terminal messages, tool results, tasks, and published previews live, without replaying its existing history; the Files panel refreshes when the run finishes. A running session stays controlled by its originating process, so approvals and cancellation remain in that terminal while the browser mirrors its output. After it finishes, the same conversation can be continued from the browser. Both processes must use the same `HARNESS_HOME` (normally `~/.harness`). A completed Plan-only run is labelled Plan ready: it produces a plan, not an app or HTML preview.

The composer’s Thinking control sets effort for new and existing conversations. DeepSeek Flash and V4 on the official API offer Default, Off, Low, High, and Max, following [DeepSeek’s thinking parameters](https://api-docs.deepseek.com/guides/thinking_mode/). Default sends no override; Off sends `thinking.type: "disabled"`; other levels enable thinking and set `reasoning_effort`. The selection is persisted in session events and restored after restart. Changes are disabled during a run. Higher effort can take longer and consume more tokens; it does not raise or lower CDR’s run limits.

Other OpenAI-compatible models can opt in through `providers.<id>.models.<model>.reasoningEfforts` (for example `["low", "medium", "high"]`) when their API supports `reasoning_effort`. Unrecognised models and the native Anthropic adapter currently keep provider defaults. Supported workflow models receive the session preference; unsupported models receive no override. `reasoningEffort` is also available in project configuration and the session creation/settings API. Changing the model in the web UI resets effort to Default.

The first preview waits for the agent to publish it or finish the turn, showing a building state while HTML, styles, and scripts are still being created. Previews refresh automatically when the agent publishes a version, including when it republishes the same HTML path. File edits and successful shell commands mark the preview as needing an update; without a publication, it refreshes once the turn finishes. A status row explains when changes are in progress or a refresh has completed. Turn off Auto-refresh to preserve an interactive game's or form's current state; a visible Refresh preview button appears when new changes are available. Reload remains available in the toolbar.

Embedded previews remain isolated from CDR's browser storage. If the sandbox blocks `localStorage` or `sessionStorage`, a compatibility script supplies in-memory storage before page scripts run, preventing saved preferences from breaking the rest of the page. That fallback resets on reload; opening the preview in a new tab uses normal browser storage. Generated source files are unchanged.

Failed or stopped jobs show a Continue job card above the web composer. `/continue` provides the same action in both terminal interfaces. The server endpoint is `POST /sessions/:id/continue`, exposed as `client.continueJob(id)` and `useSession().continueJob()`. Continuation restores the original task, approved plan, executor context, checklist, and earlier file diffs from the event log. It instructs the executor to inspect current files and finish remaining work before rerunning configured verification and review. Each attempt gets a fresh budget and a separate report; permissions still apply. Rejected plans are not treated as approved. Failed chat turns continue their chat context. Recovery works after restarting CDR and reopening the saved session; successful or already-running jobs cannot be continued.

## Run and verify

```bash
pnpm build
pnpm cdr               # full-screen terminal workspace
pnpm cdr --plain       # simple text console
pnpm cdr serve         # web app; open the printed login link
pnpm test
pnpm lint
pnpm --filter web test:e2e
```

The browser suite exercises sandbox creation, live previews, file/image attachments, approvals, diffs, search, project navigation, renaming, themes, sidebar collapse, deletion, and mobile overflow. CLI subprocess tests cover permissions, resume, model changes, multiline indentation, attachments, final input at EOF, and JSON output. Terminal tests cover responsive rendering, Unicode editing, safe paste, escape-sequence sanitization, model selection, session replay, permission decisions, cancellation, plan editing, questions, and terminal restoration. A real PTY smoke check also exercises startup, pickers, file-edit approval, streamed replies, resizing, safe paste, and exit with a mock provider.

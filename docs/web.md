# Web app

```bash
pnpm build
cdr serve        # or: node packages/cli/dist/bin.js serve
# → Open the app: http://127.0.0.1:8787/#token=…   (click the printed link)
```

The server hosts the web UI ([apps/web](../apps/web)) and logs you in through the link. The default Graphite theme uses neutral charcoal surfaces, bright text, and signal-lime accents. Settings → Appearance also offers Paper light, Midnight, Forest, High contrast, and System. Themes persist across reloads. The sidebar can collapse, and the layout adapts to mobile.

**Keyboard:** Ctrl/Cmd+K opens searchable conversations and commands; Ctrl/Cmd+B toggles the sidebar; Ctrl/Cmd+Shift+O starts a new conversation. Search supports arrow keys, Enter, and Escape.

**Navigation:** Projects opens known folders, Conversations searches saved chats, and Creations lists previews recorded in the 40 most recent conversations. Click a conversation title to rename it; finished responses can be copied. Existing chat history and browser settings remain available.

You also get:

- **sandboxes**: if you don't pick a project, the chat gets a fresh workspace in `~/.harness/sandboxes/<name>` (git-initialised, Auto permissions, shell confined with bubblewrap when available) – e.g. "create a snake game for me";
- **compact activity**: one animated status row per request; click **View steps** to inspect intermediate messages, thinking, tools, and checks. Final answers, errors, approvals, and preview cards stay visible;
- a **live preview**: the first preview waits for publication or the turn to finish. Published versions refresh automatically; other file changes refresh at the end of the turn. Turn off **Auto-refresh** to preserve a game or form's current state, or use **Reload** / **Open in a new tab**;
- a home screen with a big composer: choose **New sandbox** or a **project folder** (recent projects or a folder browser), **mode** (Chat, Plan & build, Quick fix, Plan only, Review), **model** (anything your providers offer) and **permissions** (Ask / Auto / Full access);
- **attachments**: paste screenshots, drag & drop or pick files – images go to the model (vision models; others get a note), text files are inlined, everything is saved under `.harness/attachments/`;
- **stable chat history**: threads load as a snapshot instead of replaying their tokens and phases. Recent threads are cached in memory; reading position, expanded steps, and the selected panel tab are restored;
- **comfortable reading**: short updates follow automatically while you are at the bottom; long answers and manual scrolling pause following. **Jump to latest** is centered at the bottom of the message area, clear of the text, with stable space so the input does not shift;
- **resizable columns**: drag the sidebar edge or chat/details divider. Widths are remembered; focused dividers support arrow keys, Home/End, and Enter to reset, or double-click to reset;
- a **code panel** with the live preview, changes made in the conversation, project diff, files scoped to the session workspace, and the agent's task list;
- **job recovery**: **Continue job** resumes failed or stopped work from saved progress in the same workspace, with a fresh run budget.

## Connected terminal and web sessions

Start a job in the terminal and open its conversation in the browser to see messages, tool results, tasks, changes, and published previews live. Both processes must use the same data directory (`~/.harness` by default, or the same `CDR_HOME` / `HARNESS_HOME`). While a terminal job is running, answer approvals and cancel it in that terminal. Once it finishes, continue the conversation from either interface. A completed Plan-only run is shown as **Plan ready**, with no implication that an app has already been built.

## Thinking effort

The web composer's **Thinking** control sets reasoning effort for new or existing conversations and saves the choice with the session. Available levels depend on the model; supported DeepSeek models offer Default, Off, Low, High, and Max. Default leaves the provider's behavior unchanged. Other OpenAI-compatible models can declare supported levels in `providers.<id>.models.<model>.reasoningEfforts`; unsupported models retain their defaults. Higher effort may take longer and use more tokens, but does not change run limits. Model changes reset effort to Default, and effort cannot be changed during a run. See [docs/cdr.md](cdr.md) for provider configuration details.

## Preview storage

Generated pages run in an isolated iframe. When that sandbox blocks `localStorage` or `sessionStorage`, CDR supplies in-memory storage before page scripts run so saved preferences do not crash the page. Embedded storage resets on reload; opening the page in a new tab uses normal browser storage. Generated source files are not modified.

API keys are read from the environment, a `.env` in the project, or `~/.harness/.env` (global). For UI development: `cdr serve` in one terminal, `pnpm --filter web dev` in another, open http://127.0.0.1:5173/#token=… (Vite proxies the API).

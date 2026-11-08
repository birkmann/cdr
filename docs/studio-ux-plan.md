# Studio UX plan: chat-first shell with a per-project code view

Status: implemented · Scope: `apps/desktop` and one read-only command in `crates/` (no protocol or core changes). See [Implementation notes](#implementation-notes) for where the build differs from the plan below.

## Problem

CDR Studio today boots into a VS Code clone: activity bar, file explorer, editor, with the agent
squeezed into a dockable side panel. That layout answers "where are my files?" but not the questions
a harness user actually starts with:

- **What is the agent doing right now, and in which project?**
- **Which conversations do I have, and which ones need me?**
- **What changed — branch, diff, running subagents — because of this conversation?**

Conversations are the primary object in the harness (sessions with a `projectPath`, optionally a
sandbox), but the UI treats them as an accessory of the editor. The result: chat history is hidden
behind the conversation-name dropdown in the agent panel, project context (folder, repo, branch,
changes, agents) is scattered across the title bar, Git panel, Agents view and status bar, and the
user has no single place that answers "what's going on?".

## Goal

Make the structure legible left-to-right and put focus on the current task:

1. **Chat view** (the default): *conversations → active conversation → its project context*.
2. **Code view** (per project, on demand): *files → editors/preview → chat about those files*.

Both views are the same window, same harness session state, same tabs — only the arrangement
changes. Everything stays a render of harness events (AGENTS.md rule: no UI-only state in core; all
of this lives in `apps/desktop`).

---

## Information architecture

```
Project (a folder/repo, or "no project" = sandbox under ~/.harness/sandboxes/)
  ├─ Conversations (harness sessions; projectPath, parentSessionId for subagents)
  │    ├─ Messages / events
  │    ├─ Running agents & subagents
  │    └─ Preview / published output
  ├─ Repo state: branch, changes, worktrees, PRs
  └─ Goals
```

- A **conversation belongs to at most one project** (its `projectPath`); sandbox conversations
  belong to "No project". `sessions.ts` (`inFolder`, `switcherSections`) already models this.
- The **project is the unit you zoom into**: selecting a conversation selects its project; opening
  the code view opens that project's folder as the workspace.
- **Subagents never appear in the conversation list**; they appear under their parent (as today in
  the Agents view) and in the project rail.

## View 1 — Chat view (default)

Three columns, left to right: *what exists → what I'm working on → what it touches*.

```
┌──────────┬──────────────────────────────────────────────┬──────────────────────┐
│ CONVOS   │  ⌂ project / Conversation title              │ PROJECT              │
│          │                                              │  📁 folder  [Code ▸] │
│ 🔍 search │  ┌────────────────────────────────────────┐  │  ⎇ branch     ⌄      │
│ [+ New]  │  │  conversation thread                   │  │  ✚ Commit  +12 −3    │
│          │  │  (messages, tool calls, approvals,     │  │                      │
│ Working 2│  │   plan cards, preview card)            │  │ AGENTS · 2 running   │
│ ● fix…   │  │                                        │  │  ✳ subagent-a   25s  │
│ ● docs…  │  └────────────────────────────────────────┘  │  ✳ subagent-b   19s  │
│          │                                              │                      │
│ Waiting 1│  ┌────────────────────────────────────────┐  │ CHANGES              │
│ ◐ review │  │ composer  @context /skills             │  │  M src/foo.ts        │
│          │  │               model · effort      [↑]  │  │  A docs/bar.md       │
│ Settled  │  └────────────────────────────────────────┘  │                      │
│ ✓ …      │                                              │ GOALS · PREVIEW      │
└──────────┴──────────────────────────────────────────────┴──────────────────────┘
```

### Left column — conversation list

- Every top-level conversation across all folders and sandboxes (what `switcherSections` returns
  today), **grouped by attention, not only by date**:
  - **Working** — a turn is running (spinner, elapsed time).
  - **Waiting** — blocked on the user: permission request, question, plan approval. This is the
    approvals inbox folded into the list; badge count on the group header.
  - **Settled** — everything else, grouped by date as today.
- Each row: project badge (folder basename, colored chip; "sandbox" chip for no-project), title,
  branch if not the default, relative time, status icon.
- Top: search box, filter by project, **[+ New]**. New conversation opens the existing "Work in"
  picker (current folder / recent folders / new sandbox / open another folder).
- Selecting a row loads it in the center column. Ctrl/middle-click still opens it as an editor tab
  in code view (today's behavior from the Agents view).

### Center column — the conversation

- Reuses the existing chat components (`ChatTab` content / `@web` `ChatView`, composer, approvals,
  plan dialogs, preview card). This is the `AgentPanel` body promoted from a 460 px side panel to
  the main stage.
- Header is a breadcrumb: `project / conversation title` (click project → filters left list; click
  title → rename). Right side of the header: Stop, open-as-tab (jump into code view), history.
- Empty state (no conversation selected) is the current Welcome/"What should we do?" composer with
  the Work-in picker — the screenshot's home screen, kept.

### Right column — project rail (context of the *selected conversation's* project)

Collapsible sections, all read-only renders of state we already fetch, with one-click jumps into
the code view for anything deeper:

1. **Project**: folder name + path, "Open in Code view ▸", open-in-system-file-manager.
2. **Repo**: current branch (switcher), sync state, commit summary line (`+12 −3`),
   **Commit…** button → opens code view's Git panel (or inline mini-commit later).
3. **Agents**: running/waiting agents *of this project* with elapsed time, model, token cost, stop
   buttons (data already in `AgentsView`/`useWorkspaceSessions`). Subagents indented under parent.
4. **Changes**: the working-tree file list (from `st.status`), click → opens the diff as a tab in
   code view.
5. **Goals**: this project's goals and their status; click → goal page.
6. **Preview**: the conversation's published preview, "Open preview".

For a conversation whose project is **not** the currently opened workspace, phase 1 shows the
sections that don't need git status (project, agents, preview) plus an "Open this project" action;
full repo/changes sections light up once we can query status for a non-open folder (see phases).

## View 2 — Code view (per project)

This is today's shell, kept almost as-is, but entered *from* a project instead of being the app:

```
┌──┬─────────┬──────────────────────────────────┬──────────────────────┐
│A │ FILES   │  tabs: file │ diff │ preview     │ CHAT (this convo)    │
│c │         │ ┌──────────────────────────────┐ │  thread…             │
│t │ src/    │ │ editor / markdown preview /  │ │                      │
│i │  foo.ts │ │ browser preview / diff view  │ │                      │
│v │ docs/   │ │                              │ │  ──────────────      │
│i │         │ └──────────────────────────────┘ │  composer            │
│t │         │  terminal / problems / log       │  @ current file      │
└──┴─────────┴──────────────────────────────────┴──────────────────────┘
```

- **Left**: activity bar + explorer/search/git/history — unchanged.
- **Center**: editor tabs, splits, bottom panel — unchanged.
- **Right**: the agent panel, docked right **by default and treated as the conversation column**,
  continuing whatever conversation was selected in chat view. "@ Context" keeps attaching the
  current file / diff / problems. (The left-dock option remains, but right is the documented
  default so the "chat is always the column nearest the chat view" rule holds.)
- The **Agents** and **Goals** activity-bar views move to chat view surfaces (left list groups and
  the project rail / goal pages). The activity bar slims to Files, Search, Git(+History). The
  approvals inbox lives in the chat view's Waiting group; code view keeps inline approval prompts
  in the chat column plus the badge.

### Switching between the views

- **Top-level toggle** in the title bar: `[ Chat | Code ]` segmented control (plus shortcut, see
  below). Code is enabled when the selected conversation has a project (sandboxes open their
  sandbox folder, as the explorer already does via `useFollowConversationFolder`).
- Entering code view from a conversation opens that conversation's folder as the workspace (reuse
  `openFolder`'s path) and shows the conversation in the right column.
- Leaving code view back to chat view **keeps all tabs and the workspace alive** — it's a layout
  switch, not a navigation; unsaved editors stay open.
- Deep links that imply code view (open file, open diff, split, commit) switch to it automatically;
  the back toggle is always one click.

## State & component mapping

New store state (persisted in the existing `LAYOUT_KEY` blob):

```ts
export type ShellMode = "chat" | "code";
mode: ShellMode;                    // default "chat"
setMode(m: ShellMode): void;
selectedSessionId: string | null;   // chat view selection (center + rail follow it)
railCollapsed: Record<string, boolean>;
```

| Piece | Source | Fate |
|---|---|---|
| `Shell.tsx` | exists | becomes mode switch: renders `ChatShell` or `CodeShell` (today's body) |
| `ChatShell.tsx` | **new** | 3-column grid + splitters (`usePanelSize` for both rails) |
| `ConversationList.tsx` | **new** | built on `sessions.ts` `switcherSections` + attention grouping; reuses `SessionSwitcher` row rendering |
| Center conversation | exists | `ChatTab` / `AgentPanel` body extracted into `Conversation.tsx` used by both views |
| `ProjectRail.tsx` | **new** | composes data from `useWorkspaceSessions`, `st.status`, goals list, preview state |
| `AgentsView` / `GoalsView` | exist | data hooks extracted; side-panel versions retired from the activity bar after phase 3 |
| `TitleBar` | exists | gains the Chat/Code toggle + project name; repo/branch controls show in code view only (they live in the rail in chat view) |
| `Welcome` | exists | becomes chat view's empty state |

Attention grouping ("Waiting") derives from the same signals `useApprovals` and the session event
stream already expose — no new core state, just a selector in `apps/desktop`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Ctrl+Shift+U (new) | toggle Chat / Code view |
| Ctrl+L | chat view: focus composer · code view: toggle chat column (as today) |
| Ctrl+R | conversation switcher — now simply focuses the left list with search |
| Ctrl+P / Ctrl+Shift+P | unchanged; file quick-open jumps to code view |
| Ctrl+Shift+E/F/G | jump to code view with that side panel |
| Ctrl+Shift+A / J | chat view surfaces (agents group / goals section) instead of side panels |

## Implementation phases

Each phase ships on its own; nothing breaks mid-way.

**Phase 1 — mode switch + chat shell skeleton.**
`ShellMode` in the store (default `chat`, `code` for existing users with an open workspace on first
run so nobody is surprised), title-bar toggle + shortcut, `ChatShell` with: conversation list
(reusing `switcherSections`, date grouping only), center conversation (extracted `Conversation.tsx`),
no rail yet. Welcome as empty state. *Exit criteria: start app → chat view; pick conversation →
chat; toggle → exact current shell.*

**Phase 2 — project rail.**
Rail with Project / Agents / Preview sections for any conversation, Repo + Changes + Goals sections
when the conversation's project is the open workspace. "Open in Code view" wired. Splitter +
persistence. *Exit: the T3-style right rail works for the active project.*

**Phase 3 — attention grouping + approvals in the list.**
Working / Waiting / Settled groups, status icons, waiting badge; OS notification click selects the
conversation in chat view. Agents activity-bar view folded into list + rail (view stays behind a
setting for one release).

**Phase 4 — cross-project repo state.**
Rust side (`studio-git`) gains a cheap `status --porcelain` + branch query for an arbitrary path so
the rail is complete for non-open projects; conversation rows can then show branch + change counts.
This is the only phase that touches `crates/`.

**Phase 5 — polish & convergence.**
Code view defaults (chat docked right, slimmed activity bar), goals pages reachable from the rail,
remove retired side panels, docs (`docs/desktop.md`) + screenshots, e2e flows.

## Risks / open questions

1. **Conversations as editor tabs** (`kind: "chat"`) overlap with chat view. Proposal: keep them —
   in code view they're how you watch two conversations side by side; chat view always shows the
   *selected* one. Revisit multi-conversation layouts in chat view later (e.g. split center).
2. **Git status for many projects** (phase 4) must stay cheap: status on selection only, watcher
   only for the open workspace.
3. **One window, one workspace** stays the model; the chat view merely *reads across* projects.
   True multi-root is out of scope.
4. **Sandboxes**: "No project" rows get the sandbox chip; code view opens the sandbox folder
   (existing explorer behavior), so nothing is a dead end.
5. **Where does the terminal live in chat view?** Not shown by default; "run in terminal" events
   switch to code view. Alternative (bottom drawer in chat view) deferred.

## Testing

- Unit: attention grouping selector, mode persistence/migration of `LAYOUT_KEY`, rail section
  visibility matrix (open-workspace vs other-project vs sandbox) — `apps/desktop/src/*.test.ts`.
- e2e (desktop): launch → chat view; new conversation via Work-in picker; toggle to code view keeps
  tabs; approval appears in Waiting group and in rail; back-compat: existing layout blob without
  `mode` defaults sensibly.

## Implementation notes

All five phases shipped. The result differs from the plan above in these places, each for a reason found while building it:

| Plan | Built | Why |
|---|---|---|
| `ChatShell`, `CodeShell` and a shared `Conversation.tsx` | One tree in `Shell.tsx`; `mode-chat` hides the code panels with CSS | Separate shells would unmount editors and kill terminals on every switch. The agent panel keeps its place, so a conversation never remounts either. |
| New `selectedSessionId` state | The existing `sessionId` | It already is "the conversation shown", in both views. |
| Existing users with an open workspace start in code view | Everyone starts in chat view; the choice is remembered from then on | No workspace is restored at launch, so there is nothing to detect. |
| Agents view kept behind a setting for one release | Removed; every feature moved (stop all, delete, folder deleted, origin labels, approvals) | A setting would keep two ways to do the same thing, which is what this work removes. |
| Rows show branch and change counts | Only rows under Working and Waiting | A project's branch says nothing about an old conversation, and it keeps background git work to projects where an agent is active. |
| Status for non-open folders uses the existing query | New `git_summary` command with the repository's own commands disabled (`core.fsmonitor=false`, no external diff or textconv) | These folders were never opened by the user, so nothing configured in them should run. |

Added beyond the plan: a preview no longer switches views at all, it opens beside the conversation in the chat view (see `ChatFilePane`) and moves to the code view only from its own button; a new conversation in the chat view starts in the project just left; and the view switch has a browser end-to-end test (`apps/desktop/e2e/shell.e2e.mjs`) because `tauri-driver` does not run on macOS.

### Added later: files in the chat view

Clicking a file named in a conversation opens it in a pane beside the conversation (an even split, resizable), in place of the project column. The pane is read-only, per project, and has tabs and a narrow folder tree (`ChatFilePane.tsx`). Editing stays in the Code view, one click away. A reference becomes a link only if it names one real file of the project (`file-refs.ts`). Files of a project that is not open are readable through `workspace_allow`, which does not open the project or add it to the recent list.

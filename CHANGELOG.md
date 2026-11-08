# Changelog

All notable changes are listed here. The project follows [Semantic Versioning](https://semver.org/) from 1.0 onwards.

## Unreleased

- Recreations keep a wrapping row, such as a navigation, on one line where the page does. A rounding error in the row's fitted width could push its last item onto a new line.
- The desktop release build tries bundling up to three times, because it downloads its installer tools from GitHub.

## 0.3.0 (2026-11-08)

- Desktop: app previews open beside the conversation in the chat view instead of switching to the Code view. The preview shares the right pane with file tabs, and a toolbar button moves it to the Code view when you want it there.
- Desktop: file names in chat messages and tool steps are links. In the chat view a file opens beside the conversation, read-only, with tabs, a folder tree and Markdown rendering, without switching to the Code view.
- Desktop: the app opens in a new chat view that reads left to right: every conversation grouped by Working, Waiting and Settled; the selected conversation; and its project with branch, changes, running agents, goals and preview. The previous layout is now the Code view of a project, one click (or Ctrl+Shift+U) away. Switching views keeps open files and terminals. The Agents and Goals side panels moved into the chat view. Permission requests are answered in the conversation list, and clicking an OS notification selects its conversation.
- Recreations hold at every width, not only at the widths they were captured at. The importer keeps the page's layout in flow (columns with the page's margins, rows, wrapping flex rows, slide tracks, boxes as tall as their content, text that wraps), and every value between measured widths is continuous: no steps, no value that only holds at one width, no scaling. On the fixture site the absolutely positioned class rules fell from 110 to 6, and the output passes at every width from 320 to 2560 px.
- The responsive gate checks about 60 widths between and beyond the captures, a few of them different on every measurement, and compares overlapping content, text cut off by its box, text outside the screen and the page's height with the live page at the same width, by what overlaps rather than by how many. The live page's layout facts are taken at those widths during the capture.
- A new flow gate fails CSS that only holds where it was checked: media queries around one width, values that jump between widths, `zoom`, text placed by coordinates that the live page keeps in flow, and, in CSS added after the build, positioning, negative margins, fixed heights, `!important` and unscoped selectors.
- Repairs are linted before they are written and checked at the widths between the captures afterwards; a repair that breaks a width in between is undone. Sections are also sent to repair when their layout breaks between the captured widths.
- Captures take one variant per layout range of the page by default (`recreate.capturePlan: "devices"` for one per device class), and given `--widths` are walked across their own ranges.
- The compare page shows every sweep width and has a slider that sets the recreation's width.
- `scripts/recreate/sweep.mjs` prints the layout facts of a page at many widths against another page.
- Recreations of real pages keep their proportions between and beyond the captured widths: pictures no longer stretch, a stage as tall as the viewport stays as tall as the viewport (the capture records which boxes follow the viewport's height), it clips its video as the page does, a full-bleed stage keeps its breakout on wide screens, overlays kept in the page's flow for paint order stay in its flow, and an info icon after a text follows the text's last line.
- Recreations take more of the page's own layout: CSS columns, inline-block rows, grid items placed with `grid-column`, panels pulled up by negative margins, footnote superscripts in their paragraph, and space below content that comes from margins. The page is as tall as its content at every width.
- On screens wider than the widest captured width, recreations keep following the page (a centred column stays centred, full-width backgrounds keep spanning the window) instead of being capped at the widest captured layout. The compare page scales a width wider than the window down to fit instead of cutting it off.
- Recreations keep the page's nesting where it matters for flow: boxes taller than their content (cards sized by their grid row) keep their height, block wrappers holding several items stay boxes, CSS columns reach the wrapper that holds their content, and rows whose children span their height no longer centre the page when a child changes height.
- The responsive and flow gates compare text by its block, so a heading split over inline elements on one page and joined on the other is no longer reported as an overlap or as text out of flow.
- New `design_system` tool and `design-system` skill build a complete design system from a URL or from images. The workspace has tokens in four themes with enforced WCAG contrast, 25 accessible Lit web components, typed React components, Angular directives with form value accessors, a docs site and tests. Image readings use `designSystem.model`. See docs/design-system.md.

- New `check_app` tool play-tests native programs. It starts the program, presses keys to start play and captures its window over a few seconds. A vision model then reports visible defects against what the program should show, such as obstacles without a gap or overlapping text. `set_launch` adds the Launch button only after a check of the current files passes. The review model is set with `appCheck.model`.

## 0.2.0 (2026-11-06)

- Page capture and `check_preview` try once more when headless Chrome is slow to start on a busy machine.
- The desktop Agents view lists every running agent in any folder, with where it came from, elapsed time, model and tokens, and has **Stop all**. Conversations can be deleted from it, including ones whose folder is gone.
- Deleting a conversation also deletes its subagents, their worktrees and their merged branches, and can remove its sandbox folder.
- Runs cut off by a crash or quit are marked interrupted and can be continued.
- Subagents running at the same time share the parent's remaining budget instead of each getting all of it, and no new subagent starts while eight agents already run (`agents.maxActive`).
- Idle conversations are released from the server's memory after ten minutes, closing their MCP servers.
- See [docs/agent-control.md](docs/agent-control.md).
- Desktop: the status bar and Agents view update as soon as a run starts or ends, instead of on the next five-second refresh.
- Desktop: a finished run no longer looks busy for up to 15 seconds. The server now sends a short comment line after each batch of events, because the desktop webview could hold the last one until the next keep-alive.
- Desktop: a new conversation opens on a centered welcome with the folder picker and a tip. While the editor is split, the tip explains that agents running in parallel each need their own folder or checkout.
- Desktop: the editor splits into up to four groups (Ctrl+\\, the split button, or dragging a tab to an editor's left or right edge), and agent conversations open in editor tabs, so several run side by side. Move the panel's conversation into a tab, start one "to the side", or open one from the Agents view with Ctrl+click, middle-click or drag.

## 0.1.0 (2026-11-06)

First public release.

- **Harness:** a provider-agnostic agent loop with tools, permissions, verification, review, workflows, memory, MCP, and an event log.
- **Terminal workspace:** `cdr`.
- **Web app:** `cdr serve`, with sandboxes, live previews, and attachments.
- **SDK packages:** `@harness/client` and `@harness/react`.
- **`/terminal-design`** in the terminal app switches between the current flowing look (the default) and the earlier Classic look (wordmark home screen, centered composer box, graphite and lime). The choice applies immediately and is remembered in `~/.harness/tui.json`.
- **Chat mode no longer adds files to your repository.** In the terminal app, a file a chat creates (a poem, notes, a draft) is saved in its own folder under `~/Documents/CDR` (`<first message>-<id>/`) without a permission prompt. Edits to files that already exist in the project, and new files in a folder the project already has, still go to the project and still ask. `cdr serve` is not affected unless `outputDir` is configured. Build, Plan and Quick fix modes, sandboxes and subagents are unchanged. Set `outputDir` in the config (or `CDR_OUTPUT_DIR`) to choose another folder, or `"outputDir": false` to write new files into the project.
- Web: the model picker shows what each model supports (vision, tools, thinking, context size) when the provider reports it. `GET /models?remote=true` returns the new optional `details` per provider (`ModelDetail`, `ModelCapability`, `AvailableModels` in the protocol), and `ModelInfo` gains `vision`.
- Web: attachments open next to the chat, with PDFs in the browser's PDF viewer, zoomable images and an **Open in a new tab** button. The scroll button reads **Review plan** or **Review request** when an approval is waiting below the visible text.
- SDK: `new Harness({ defaultOutputDir })` sets the folder for chat-created files for embedders.
- Sandbox chats no longer build a page for plain questions or casual chat: the sandbox prompt now says to answer in text and only create files or a preview when the user asks for something to be made.
- Memory: `remember` refuses facts that look like secrets and can correct an outdated fact with `replaces`. A new `forget` tool removes a fact, and a new `memory.removed` event reports it. In `ask` mode, writes to user-wide memory (`scope: "user"`) now need approval. The web chat now shows saved and removed memories.
- Add **skills** in the Agent Skills format, from `.harness/skills`, `~/.harness/skills`, `skills.paths`, and a built-in set. Agents see a skills index and a `load_skill` tool, and matching skills load automatically in sandboxes.
- Add the built-in **web-app** skill with the Form store as its reference app and patterns for landing pages, dashboards, games, and todo apps.
- `check_preview` now checks phone and desktop widths. It reports overflow, broken images, unlabelled controls, failed requests, and errors raised while clicking through the page.
- Add the `apps` eval suite with sandbox tasks, `preview`, `judge`, and `maxFiles` checks, plus `cdr eval --suite`, `--judge`, `--repeat`, and `--label`. `scripts/evals/compare.mjs` compares runs.
- Add `capture.mjs web --real` to screenshot an app built by a real model.
- Add **Recreate 1:1** (opt-in): rebuild a live page as code you own, measured against the live page at every width. It runs through `cdr recreate`, `cdr mcp recreate`, `POST /sessions/:id/recreate`, the composer's **Recreate 1:1** button, `/recreate` and the command palette. Each run asks for consent first. Outputs are `static`, `react-vite`, `ds-react`, `ds-lit`, `ds-angular`, `tokens` and `design-md`. It adds the packages `@harness/capture`, `scene`, `extract`, `codegen`, `measure` and `recreate`, the `recreate-url` skill, the `recreate.*` events, the progress card and the Compare tab, and the `recreate` eval suite. See [docs/recreate.md](docs/recreate.md).
- **Context compaction** now runs within an absolute budget, `context.maxContext` (default 64K tokens), and is triggered by the input tokens the provider reports. It prunes old tool output first. When that is not enough, it writes an "execution brief" instead of a generic summary. Compacted history stays searchable in `.harness/history/`. A new `context.compacted` event reports each compaction, and `cdr eval --max-context` adds compaction metrics.
- **Workspace checkpoints**: files are snapshotted into a shadow Git repository before every turn. **Restore files to here** on a user message (or `/rewind`) previews the changes, then restores them. The restore can be undone. Adds the `checkpoint.*` events and the `/sessions/:id/checkpoints` endpoints.
- **Skills per message**: type `/` in the composer or use the Skills picker to attach skills to a message. A skill with `disable-model-invocation` loads only when the user picks it. Adds 27 skills from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT, see THIRD_PARTY_NOTICES.md).
- The web preview gets a Desktop / Tablet / Mobile device switcher.
- Default session limits are raised to 150 turns and 3 hours.
- **CDR Studio**, a native desktop app built with Tauri 2 and Rust:
  - an editor with colorful file icons, a GitHub Desktop-style Git client, terminals, and language-server diagnostics;
  - the agent panel, an approvals inbox, and goals;
  - AI-generated commit messages and UI zoom;
  - `.deb`, `.rpm`, and AppImage bundles.
- **Subagents.** The `spawn_agent` and `wait_agents` tools add parallel helpers. Writing helpers work in their own Git worktrees.
- **Goals.** A goal has acceptance criteria and a budget, and runs unattended with the `autonomous` workflow and checkpoint commits. It comes with the `/goals` API and `cdr goal` commands.
- **Releases.** GitHub Actions builds installers for Linux, macOS, and Windows, plus a terminal and web app archive, for every version tag. `pnpm release:version` keeps one version across all packages.
- **API additions:**
  - `POST /commit-message`;
  - sidecar options for `cdr serve`: `--token-env`, `--ready-json`, `--port 0`, and a parent-process watchdog.

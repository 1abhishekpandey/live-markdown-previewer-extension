LLM-Assist Mode - Task Breakdown

Status: Draft
Owner: Abhishek
Last updated: 2026-04-12
Related: `HLD.md`, `LLD.md`, `TEST-PLAN.md`, `SPIKE-PLAN.md`, `spike-results/`

# Overview

The feature ships five net-new webview modules (`llmCommentStore`, `llmCommentMark`, `llmSelectionAnchor`, `llmToggle`, plus test files), extends three existing webview modules (`commentIndicator`, `commentPanel`, `editor`, `index`), and adds three small touches on the extension host (`syncProtocol`, `documentSync`, `markdownEditorProvider`, `extension`, `package.json`). Total: 15 files across 7 implementation phases plus a validation phase that is already complete.

Work is split so each phase lands one component plus its automated tests in a single PR. The verification checklist in the test plan is ticked off incrementally.

# Phase 0: Validation

All five external-contract spikes ran before the LLD was written and every contract in the LLD is graded Verified or Documented. This phase is a gate only — no implementation starts until it passes, and it already does.

- [x] Spike 1 — TipTap `Mark.create({ excludes: '' })` stacks overlapping marks with distinct ids (`spike-results/01-mark-stacking.md`).
- [x] Spike 2a — ProseMirror `Decoration.node` can carry both a commentable class and a commented-with-count class without slot conflicts (`spike-results/02-gutter-plugin.md`).
- [x] Spike 2b — Visual check in the Extension Development Host: CSS `:hover::after` fires on paragraphs and headings; `doc.forEach` walk misses list items (recorded as a scope refinement).
- [x] Spike 3 — Webview CSP permits `navigator.clipboard.writeText`; no `postMessage` round-trip needed (`spike-results/03-clipboard.md`).
- [x] Spike 4 — `commentPanel.ts` can be extended with a `mode: 'thread' | 'llm-assist'` parameter without structural surgery (`spike-results/04-comment-panel.md`).
- [x] Spike 5 — `positionOverlay` in `linkDialog.ts:20-36` is selection-anchored via `view.coordsAtPos` and can be copied into `positionNearSelection` with a right-edge clamp (`spike-results/05-selection-anchor.md`).

Circuit breaker: if any implementation phase surfaces evidence that contradicts a verified spike result (e.g. mark serialiser leaks `<span data-llm-comment-id>` into saved markdown despite the documented `tiptap-markdown` storage contract), STOP and return to the LLD before continuing.

# Dependency Graph

```
Phase 0 (done)
     │
     ▼
Phase 1: Store + init-path piping
     │
     ├─► Phase 2: TipTap mark ────────┐
     │                                 │
     └─► Phase 3: Gutter plugin ──┐   │
                                   ▼   ▼
                          Phase 4: Panel extensions
                                       │
                                       ▼
                          Phase 5: Selection anchor
                                       │
                                       ▼
                          Phase 6: Toggle + Copy all + command
                                       │
                                       ▼
                          Phase 7: Integration + manual QA
```

Phase 2 and Phase 3 can run in parallel after Phase 1 lands. Phase 4 depends on both.

# Human Time Budget

| Phase | Human Tasks | Estimated Time |
|---|---|---|
| Phase 2 | H5 — save round-trip with marks does not leak `<span data-llm-comment-id>` to disk | 3 min |
| Phase 3 | H1 — hover `+` affordance across the commentable node-type set | 5 min |
| Phase 5 | H2 — selection `+` positioning, click flow, cancel-unwinds-mark | 5 min |
| Phase 6 | H3 — Copy all writes to the real system clipboard | 3 min |
| Phase 6 | H4 — mode mutual exclusion error banner | 2 min |
| Phase 6 | H6 — Light / Dark / High Contrast theme rendering | 5 min |
| Phase 6 | H7 — in-session edit re-render; payload reflects live quoted text | 3 min |
| Total | | 26 min |

# Phases

## Phase 1: Store and init-path piping
**Depends on**: Phase 0
**PR scope**: In-memory `LlmCommentStore` (CRUD + `toPayload`), the `workspaceRelativePath` field on `InitMessage`, and the extension-host wiring that computes it via `vscode.workspace.asRelativePath(uri, false)` and sends it down in the `init` message. No TipTap mark yet — `toPayload` is tested against a mocked editor that stands in for text-mark reads.
**Files**:
- `src/webview/llmCommentStore.ts` (new)
- `src/sync/syncProtocol.ts` (modify — add optional `workspaceRelativePath`)
- `src/sync/documentSync.ts` (modify — populate new field on init emission)
- `src/markdownEditorProvider.ts` (modify — compute path, pass to sync manager; add `getWebviewForUri` accessor)
- `src/__tests__/unit/llmCommentStore.test.ts` (new)
- `src/__tests__/unit/markdownEditorProvider.test.ts` (extend or new — assert `asRelativePath(uri, false)` call)
- `src/__tests__/unit/documentSync.test.ts` (extend — assert init message carries `workspaceRelativePath`)

### Tasks
- [x] Task 1.1: Create `LlmCommentStore` with `add`, `remove`, `update`, `clear`, `get`, `getAll`, `getCount`, `getForLine`, `onChange`. `getAll` returns a snapshot copy. `getForLine` returns line comments first, then text comments sorted by `createdAt`. Every mutation calls `notify()`; no `postMessage({type: 'savePendingQueue'})` exists anywhere in the file.
  - Executor: LLM
  - Verification: `npm test -- llmCommentStore.test.ts` — S1 (add fires onChange), S2 (remove unknown id is silent no-op but still notifies), S3 (update preserves other fields), S4 (getForLine ordering), S5 (getForLine inclusive bounds), S6 (getAll snapshot isolation), S7 (clear empties), S8 (spy on `acquireVsCodeApi().postMessage` never sees `savePendingQueue`).
- [x] Task 1.2: Add `toPayload(editor, workspaceRelativePath)` to the store. Sort by `startLine` asc, then `kind: 'line'` before `kind: 'text'`, then `createdAt` asc. `File:` header uses the path verbatim. Empty store returns `''`. Single comment uses `Comment:`, multi uses `Comment-1:`, `Comment-2:`, etc. Blocks separated by exactly `\n\n-----\n\n`. Triple-quote fences are inserted verbatim — no escaping of inner backticks, code fences, table pipes, or `>` lines.
  - Executor: LLM
  - Verification: `npm test -- llmCommentStore.test.ts` — P1 (empty), P2 (single matches LLD "Example (single comment)" byte-for-byte), P3 (two-comment numbering), P4 (two-comment ordering by startLine), P5 (same-line tie-breaker: line, text@100, text@200), P6 (multi-line range header reads `Lines 5-7`), P7 (triple-quote survives backticks and table pipes), P9 (`workspaceRelativePath` is first-line verbatim), P10 (exactly two `-----` separators for three blocks). P8 (live quoted text) and the `kind: 'text'` stripped-marks edge case are deferred to Phase 7 (they need a real TipTap editor).
- [x] Task 1.3: Add optional `workspaceRelativePath?: string` to `InitMessage` in `src/sync/syncProtocol.ts`. No new message types; the field is additive and optional so older handlers ignore it.
  - Executor: LLM
  - Verification: `npm run check-types` clean; the field appears in the union; no other message shape changes.
- [x] Task 1.4: In `MarkdownEditorProvider.resolveCustomTextEditor`, compute `workspaceRelativePath = vscode.workspace.asRelativePath(document.uri, false)` and pass it into `DocumentSyncManager`. In `DocumentSyncManager`, populate it on the init message. Add a `getWebviewForUri(docUri: string): Webview | undefined` accessor on `MarkdownEditorProvider` (a read of `anchorStates.get(docUri)?.webview`) — Phase 6 needs it.
  - Executor: LLM
  - Verification: `npm test -- markdownEditorProvider.test.ts` — I1 (`asRelativePath` called with `(documentUri, false)`, not the default `true`). `npm test -- documentSync.test.ts` — I2 (init message posted to webview carries `workspaceRelativePath: 'a/b.md'`). `npm run check-types` clean.

### Phase verification
- [x] All tasks above complete.
- [x] `npm test` clean (new store + init tests + existing suite).
- [x] `npm run check-types` clean.
- [x] `npm run build` produces both `dist/extension.js` and `dist/webview.js` with no warnings about the new exports.

---

## Phase 2: TipTap mark `llmComment`
**Depends on**: Phase 1
**PR scope**: The inline `llmCommentMark` extension with `excludes: ''`, the `setLlmComment` and `unsetLlmCommentById` commands, and the `tiptap-markdown` storage contract (`open: ''`, `close: ''`, `mixable: true`) that keeps the mark out of saved files. Registers the mark in the `createEditor` extension list. Also ships the highlight CSS.
**Files**:
- `src/webview/llmCommentMark.ts` (new)
- `src/webview/editor.ts` (modify — add `LlmCommentMark` to the extension list)
- `src/webview/styles.css` (modify — add `.llm-comment-mark` rule)
- `src/__tests__/unit/llmCommentMark.test.ts` (new)

### Tasks
- [x] Task 2.1: Create `llmCommentMark.ts`. `name: 'llmComment'`, `excludes: ''`, `inclusive: false`. `addAttributes({ commentId })` stored as `data-llm-comment-id`. `parseHTML` matches `span[data-llm-comment-id]`. `renderHTML` emits `['span', { class: 'llm-comment-mark', 'data-llm-comment-id': commentId }, 0]`. `addCommands`: `setLlmComment({ commentId })` and `unsetLlmCommentById(id)` (walks via `tr.doc.descendants` and removes every range with that id in one transaction). Plus `clearAllLlmComments()` which strips every `llmComment` mark in a single transaction (LlmToggle's Clear-all path needs this in Phase 6, but the command belongs on the mark's extension).
  - Executor: LLM
  - Verification: `npm test -- llmCommentMark.test.ts` — M1 (schema flags), M2 (wrap selection renders `<span data-llm-comment-id="A">world</span>`), M3 (collapsed selection is a no-op), M4 (overlap stacks; `closest('[data-llm-comment-id]')` inside the overlap returns the innermost mark), M5 (`unsetLlmCommentById('A')` removes A, leaves B), M6 (`parseHTML` round-trips an HTML-seeded doc into a mark with the correct `commentId`).
- [x] Task 2.2: Add `addStorage` with `{ markdown: { serialize: { open: '', close: '', mixable: true, expelEnclosingWhitespace: false } } }`. This is the single contract with `tiptap-markdown` that keeps marks out of the saved file.
  - Executor: LLM
  - Verification: `npm test -- llmCommentMark.test.ts` — M7 (`editor.storage.markdown.getMarkdown()` returns the same string for a doc with `llmComment` marks as for the same doc without them).
- [x] Task 2.3: Register `LlmCommentMark` in `createEditor`'s extension list alongside `Link`, `Markdown`, etc. The mark must be part of the schema at editor construction time, not added at mount time.
  - Executor: LLM
  - Verification: `npm run check-types` clean. `npm test` — existing editor-construction tests still green.
- [x] Task 2.4: Add `.llm-comment-mark` to `src/webview/styles.css` using `var(--vscode-editor-findMatchHighlightBackground)` (or the nearest theme-safe variable). Keep the rule scoped to the webview element.
  - Executor: LLM
  - Verification: `npm run build` clean; inspect `dist/webview.css` to confirm the rule is present.
- [ ] Task 2.5: Manual — H5 save regression. Run `npm run vscode:install`, reload VS Code, open a markdown doc in the Extension Development Host, activate LLM-Assist via the command palette (wired in Phase 6; for this phase, apply a mark programmatically via the dev console), hit `Cmd+S`, open the saved file in a plain text editor. Confirm NO `<span data-llm-comment-id>` appears. (If Phase 6 has not landed yet, fall back to running a happy-dom integration test that calls `editor.storage.markdown.getMarkdown()` after applying a mark.)
  - Executor: Human (visual check of saved markdown file contents)
  - Verification: saved file is byte-identical to the pre-mark markdown.
  - Time: 3 min

### Phase verification
- [x] All tasks above complete (LLM tasks). H5 manual check deferred to the consolidated Phase 7 manual pass.
- [x] `npm test -- llmCommentMark.test.ts` clean (M1–M7, plus a clearAllLlmComments extra — 8 tests).
- [x] `npm run check-types` clean.
- [ ] H5 passes — deferred to consolidated manual pass after Phase 7.

---

## Phase 3: Gutter plugin (extend `commentIndicator.ts`)
**Depends on**: Phase 1 (the store is read for counts)
**PR scope**: Extend `commentIndicator.ts` with a mutually-exclusive LLM-Assist decoration branch. Reuses the existing `lineMap` walk. Emits `llm-line-commentable` (hover `+`) on commentable lines with zero comments, and `llm-line-commented` with `data-llm-count` / `data-llm-line` on lines with ≥1 comment. Commentable node-type set is the LLD table exactly. Ships the matching CSS.
**Files**:
- `src/webview/commentIndicator.ts` (modify — add `llmAssistActive`, `llmComments` to state; add the branch)
- `src/webview/styles.css` (modify — `.llm-line-commentable:hover::after`, `.llm-line-commented::after`)
- `src/__tests__/unit/llmGutterPlugin.test.ts` (new)

### Tasks
- [x] Task 3.1: Extend `CommentIndicatorState` with `llmAssistActive: boolean` and `llmComments: LlmComment[]`. Extend `updateCommentIndicatorState` to accept these fields. `buildDecorations` early-out returns empty when both `reviewMode` and `llmAssistActive` are false. The two branches are exclusive — review-mode branch runs only when `reviewMode === true`, LLM-Assist branch runs only when `llmAssistActive === true`.
  - Executor: LLM
  - Verification: `npm test -- llmGutterPlugin.test.ts` — G1 (both flags off ⇒ empty decoration set), G2 (LLM on, Review off ⇒ only `llm-line-*` classes), G3 (Review on, LLM off ⇒ only review-mode classes).
- [x] Task 3.2: Walk `lineMap.posToLineRange`. For each entry, call `doc.nodeAt(pos)`. Skip if the node is null or its type name is not in the commentable set: `paragraph`, `heading`, `list_item`, `task_item`, `code_block`, `table`. Skip `blockquote`, `bullet_list`, `ordered_list`, `task_list`, `table_row`, `table_cell`, `table_header`, `horizontal_rule`. Convert the 0-indexed `startLine` to 1-indexed via `line1 = startLine + 1` at the boundary.
  - Executor: LLM
  - Verification: `npm test -- llmGutterPlugin.test.ts` — G4 (heading + paragraph both decorated), G5 (list items decorated, `bullet_list` is not), G6 (table decorated whole, cells are not), G7 (blockquote container skipped, inner paragraph decorated), G8 (horizontal rule zero decorations), G11 (1-indexed conversion verified).
- [x] Task 3.3: For each commentable line, compute `count = llmComments.filter(c => c.startLine <= line1 && line1 <= c.endLine).length`. Emit `Decoration.node(pos, pos + node.nodeSize, ...)`. When `count === 0`: class `llm-line-commentable`, no data attrs. When `count ≥ 1`: class `llm-line-commented`, `data-llm-count="${count}"`, `data-llm-line="${line1}"`.
  - Executor: LLM
  - Verification: `npm test -- llmGutterPlugin.test.ts` — G9 (one line comment + two text comments on L2 ⇒ `data-llm-count="3"`, `data-llm-line="2"`), G10 (`store.onChange` after `store.add` re-renders the decoration from commentable to commented).
- [x] Task 3.4: Add `.llm-line-commentable:hover::after` (renders `+`) and `.llm-line-commented::after { content: attr(data-llm-count); }` (renders the count badge) to `styles.css`. Use `var(--vscode-editorLineNumber-activeForeground)` and `var(--vscode-badge-background)` / `var(--vscode-badge-foreground)` for theming. Position in the left margin, matching the existing review-mode badge pattern at `commentIndicator.ts:109-128`.
  - Executor: LLM
  - Verification: `npm run build` clean; inspect `dist/webview.css` for the two rules.
- [ ] Task 3.5: Manual — H1 hover affordance. Open a doc with one heading, two paragraphs, a list with two items, a 2x2 GFM table, a blockquote with `> inner`, and a horizontal rule. Activate LLM-Assist (via a dev console call in this phase, or the command from Phase 6). Hover each element in turn.
  - Executor: Human (visual check of gutter across every commentable and non-commentable node type)
  - Verification: `+` appears on heading, both paragraphs, both list items, the table (top-left), and the blockquote's inner paragraph. `+` does NOT appear on the `blockquote` container, any `table_cell`, or the horizontal rule. Lines with a comment show the badge instead of the `+`.
  - Time: 5 min

### Phase verification
- [x] All tasks above complete (LLM tasks). H1 manual check deferred to the consolidated Phase 7 manual pass.
- [x] `npm test -- llmGutterPlugin.test.ts` clean (G1–G11).
- [ ] H1 passes — deferred to consolidated manual pass after Phase 7.
- [x] The existing review-mode `commentIndicator.test.ts` suite still passes (regression guard — 10/10 green).

---

## Phase 4: Comment panel extensions
**Depends on**: Phase 1 (store), Phase 2 (mark + `unsetLlmCommentById` for delete/cancel paths)
**PR scope**: Extend `commentPanel.ts` with a `mode: 'thread' | 'llm-assist'` parameter, add three new entry points (`openLlmLine`, `openLlmText`, `openLlmNewText`), rename "Queue" to "Save" in LLM mode, and render the per-entry Edit / Copy / Delete buttons. Panel does NOT subscribe to the LLM store via the existing `subscribeToStore` path; a parallel subscription drives list re-rendering.
**Files**:
- `src/webview/commentPanel.ts` (modify)
- `src/__tests__/unit/commentPanel.llm.test.ts` (new)

### Tasks
- [x] Task 4.1: Add optional constructor params `llmStore?: LlmCommentStore` and `editor?: Editor`. Existing thread entry points ignore both. Add `mode: 'thread' | 'llm-assist'` field to `buildPanel`'s options.
  - Executor: LLM
  - Verification: `npm run check-types` clean.
- [x] Task 4.2: In `buildPanel` under `mode === 'llm-assist'`: skip the `renderComment` / `renderPendingComment` loops at `commentPanel.ts:168-173`; skip the `hasPendingAlready` guard at `commentPanel.ts:179-196`; rename the reply button label to `'Save'`; wire it to a new `onLlmSaveClick` handler; render Copy and Delete buttons next to Save in the same row. Preserve `positionPanel` and `registerCloseHandlers` verbatim — Spike 4 verified they have zero thread-state references.
  - Executor: LLM
  - Verification: `npm test -- commentPanel.llm.test.ts` — L2 (`mode: 'llm-assist'` renders no `.thread-comment` elements), L3 (reply button text is `'Save'`), L4 (empty textarea Save is a no-op — `store.add` never called). `npm test -- commentPanel.test.ts` — L1 (existing thread tests still pass; regression guard).
- [x] Task 4.3: Add `openLlmLine(line1, anchorEl)`. Renders the list of `store.getForLine(line1)` in order (line first, then text by `createdAt` asc). When the list is empty, focus the textarea for first input.
  - Executor: LLM
  - Verification: `npm test -- commentPanel.llm.test.ts` — L5 (list order: line@7, text@7 createdAt 100, text@7 createdAt 200). Empty-list focus check included as an edge-case assertion.
- [x] Task 4.4: Add `openLlmText(id, anchorEl)` — pre-fills the textarea with `store.get(id).body`. Add `openLlmNewText(id, anchorEl)` — opens with an empty textarea; close-without-save runs `editor.commands.unsetLlmCommentById(id)`.
  - Executor: LLM
  - Verification: `npm test -- commentPanel.llm.test.ts` — L6 (`openLlmText` pre-fill), L7 (`openLlmNewText` empty), L8 (cancel on `openLlmNewText` calls `unsetLlmCommentById('Y')` once).
- [x] Task 4.5: Per-entry Edit / Copy / Delete buttons. Edit replaces the body with an inline textarea and writes back via `store.update(id, newBody)` on confirm. Copy calls `navigator.clipboard.writeText(entry.body)` — just the body, NOT `toPayload`. Delete calls `store.remove(id)`; for `kind: 'text'`, also calls `editor.commands.unsetLlmCommentById(id)`.
  - Executor: LLM
  - Verification: `npm test -- commentPanel.llm.test.ts` — L9 (Copy writes the body only, never a `File:` payload), L10 (Delete on `kind: 'text'` calls both `store.remove` and `unsetLlmCommentById`), L11 (Delete on `kind: 'line'` calls `store.remove` only).
- [x] Task 4.6: Register a parallel `llmStore.onChange` subscription in the panel that re-renders the list section only. Do NOT reuse `subscribeToStore` — it assumes `PendingCommentStore`'s shape.
  - Executor: LLM
  - Verification: happy-dom test: add a comment to the store while the panel is open for its line; assert the list section gains an entry without the panel closing or re-positioning.

### Phase verification
- [x] All tasks above complete.
- [x] `npm test -- commentPanel.llm.test.ts` clean (L2–L11 plus an onChange re-render test — 12 tests).
- [x] `npm test -- commentPanel.test.ts` clean (L1 regression — 18 tests).
- [x] `npm run check-types` clean.

---

## Phase 5: Selection anchor (`+` above a selection)
**Depends on**: Phase 2 (mark), Phase 4 (panel)
**PR scope**: The floating `+` button that tracks a live selection and, on click, applies the mark + opens the panel in `openLlmNewText` mode. Copies `positionOverlay` from `linkDialog.ts:20-36` into a new `positionNearSelection` helper with a right-edge clamp.
**Files**:
- `src/webview/llmSelectionAnchor.ts` (new)
- `src/webview/styles.css` (modify — `.llm-selection-plus`)
- `src/__tests__/unit/llmSelectionAnchor.test.ts` (new, happy-dom)

### Tasks
- [x] Task 5.1: Create `LlmSelectionAnchor` with constructor `(editor, store, panel)`. On construction, append a `<button class="llm-selection-plus">+</button>` to `document.body`. Register a `selectionchange` listener on `document`. Maintain an `llmAssistActive` flag updated via a setter the Phase 6 toggle will call.
  - Executor: LLM
  - Verification: `npm test -- llmSelectionAnchor.test.ts` — A1 (hidden when `llmAssistActive === false` even with a real selection).
- [x] Task 5.2: Hide the button on `selectionchange` when any of: `llmAssistActive === false`, `window.getSelection()` is null or collapsed, the selection range's `commonAncestorContainer` is outside the editor element. Otherwise compute screen coords via a new `positionNearSelection(btn, editor)` helper (a copy of `positionOverlay` from `linkDialog.ts:20-36`, renamed, with a right-edge clamp: if `btn.left + btn.width > window.innerWidth - 16`, set `left = window.innerWidth - btn.width - 16`).
  - Executor: LLM
  - Verification: `npm test -- llmSelectionAnchor.test.ts` — A2 (collapsed selection keeps it hidden), A3 (selection outside the editor keeps it hidden), A4 (right-edge clamp).
- [x] Task 5.3: Click handler. Read `editor.view.state.selection.from/to`, resolve start and end source lines via `findLineForPos(lineMap, from)` and `findLineForPos(lineMap, to - 1)`, convert both to 1-indexed. Generate a `commentId` (same helper the store uses). Apply the mark immediately via `editor.chain().focus().setLlmComment({ commentId }).run()`. Open the panel via `panel.openLlmNewText(commentId, anchorEl)` where `anchorEl` is the first rendered span carrying the new id. On panel save, the store records `{ id: commentId, kind: 'text', startLine, endLine, body, createdAt }`. On panel cancel, the panel's `openLlmNewText` close path runs `unsetLlmCommentById(commentId)` (wired in Phase 4).
  - Executor: LLM
  - Verification: `npm test -- llmSelectionAnchor.test.ts` — A5 (click triggers `setLlmComment` and `panel.openLlmNewText` once each with the same generated id), A6 (cancel-without-save calls `unsetLlmCommentById` — verified via the Phase 4 panel wiring; the test spies on `unsetLlmCommentById`).
- [x] Task 5.4: Add `.llm-selection-plus` to `styles.css`. Uses `position: fixed`, theme-aware colours via `var(--vscode-button-background)` / `var(--vscode-button-foreground)`. Hidden by default via `display: none`; visible only when the anchor calls `show()`.
  - Executor: LLM
  - Verification: `npm run build` clean.
- [ ] Task 5.5: Manual — H2 selection anchor positioning. Open a doc with a long paragraph that wraps near the right edge of the editor. Activate LLM-Assist. Select text near the left edge, then near the right edge, then a multi-line span that crosses two paragraphs. Click the `+` on each.
  - Executor: Human (visual check of the `+` tracking real mouse selections, including right-edge clamp)
  - Verification: `+` appears above the selection in all three cases; never goes off-screen on the right; the panel opens and the textarea has focus; cancelling the panel removes the highlight (no orphan `<span data-llm-comment-id>`).
  - Time: 5 min

### Phase verification
- [x] All tasks above complete (LLM tasks). H2 manual check deferred to the consolidated Phase 7 manual pass.
- [x] `npm test -- llmSelectionAnchor.test.ts` clean (A1–A6).
- [ ] H2 passes — deferred to consolidated manual pass after Phase 7.
- [x] `npm run build` clean. `vscode:install` deferred until Phase 6 lands the command so the manual pass can reach the toggle via the palette.

---

## Phase 6: Toggle, action row, Copy all, VS Code command
**Depends on**: Phase 1 (store + init path), Phase 2 (mark), Phase 3 (gutter plugin), Phase 4 (panel), Phase 5 (selection anchor)
**PR scope**: The title-bar `LlmToggle`, the `Copy all (N)` / `Clear all (N)` action row, the `liveMarkdown.toggleLlmAssist` VS Code command and its routing to the active webview, and the webview mount wiring that instantiates everything and registers the click handlers on `data-llm-comment-id` spans and `.llm-line-commented` nodes.
**Files**:
- `src/webview/llmToggle.ts` (new)
- `src/webview/styles.css` (modify — `.llm-toggle`, `.llm-bar`, `.llm-actions-row`, and the click-target styles for commented lines)
- `src/webview/index.ts` (modify — mount store, toggle, selection anchor; route `toggleLlmAssist` message; cache `workspaceRelativePath`; register DOM click handlers)
- `src/extension.ts` (modify — register `liveMarkdown.toggleLlmAssist` command, route to active webview via `getWebviewForUri`)
- `package.json` (modify — command contribution, no keybinding per HLD V1)
- `src/__tests__/unit/llmToggle.test.ts` (new)
- `src/__tests__/unit/index.message.test.ts` (new — verifies `toggleLlmAssist` postMessage routes to `LlmToggle.toggle()`)
- `src/__tests__/unit/extension.test.ts` (extend — I5, I6)

### Tasks
- [ ] Task 6.1: Create `LlmToggle` with constructor `(editor, vscode, store, panel, commentToggle)`. DOM: row-1 `<button class="llm-toggle">Assist: Off</button>`, row-2 `<div class="llm-bar"><div class="llm-actions-row"><button class="llm-copy-all">Copy all (0)</button><button class="llm-clear-all">Clear all (0)</button></div></div>`. Action row starts with `display: none`. Expose `toggle()` and `isActive()`. Expose a `workspaceRelativePath` field.
  - Executor: LLM
  - Verification: `npm test -- llmToggle.test.ts` — T1 (initial state: button `'Assist: Off'`, action row hidden).
- [ ] Task 6.2: `toggle()` while inactive. If `commentToggle.isActive()` → show a transient error banner `Review mode is active — toggle it off first` and return without state change. Otherwise: build the line map via `buildLineMap(editor.state.doc, markdown, md)` (reusing the path at `index.ts:51-54`), call `updateCommentIndicatorState({ llmAssistActive: true })`, register an `editor.on('update', ...)` listener that rebuilds the line map and re-publishes plugin state on every doc change, set the title-bar button text to `'Assist: On'`, show row-2. Tell `LlmSelectionAnchor` the mode is active.
  - Executor: LLM
  - Verification: `npm test -- llmToggle.test.ts` — T2 (rejects when Review active; error banner shown; state unchanged), T3 (activate path: `updateCommentIndicatorState({llmAssistActive:true})` called; `editor.on('update', ...)` registered; button text flips).
- [ ] Task 6.3: `toggle()` while active. `store.clear()`. `editor.commands.clearAllLlmComments()`. `updateCommentIndicatorState({ llmAssistActive: false })`. Detach the update listener. Reset button text. Hide row-2. Tell `LlmSelectionAnchor` the mode is inactive.
  - Executor: LLM
  - Verification: `npm test -- llmToggle.test.ts` — T11 (deactivate path: `store.clear` + `clearAllLlmComments` both called; `llmAssistActive=false`; listener detached; button text `'Assist: Off'`).
- [ ] Task 6.4: Reactive row-2 labels via `store.onChange`. `Copy all (N)` / `Clear all (N)` where N is `store.getCount()`. Row-2 gets `display: none` when `N === 0`, `display: flex` otherwise. Matches `commentToggle.ts:238-250` / `commentToggle.ts:241`.
  - Executor: LLM
  - Verification: `npm test -- llmToggle.test.ts` — T4 (action row hidden when empty), T5 (first add shows row + label `Copy all (1)`), T6 (reactive label `Copy all (3)` → `Copy all (2)`).
- [ ] Task 6.5: Copy all click. `const payload = store.toPayload(editor, this.workspaceRelativePath)`. If non-empty, `await navigator.clipboard.writeText(payload)`. On resolve, flip button label to `'Copied ✓'` for 1500 ms then restore. On reject, flip to `'Copy failed'` for 3000 ms, `console.warn(err)`. When `payload === ''`, do not call `writeText` and do not flash any label.
  - Executor: LLM
  - Verification: `npm test -- llmToggle.test.ts` — T7 (success path with fake timers: label flips to `Copied ✓`, reverts after 1500 ms), T8 (reject path: label flips to `Copy failed`, reverts after 3000 ms, `console.warn` called once), T9 (empty store: `writeText` not called).
- [ ] Task 6.6: Clear all click. `store.clear()` + `editor.commands.clearAllLlmComments()`. No confirmation prompt.
  - Executor: LLM
  - Verification: `npm test -- llmToggle.test.ts` — T10 (both calls happen on one click).
- [ ] Task 6.7: In `src/webview/index.ts`, after the existing Review-mode wiring: instantiate `const llmStore = new LlmCommentStore()`, then `const llmToggle = new LlmToggle(editor, vscode, llmStore, commentPanel, commentToggle)`, then `const llmSelection = new LlmSelectionAnchor(editor, llmStore, commentPanel)`. On `init` message → cache `workspaceRelativePath` on `llmToggle`. On `toggleLlmAssist` message → call `llmToggle.toggle()`. Add DOM click listeners: `[data-llm-comment-id]` → read id from `closest`, `store.get(id)` → `commentPanel.openLlmText(id, spanEl)` (silent return if `get` yields undefined). `.llm-line-commented` → read `data-llm-line`, call `commentPanel.openLlmLine(line1, lineEl)`.
  - Executor: LLM
  - Verification: `npm test -- index.message.test.ts` — T12 (dispatch `{type:'toggleLlmAssist'}` calls `llmToggle.toggle()` once). Also a DOM-click happy-dom test: clicking a `data-llm-comment-id` span calls `panel.openLlmText`; clicking a `.llm-line-commented` node calls `panel.openLlmLine` with the parsed line number.
- [ ] Task 6.8: In `src/extension.ts` `activate`, register `liveMarkdown.toggleLlmAssist` via `vscode.commands.registerCommand`. The handler uses the new `getWebviewForUri` accessor (added in Phase 1) to find the active webview and posts `{ type: 'toggleLlmAssist' }`. Silent no-op if no active markdown editor. Push the `Disposable` to `context.subscriptions`.
  - Executor: LLM
  - Verification: `npm test -- extension.test.ts` — I5 (command registered during `activate`; disposable pushed), I6 (handler calls `getWebviewForUri` and posts the message).
- [ ] Task 6.9: `package.json` — add the command contribution for `liveMarkdown.toggleLlmAssist` (title: `Live Markdown: Toggle LLM-Assist`). No keybinding per HLD V1.
  - Executor: LLM
  - Verification: `npm run build`, `npm run vscode:install`, reload VS Code; command appears in the Command Palette.
- [ ] Task 6.10: Add `.llm-toggle`, `.llm-bar`, `.llm-actions-row`, and the click-cursor style for `.llm-line-commented` to `styles.css`. Theme-aware via `var(--vscode-*)`.
  - Executor: LLM
  - Verification: `npm run build` clean; inspect `dist/webview.css`.
- [ ] Task 6.11: Manual — H3 clipboard reaches the system clipboard. After `npm run vscode:install` + reload: activate LLM-Assist, add one line comment, click `Copy all`, paste into a plain text editor.
  - Executor: Human (paste into an external editor and read the content)
  - Verification: pasted content matches the LLD `File: ... Line N — Selected text: """..."""...` payload; button label briefly flips to `Copied ✓`.
  - Time: 3 min
- [ ] Task 6.12: Manual — H4 mode mutual exclusion banner. Activate Review mode first, then click the LLM-Assist title-bar button.
  - Executor: Human (visual check of the error banner and state)
  - Verification: banner reads `Review mode is active — toggle it off first`; LLM-Assist button still reads `Assist: Off`; row-2 does not appear.
  - Time: 2 min
- [ ] Task 6.13: Manual — H6 theme integration. Activate LLM-Assist, add one line comment and one text comment. Switch between Light+, Dark+, and High Contrast themes via `Cmd+K Cmd+T`.
  - Executor: Human (visual check of highlight, gutter `+`, badge, panel chrome)
  - Verification: highlight visible against the background in all three themes; `+` and badge legible; panel chrome matches the theme.
  - Time: 5 min
- [ ] Task 6.14: Manual — H7 in-session edit re-render. Activate LLM-Assist, add a line comment to line 5, insert two new lines above so the original content is now on line 7. Click the badge — the panel should still open with the original comment. Click `Copy all` and paste.
  - Executor: Human (visual check of live re-render + payload)
  - Verification: stored `startLine`/`endLine` are NOT re-anchored — payload still says `Line 5` (per LLD and HLD). Quoted text reflects whatever the ProseMirror node currently at the original anchor position contains.
  - Time: 3 min

### Phase verification
- [ ] All tasks above complete.
- [ ] `npm test -- llmToggle.test.ts` clean (T1–T12).
- [ ] `npm test -- extension.test.ts` clean (I5, I6).
- [ ] `npm test -- index.message.test.ts` clean.
- [ ] H3, H4, H6, H7 all pass.
- [ ] `npm run build` + `npm run vscode:install` + reload clean; the command appears in the Command Palette.

---

## Phase 7: Integration round-trips
**Depends on**: Phase 6
**PR scope**: Four happy-dom integration tests that wire the real TipTap editor, store, plugin, panel, toggle, and a mocked `navigator.clipboard.writeText`. These cover cross-component contracts that unit tests cannot — most importantly the live quoted text in the payload and the overlap-stacking behaviour.
**Files**:
- `src/__tests__/unit/integration/lineFlow.test.ts` (new)
- `src/__tests__/unit/integration/textOverlap.test.ts` (new)
- `src/__tests__/unit/integration/modeMutex.test.ts` (new)
- `src/__tests__/unit/integration/toggleOff.test.ts` (new)

### Tasks
- [ ] Task 7.1: Line-flow round-trip. Seed `'# Title\n\nFirst paragraph.\n\nSecond paragraph.'`. Activate toggle. Call `panel.openLlmLine(3, fakeAnchorEl)`. Type `'expand this'`, click Save. Mock `navigator.clipboard.writeText`. Click `Copy all`.
  - Executor: LLM
  - Verification: store has one comment `kind:'line' startLine:3 endLine:3 body:'expand this'`; decoration on line-3 is `llm-line-commented` with `data-llm-count="1"`; captured clipboard string starts with `File: `, contains `Line 3 — Selected text:`, `First paragraph.`, `Comment:`, `expand this` in that order, with triple-quote fences.
- [ ] Task 7.2: Text-flow round-trip with overlap (also covers payload edge case P8 — live quoted text). Seed paragraph `'The quick brown fox jumps'`. Activate. Wrap `'quick brown'` with id A and add store entry (createdAt 100). Wrap `'brown fox'` with id B and add store entry (createdAt 200). Click `Copy all`.
  - Executor: LLM
  - Verification: overlap region `'brown'` is wrapped by both ids (nested spans); line-3 decoration reads `data-llm-count="2"`; payload has two blocks in order A → B labelled `Comment-1:`, `Comment-2:`; block A's quoted text is `'quick brown'`, block B's is `'brown fox'` (each block reflects ITS marked range only, not the union).
- [ ] Task 7.3: Mode mutual exclusion round-trip. Construct toggle, store, plugin with `reviewMode=true` and a seeded review thread. Call `llmToggle.toggle()`. Then call `commentToggle.toggle()` to deactivate Review. Call `llmToggle.toggle()` again.
  - Executor: LLM
  - Verification: step-2 keeps `llmAssistActive=false` and shows the error banner; decorations are still review-mode classes only. Step-5 flips `llmAssistActive=true`; decorations are LLM-Assist classes only; zero review-mode classes in the decoration set.
- [ ] Task 7.4: Toggle-off wipe round-trip. Activate; add one line comment and one text comment (mark applied); confirm the doc HTML contains a `data-llm-comment-id` span. Call `llmToggle.toggle()`.
  - Executor: LLM
  - Verification: `store.getCount() === 0`; no `data-llm-comment-id` survives in the doc HTML; button text `'Assist: Off'`; action row hidden; the update listener registered on activate is detached.

### Phase verification
- [ ] All tasks above complete.
- [ ] `npm test` clean (new integration tests + full existing suite).
- [ ] Final full manual sanity pass: H1–H7 all re-verified after any late conflicts.

---

# Progress Tracker

## Summary
| Phase | Status | Notes |
|---|---|---|
| Phase 0: Validation | [x] | All five spikes complete; contracts Verified in LLD |
| Phase 1: Store + init-path piping | [x] | Store, payload, init field and provider wiring landed. 325 tests green. |
| Phase 2: TipTap mark | [x] | LlmCommentMark with stacking + empty markdown serializer. 8 tests green. |
| Phase 3: Gutter plugin | [x] | LLM branch in commentIndicator, 11 new tests, regression suite still green. |
| Phase 4: Panel extensions | [x] | LLM mode + openLlmLine/Text/NewText + per-entry actions + parallel onChange. 12 new + 18 regression. |
| Phase 5: Selection anchor | [x] | Floating + button with right-edge clamp. 6 tests green. Not wired into index.ts until Phase 6. |
| Phase 6: Toggle + Copy all + command | [ ] | |
| Phase 7: Integration round-trips | [ ] | |

## Completion Criteria
- [ ] All phases marked complete.
- [ ] Every phase verification block passes (tests + build + lint).
- [ ] Test plan verification checklist is fully ticked: C1–C4, S1–S8, P1–P10, M1–M7, G1–G11, A1–A6, L1–L11, T1–T12, I1–I6, all integration round-trips, H1–H7.
- [ ] `npm run package` produces a clean production bundle.
- [ ] `npm run vscode:install` installs cleanly and the command `Live Markdown: Toggle LLM-Assist` appears in the Command Palette.

# Next Step

Begin Phase 1 (Store + init-path piping). Phase 0 is already a pass, so no spike work is required before implementation starts.

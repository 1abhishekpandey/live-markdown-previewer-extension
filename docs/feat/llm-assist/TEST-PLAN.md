LLM-Assist Mode - Test Plan

Status: Draft
Owner: Abhishek
Last updated: 2026-04-12
Related: `HLD.md`, `LLD.md` (this directory)

# Overview

This plan defines how every component in the LLM-Assist Mode LLD is verified before the feature ships. The feature is webview-resident: a TipTap mark, a ProseMirror gutter plugin, an in-memory comment store, a selection-anchored button, a floating panel, and a title-bar toggle. Two extension-host touches (a command registration and a workspace-relative path field on the init message) round it out.

The verification strategy is layered. Pure logic — payload formatting, store ordering, line-range filtering, mark serialiser invisibility — is covered by Vitest unit tests with mocked dependencies. ProseMirror/TipTap behaviour that depends on a real schema (mark stacking, gutter decoration emission) is covered by happy-dom integration tests using the same pattern as the existing spike tests under `src/__tests__/spikes/`. UX-only behaviour — hover affordances, selection-anchored positioning, clipboard write, mode mutual exclusion, panel close handlers — is verified manually in the Extension Development Host because these flows depend on live mouse/keyboard events and a real VS Code webview clipboard origin.

# Test Strategy

- Roughly 70% Vitest automated (unit + happy-dom integration), 30% manual in the Extension Development Host.
- Every component in the LLD gets at least one automated test for its core contract and one edge case. UX-only flows are pushed entirely to manual checkpoints; do not waste cycles trying to drive ProseMirror selection events from a test.
- The clipboard write itself is mocked in unit tests (assert the string passed to `navigator.clipboard.writeText`); the actual clipboard hit is verified once in a manual checkpoint to prove CSP and origin are happy.

# Component Tests

## LlmComment (data record)

### What to verify

- `id` generation: `crypto.randomUUID()` is used when available; the `llm-${Date.now()}-${random}` fallback is used when it is not.
- `body` is trimmed of leading/trailing whitespace on save, never otherwise transformed.
- For `kind: 'line'`, `startLine === endLine`.
- For `kind: 'text'`, a multi-line selection produces `startLine = N`, `endLine = M`.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| C1 | UUID path | `globalThis.crypto.randomUUID` defined and returns `'abc-123'` | `LlmComment.id === 'abc-123'` | Automated | `npm test -- llmComment.test.ts` |
| C2 | Fallback path | `globalThis.crypto.randomUUID` undefined | id matches `/^llm-\d+-/` | Automated | `npm test -- llmComment.test.ts` |
| C3 | Body trim | `body = '  hello world  \n'` | stored body `'hello world'` | Automated | `npm test -- llmComment.test.ts` |
| C4 | Body internal whitespace | `body = 'a\n\n  b'` | stored body `'a\n\n  b'` (no internal collapse) | Automated | `npm test -- llmComment.test.ts` |

### Edge cases

- Empty body after trim: a `' '` body trims to `''`. The store does not reject; the panel's Save handler is the layer that suppresses an empty save (covered under `LlmCommentPanel`).

## LlmCommentStore

### What to verify

- `add` / `remove` / `update` / `clear` mutate state and fire `onChange` listeners exactly once per call.
- `update(id, body)` only touches `body`; `kind`, `startLine`, `endLine`, `createdAt` are preserved.
- `remove(missingId)` and `update(missingId, ...)` are silent no-ops AND still fire `onChange` (matches `PendingCommentStore.remove` semantics).
- `getForLine(line1)` returns every comment whose `[startLine, endLine]` covers `line1`; the result is ordered `kind: 'line'` first, then `kind: 'text'` by `createdAt` ascending.
- `getAll()` returns a snapshot copy: mutating the returned array does not mutate the store.
- `getCount()` reflects post-mutation state.
- No `postMessage({type: 'savePendingQueue', ...})` is ever called from the store. (Regression guard against accidentally porting `pendingCommentStore.ts:70-72`.)

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| S1 | Add fires onChange | listener registered, then `add({...})` | listener called once | Automated | `npm test -- llmCommentStore.test.ts` |
| S2 | Remove unknown id | `remove('does-not-exist')` | no throw, listener called once, `getCount()` unchanged | Automated | same |
| S3 | Update preserves fields | `add({kind:'text', startLine:5, endLine:7, createdAt:111, body:'a'})` then `update(id, 'b')` | only `body === 'b'`; other fields equal originals | Automated | same |
| S4 | getForLine ordering | line-level on L4, two text-level on L4 with createdAt 100 and 200 | result is `[lineComment, text@100, text@200]` | Automated | same |
| S5 | getForLine inclusive bounds | text comment with `startLine: 3, endLine: 5` | `getForLine(3)`, `getForLine(4)`, `getForLine(5)` all include it; `getForLine(2)` and `getForLine(6)` do not | Automated | same |
| S6 | getAll snapshot isolation | `arr = store.getAll(); arr.push(fake)` | `store.getCount()` unchanged | Automated | same |
| S7 | Clear empties store | seed N comments, `clear()` | `getCount() === 0`, listener fired once | Automated | same |
| S8 | No persist message | spy on `acquireVsCodeApi().postMessage`, run every mutation method | spy never called with `type: 'savePendingQueue'` | Automated | same |

### Edge cases

- `getForLine` with zero comments returns `[]`, not `undefined`.
- Two `add` calls with the same `createdAt` (same millisecond) preserve insertion order in `getForLine`.

## LlmCommentStore.toPayload

### What to verify

- The `File:` header uses the `workspaceRelativePath` argument verbatim.
- Empty store returns `''` (empty string), not `'File: ...\n\n'`.
- Single comment uses `Comment:` (no number suffix); two or more use `Comment-1:`, `Comment-2:`, ...
- Block ordering: `startLine` ascending, then `kind: 'line'` before `kind: 'text'`, then `createdAt` ascending.
- Single-line anchor uses `Line N`; multi-line uses `Lines N-M` (matches `formatLineHeader` in `commentPanel.ts:403-408`).
- The separator is exactly `\n\n-----\n\n` between blocks; not before the first block, not after the last.
- Triple-quote fences (`"""`) wrap both the quoted text and the body verbatim — backticks, code fences, table pipes, and `>` blockquote prefixes inside the content are NOT escaped.
- The quoted text is read live from the editor at copy time, not stored. Mutating the editor between `add` and `toPayload` reflects in the payload.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| P1 | Empty store | zero comments | `toPayload()` returns `''` | Automated | `npm test -- llmCommentStore.test.ts` |
| P2 | Single line comment | one `kind:'line'` on line 42, body `'expand this'`, doc has `'foo bar'` on line 42, path `'docs/design.md'` | matches the LLD "Example (single comment)" exactly with `Line 42 — Selected text:`, `Comment:`, body `'expand this'`, quoted `'foo bar'` | Automated | same |
| P3 | Two comments numbering | line@5, text@42 | payload contains `Comment-1:` and `Comment-2:` (not `Comment:`) | Automated | same |
| P4 | Two-comment ordering | text@10 added first, line@5 added second | line@5 emitted first (sorted by startLine) | Automated | same |
| P5 | Same-line tie-breaker | line@7 and text@7 with createdAt 100 and 200 | order is line, text@100, text@200 | Automated | same |
| P6 | Multi-line range header | text comment with `startLine:5, endLine:7` | header reads `Lines 5-7 — Selected text:` | Automated | same |
| P7 | Triple-quote survives backticks | quoted text contains `` ``` ts `` and `\|` | payload contains the content verbatim between the `"""` fences; no escaping | Automated | same |
| P8 | Live quoted text | add a comment, edit the underlying paragraph, call `toPayload` | quoted text reflects post-edit content | Automated | same (uses a real TipTap editor instance) |
| P9 | Path is verbatim | `workspaceRelativePath = 'a/b/c.md'` | first line of payload is `'File: a/b/c.md'` | Automated | same |
| P10 | Separator placement | 3 blocks | exactly two `-----` separators; none before block 1; none after block 3 | Automated | same |

### Edge cases

- A `kind: 'text'` comment whose stored marks were stripped from the doc (e.g. user deleted the marked range): `toPayload` walks `llmCommentMark` instances and finds none for that id. Result: empty quoted text between the fences. Acceptable per LLD — the line number still anchors the comment for the LLM.
- Two text comments on the same line whose marks overlap in the doc: each comment's quoted text is the concatenation of ITS marked ranges only, not the union. Verified by adding two overlapping marks via `setLlmComment` and asserting each block's quoted content.

## LlmCommentMark

### What to verify

- The mark name is `'llmComment'`, `excludes` is `''`, `inclusive` is `false`.
- `setLlmComment({ commentId })` on a non-collapsed selection wraps the range and sets `data-llm-comment-id` on the rendered span.
- `setLlmComment` on a collapsed selection is a no-op (the doc is unchanged).
- Two overlapping `setLlmComment` calls with distinct ids produce nested spans with both ids present in the DOM at the overlap region (regression guard for Spike 1's verified behaviour).
- `unsetLlmCommentById(id)` removes every range with that id in a single transaction; other ids on overlapping ranges survive.
- `parseHTML` round-trips: HTML containing `<span data-llm-comment-id="X">...</span>` parses back into an `llmComment` mark with `commentId === 'X'`.
- Markdown serialiser regression: a doc with `llmComment` marks serialises to the same markdown string as the same doc without them. (`tiptap-markdown` reads `storage.markdown.serialize`; `open: ''`, `close: ''`, `mixable: true` makes the mark invisible on save.)

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| M1 | Schema flags | inspect mark spec | `name === 'llmComment'`, `excludes === ''`, `inclusive === false` | Automated | `npm test -- llmCommentMark.test.ts` |
| M2 | Wrap selection | editor with `'hello world'`, select `'world'`, run `setLlmComment({commentId:'A'})` | DOM contains `<span data-llm-comment-id="A">world</span>` | Automated | same |
| M3 | Collapsed selection no-op | cursor at position 3, run `setLlmComment({commentId:'A'})` | doc HTML unchanged | Automated | same |
| M4 | Overlap stacks | wrap `'quick brown'` with id A then `'brown fox'` with id B | overlap region has both ids; `closest('[data-llm-comment-id]')` from inside `'brown'` finds id B (the innermost) | Automated | same |
| M5 | Unset by id | M4 doc, then `unsetLlmCommentById('A')` | no node carries id A; id B's marks intact | Automated | same |
| M6 | parseHTML round-trip | inject HTML `<p><span data-llm-comment-id="X">y</span></p>`, parse | resulting doc has an `llmComment` mark with `commentId === 'X'` | Automated | same |
| M7 | Markdown serialiser invisible | doc `'a **b** c'` versus same doc with `llmComment` mark on `'b'` | `editor.storage.markdown.getMarkdown()` returns identical strings | Automated | same |

### Edge cases

- `unsetLlmCommentById('*')` is NOT a wildcard. The dedicated `clearAllLlmComments` command (LlmToggle) is the only path that strips every mark. Verify by attempting `unsetLlmCommentById('*')` on a doc with marks `'A'` and `'B'`: nothing changes.
- A click handler reading `closest('[data-llm-comment-id]')` from a TEXT node inside the overlap returns the innermost wrapping span. (Verified in M4 above.)

## LlmGutterPlugin (extension to commentIndicator.ts)

### What to verify

- When `llmAssistActive === true` and `reviewMode === false`, the LLM-Assist decoration branch runs and the Review-mode branch does not.
- When `reviewMode === true` and `llmAssistActive === false`, the Review-mode branch runs and the LLM-Assist branch does not.
- When both flags are false, `buildDecorations` returns the empty set (early-out path at the top of `buildDecorations`).
- The commentable node-type filter matches the LLD table exactly: `paragraph`, `heading`, `list_item`, `task_item`, `code_block`, `table` are decorated; `blockquote`, `bullet_list`, `ordered_list`, `task_list`, `table_row`, `table_cell`, `table_header`, `horizontal_rule` are NOT.
- A line with zero comments emits a `llm-line-commentable` decoration (no `data-*` attrs).
- A line with N comments emits a `llm-line-commented` decoration with `data-llm-count="N"` and `data-llm-line="${line1}"`.
- The plugin re-renders on `LlmCommentStore.onChange` (e.g. after `add`, the relevant line flips from `commentable` to `commented` with count 1).
- A line with one line-level comment plus two text-level comments has `data-llm-count="3"`.
- Stale `lineMap`: a line whose `findPosForLine` returns null is silently dropped (no exception).
- 1-indexed conversion at the boundary: `lineMap.posToLineRange` is 0-indexed; the plugin must convert to 1-indexed before calling `getForLine`.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| G1 | Both flags off | `reviewMode=false`, `llmAssistActive=false` | `buildDecorations` returns `DecorationSet.empty` | Automated | `npm test -- llmGutterPlugin.test.ts` |
| G2 | Mutual exclusion (LLM on) | `llmAssistActive=true`, doc has 1 paragraph | one decoration with class `llm-line-commentable`, no review-mode classes | Automated | same |
| G3 | Mutual exclusion (Review on) | `reviewMode=true`, `llmAssistActive=false`, doc has 1 paragraph + a review thread | review-mode decorations only, no `llm-line-*` classes | Automated | same |
| G4 | Filter — heading + paragraph | doc `# title\nbody` | two decorations, both `llm-line-commentable` | Automated | same |
| G5 | Filter — list items decorated, list container is not | doc `- a\n- b` | two decorations on the `list_item` nodes; no decoration on the `bullet_list` parent | Automated | same |
| G6 | Filter — table decorated whole, cells not | doc with one 2x2 GFM table | exactly one decoration on the `table` node; zero on `table_row`/`table_cell` | Automated | same |
| G7 | Filter — blockquote skipped, inner para decorated | doc `> quoted` | decoration on the inner `paragraph` only; none on the `blockquote` | Automated | same |
| G8 | Filter — horizontal rule skipped | doc `---` | zero decorations | Automated | same |
| G9 | Count badge | seed store with one line-level on L2 and two text-level on L2 | the L2 decoration has class `llm-line-commented`, `data-llm-count="3"`, `data-llm-line="2"` | Automated | same |
| G10 | onChange triggers re-render | start with empty store, register plugin, then `store.add(line on L2)` | next `buildDecorations` shows L2 as `llm-line-commented` count 1 | Automated | same |
| G11 | 1-indexed conversion | line map maps `pos=12` to `startLine=4` (0-indexed); store has comment with `startLine:5, endLine:5` | the decoration on `pos=12` reads `data-llm-count="1"` (proves the +1 conversion) | Automated | same |

### Edge cases

- A text-level comment whose `startLine !== endLine` (multi-line selection): all lines in the range get the badge increment. Verify by adding a single text-comment with `startLine:3, endLine:5` and asserting lines 3, 4, 5 each carry `data-llm-count="1"`.
- A line whose source has no ProseMirror counterpart (`findPosForLine` null): no decoration emitted, no exception.

## LlmSelectionAnchor

### What to verify (automated subset only)

- The button DOM element is created and appended to `document.body` on construction.
- `selectionchange` while `llmAssistActive === false` keeps the button hidden.
- `selectionchange` with a collapsed selection keeps the button hidden.
- `selectionchange` with a selection entirely outside the editor element keeps the button hidden.
- The `positionNearSelection` viewport-edge clamp triggers when computed `left + width > innerWidth - 16`.
- Click handler reads `editor.view.state.selection`, calls `setLlmComment` with a generated id, then opens the panel via `openLlmNewText(id, anchorEl)`.
- Cancel-without-save path (panel close in `openLlmNewText` mode) calls `unsetLlmCommentById(id)`.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| A1 | Hidden when mode off | construct anchor with `llmAssistActive=false`, fire `selectionchange` with a real selection | button has `display: none` (or equivalent hidden state) | Automated | `npm test -- llmSelectionAnchor.test.ts` (happy-dom) |
| A2 | Hidden on collapsed selection | mode on, mock selection with `isCollapsed=true` | button hidden | Automated | same |
| A3 | Hidden when selection outside editor | mode on, mock selection whose `commonAncestorContainer` is in a sibling textarea | button hidden | Automated | same |
| A4 | Right-edge clamp | mock `view.coordsAtPos` returning `{left: window.innerWidth - 5, ...}` | rendered `left === window.innerWidth - btn.width - 16` | Automated | same |
| A5 | Click triggers mark + panel | spy on `editor.chain().focus().setLlmComment(...).run()` and on `panel.openLlmNewText` | both called once with the same generated id | Automated | same |
| A6 | Cancel unwinds mark | A5 setup, then trigger panel close-without-save | `unsetLlmCommentById(generatedId)` called once | Automated | same |

### Manual checkpoints

The visible behaviour — the `+` actually appearing above a real text selection and tracking the selection rectangle in the live editor — is verified in the Extension Development Host (see Human Checkpoints).

### Edge cases

- A selection that starts in the editor and ends in a panel textarea (cross-element drag): the `range.commonAncestorContainer` falls outside the editor element, so the button stays hidden. Acceptable per LLD.

## LlmCommentPanel (extensions to commentPanel.ts)

### What to verify

- `buildPanel` with `mode: 'thread'` is unchanged: existing thread tests still pass after the refactor (regression guard).
- `buildPanel` with `mode: 'llm-assist'` skips the `renderComment` and `renderPendingComment` loops at `commentPanel.ts:168-173`.
- `buildPanel` with `mode: 'llm-assist'` skips the `hasPendingAlready` guard at `commentPanel.ts:179-196` (the panel can always show its reply section).
- The reply button's label is `'Save'` (not `'Queue'`) when `mode: 'llm-assist'`.
- The Save button is wired to `onLlmSaveClick`, not `onQueueClick`.
- Empty textarea on Save is a no-op (matches `commentPanel.ts:276-278`).
- `openLlmLine(line1, anchorEl)` renders the list of comments returned by `store.getForLine(line1)` in the documented order (line first, then text by createdAt ascending).
- `openLlmText(id, anchorEl)` pre-fills the textarea with the existing comment body.
- `openLlmNewText(id, anchorEl)` opens with an empty textarea; close-without-save runs `unsetLlmCommentById(id)`.
- Per-entry buttons render exactly three: Edit, Copy, Delete. Edit replaces body inline; Copy calls `navigator.clipboard.writeText(entry.body)` (just the body, NOT `toPayload`); Delete calls `store.remove(id)` and (for `kind:'text'`) `unsetLlmCommentById(id)`.
- `subscribeToStore` is NOT called for the LLM-Assist store (the thread-store subscription path is not reused). A parallel `llmStore.onChange` subscription drives list re-rendering only.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| L1 | Thread regression | run existing `commentPanel` tests after refactor | all pre-existing tests pass | Automated | `npm test` |
| L2 | LLM mode skips renderComment | `buildPanel({mode:'llm-assist', ...})` with seeded thread store | no `.thread-comment` elements rendered | Automated | `npm test -- commentPanel.llm.test.ts` |
| L3 | Save button label | `openLlmLine(2, el)` | the reply button text is `'Save'` | Automated | same |
| L4 | Empty save no-op | `openLlmLine(2, el)`, leave textarea empty, click Save | `store.add` not called | Automated | same |
| L5 | List order | seed store with line@7, text@7 createdAt 100, text@7 createdAt 200; `openLlmLine(7, el)` | rendered list has 3 entries in that exact order | Automated | same |
| L6 | openLlmText pre-fill | seed store with text comment id `X`, body `'note'`; `openLlmText('X', el)` | textarea value is `'note'` | Automated | same |
| L7 | openLlmNewText empty | `openLlmNewText('Y', el)` | textarea value is `''` | Automated | same |
| L8 | Cancel new text strips mark | L7, then call panel close handler | `editor.commands.unsetLlmCommentById('Y')` called once | Automated | same |
| L9 | Per-entry Copy uses body only | seed body `'hello'`, click entry's Copy button | `clipboard.writeText` called with `'hello'`, NOT a `File:` payload | Automated | same |
| L10 | Per-entry Delete (text kind) | text comment id `Z`, click Delete | `store.remove('Z')` AND `unsetLlmCommentById('Z')` both called | Automated | same |
| L11 | Per-entry Delete (line kind) | line comment id `W`, click Delete | `store.remove('W')` called, `unsetLlmCommentById` NOT called | Automated | same |

### Edge cases

- `openLlmLine` for a line with zero comments: list section is empty and the textarea is focused for first input. Verify focus lands on the textarea after open.
- Edit button mid-flow: `update(id, newBody)` is called only when the inline edit is confirmed; cancelling the inline edit leaves `body` unchanged.

## LlmToggle

### What to verify

- Constructed inactive: title-bar button reads `'Assist: Off'`, action row has `display: none`.
- `toggle()` while Review mode is active is rejected with a transient error banner; state is unchanged.
- `toggle()` while inactive (and Review mode off) builds the line map, sets `llmAssistActive = true` in plugin state, registers an editor `update` listener, and shows the action row (still empty-gated on `store.getCount() === 0`).
- `toggle()` while active calls `store.clear()`, calls `editor.commands.clearAllLlmComments()`, sets `llmAssistActive = false`, detaches the update listener, and resets the title-bar button text.
- `Copy all` button label tracks `store.getCount()` reactively via `store.onChange`. Same for `Clear all`.
- Action row is hidden via `display: none` when `store.getCount() === 0`, even while the mode is active.
- `Copy all` click calls `store.toPayload(editor, workspaceRelativePath)` and (when non-empty) passes the result to `navigator.clipboard.writeText`.
- On clipboard rejection, the button label flips to `'Copy failed'` for 3000 ms and `console.warn` is called once.
- On clipboard success, the button label flips to `'Copied ✓'` for 1500 ms then restores.
- `Clear all` click calls `store.clear()` AND `editor.commands.clearAllLlmComments()`. No confirmation prompt.
- VS Code command path: `postMessage({type: 'toggleLlmAssist'})` received in `index.ts` calls `LlmToggle.toggle()`.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| T1 | Initial state | construct toggle | button text `'Assist: Off'`, action row hidden | Automated | `npm test -- llmToggle.test.ts` |
| T2 | Reject when Review active | `commentToggle.isActive()` mocked to return true, call `toggle()` | error banner shown, `llmAssistActive` not set, button text unchanged | Automated | same |
| T3 | Activate path | inactive, `commentToggle.isActive()` false, call `toggle()` | line map built; `updateCommentIndicatorState({llmAssistActive:true})` called; editor `on('update', ...)` registered; button text `'Assist: On'` | Automated | same |
| T4 | Action row hidden when empty | activate, store empty | action row has `display: none` | Automated | same |
| T5 | Action row shows on first add | activate, then `store.add(...)` | action row visible; button label is `Copy all (1)` | Automated | same |
| T6 | Reactive label | `store.add` to count 3, then `store.remove` to count 2 | label updates `Copy all (3)` then `Copy all (2)` | Automated | same |
| T7 | Copy success path | mock `clipboard.writeText` to resolve; click Copy | label flips to `Copied ✓`; reverts after 1500 ms (use fake timers) | Automated | same |
| T8 | Copy reject path | mock `clipboard.writeText` to reject with `Error('denied')`; click Copy | label flips to `Copy failed`; reverts after 3000 ms; `console.warn` called once | Automated | same |
| T9 | Copy with empty store | mode on, store empty, click Copy (action row would be hidden but force-call the handler) | `clipboard.writeText` NOT called | Automated | same |
| T10 | Clear all | seed store with 2 comments, click Clear | `store.clear()` and `editor.commands.clearAllLlmComments()` both called | Automated | same |
| T11 | Deactivate via toggle | active with 2 comments, call `toggle()` | `store.clear()` called, `clearAllLlmComments()` called, `llmAssistActive=false`, update listener detached, button text `'Assist: Off'` | Automated | same |
| T12 | postMessage routes to toggle | dispatch `{type:'toggleLlmAssist'}` to `index.ts` message handler | `LlmToggle.toggle()` called once | Automated | `npm test -- index.message.test.ts` |

### Edge cases

- Activating LLM-Assist when the editor is empty (zero blocks): line map builds successfully (empty), plugin state flips, action row stays hidden. No exception.
- `Clear all` clicked when the action row is already hidden (race with reactive re-render): defensive — `clearAllLlmComments()` on a doc with zero marks is a no-op.

## InitMessage extension + extension-host wiring

### What to verify

- `vscode.workspace.asRelativePath(uri, false)` is called with `false` as the second argument (NOT the default `true`). The default would prefix with the workspace folder name and break the LLD payload format `File: docs/design.md`.
- The computed `workspaceRelativePath` reaches the webview in the `init` message.
- The webview caches `workspaceRelativePath` on `LlmToggle` from the `init` handler in `index.ts`.
- `LlmToggle` falls back to the basename of the document URI when `workspaceRelativePath` is undefined (older message handler / mixed deploy).
- `liveMarkdown.toggleLlmAssist` is registered in `extension.ts` `activate` and is disposed via `context.subscriptions`.
- The command handler resolves the active webview via the new `getWebviewForUri` accessor and posts `{type:'toggleLlmAssist'}`.

### Test cases

| # | Scenario | Input | Expected Output | Executor | How to Run |
|---|---|---|---|---|---|
| I1 | asRelativePath args | mock `vscode.workspace.asRelativePath`, instantiate `MarkdownEditorProvider`, open a doc | mock called with `(documentUri, false)` | Automated | `npm test -- markdownEditorProvider.test.ts` |
| I2 | Init message carries path | mock the webview, open a doc with workspaceRelativePath `'a/b.md'` | the `init` message posted to the webview has `workspaceRelativePath: 'a/b.md'` | Automated | `npm test -- documentSync.test.ts` (extend existing) |
| I3 | Webview caches path | dispatch `init` message with `workspaceRelativePath: 'x.md'` | `LlmToggle.workspaceRelativePath === 'x.md'` | Automated | `npm test -- llmToggle.test.ts` |
| I4 | Fallback to basename | dispatch `init` with `workspaceRelativePath: undefined`, document URI `'/abs/path/foo.md'` | toggle's effective path is `'foo.md'` | Automated | same |
| I5 | Command registered | call `activate(mockContext)` | `vscode.commands.registerCommand` called with `'liveMarkdown.toggleLlmAssist'`; the disposable is pushed to `context.subscriptions` | Automated | `npm test -- extension.test.ts` |
| I6 | Command posts toggle | invoke the registered handler | `getWebviewForUri(activeUri)` resolved; webview `postMessage` called with `{type:'toggleLlmAssist'}` | Automated | same |

### Edge cases

- `getWebviewForUri` with no active markdown editor: handler is a silent no-op (no exception, no error toast).
- A doc whose URI is outside any workspace folder: `asRelativePath(uri, false)` returns the absolute path; the webview accepts that string verbatim (the LLD says the webview never derives the path itself).

# Integration Tests

## Line-flow round-trip (happy-dom)

### Scenario

A user activates LLM-Assist, hovers a paragraph, clicks the gutter `+`, types a note, saves, then clicks Copy all.

### Steps

1. Construct a real TipTap editor with the `llmComment` mark and the `commentIndicator` plugin extended for LLM-Assist, in happy-dom.
2. Seed the editor with `'# Title\n\nFirst paragraph.\n\nSecond paragraph.'`.
3. Construct `LlmCommentStore`, `LlmToggle`, `LlmCommentPanel` with `mode: 'llm-assist'`.
4. Call `llmToggle.toggle()` to activate.
5. Programmatically call `panel.openLlmLine(3, fakeAnchorEl)` for the first paragraph (line 3 in the source).
6. Type `'expand this'` into the textarea, click Save.
7. Mock `navigator.clipboard.writeText` to capture its argument.
8. Click `Copy all`.

### Expected Result

- The store has one `LlmComment` with `kind:'line'`, `startLine:3`, `endLine:3`, `body:'expand this'`.
- The `commentIndicator` plugin has one decoration on the line-3 paragraph with class `llm-line-commented`, `data-llm-count="1"`.
- The captured clipboard string starts with `'File: '` and contains `'Line 3 — Selected text:'`, `'First paragraph.'`, `'Comment:'`, `'expand this'`, in that order, with the exact triple-quote fences.

### Executor

Automated. `npm test -- integration/lineFlow.test.ts`.

## Text-flow round-trip with overlap (happy-dom)

### Scenario

The user makes two overlapping text-level comments on the same paragraph, then copies all.

### Steps

1. Same setup as above, paragraph text `'The quick brown fox jumps'`.
2. Activate LLM-Assist.
3. Programmatically wrap `'quick brown'` via `editor.chain().setLlmComment({commentId:'A'}).run()`.
4. Add to store: `{id:'A', kind:'text', startLine:3, endLine:3, body:'first', createdAt:100}`.
5. Programmatically wrap `'brown fox'` via `editor.chain().setLlmComment({commentId:'B'}).run()`.
6. Add to store: `{id:'B', kind:'text', startLine:3, endLine:3, body:'second', createdAt:200}`.
7. Capture `clipboard.writeText` and click `Copy all`.

### Expected Result

- The DOM at the overlap region (`'brown'`) is wrapped by both id A and id B (nested spans).
- The decoration on line 3 reads `data-llm-count="2"`.
- The clipboard payload contains two blocks, in order: A (createdAt 100) then B (createdAt 200), labelled `Comment-1:` and `Comment-2:`.
- Block A's quoted text is `'quick brown'`. Block B's quoted text is `'brown fox'`. (Each block reflects ITS marked range only, not the union.)

### Executor

Automated. `npm test -- integration/textOverlap.test.ts`.

## Mode mutual exclusion round-trip

### Scenario

LLM-Assist refuses to activate while Review mode is active; Review mode coexists with LLM-Assist's data structures but not its decorations.

### Steps

1. Construct toggle, store, plugin with both `reviewMode=true` and an existing review thread seeded.
2. Call `llmToggle.toggle()`.
3. Inspect plugin state and decorations.
4. Call `commentToggle.toggle()` to deactivate Review.
5. Call `llmToggle.toggle()` again.

### Expected Result

- Step 2: error banner shown, `llmAssistActive` stays false, decorations are still review-mode style only.
- Step 5: line map built, `llmAssistActive=true`, decorations are now LLM-Assist style only (zero review-mode classes in the decoration set).

### Executor

Automated. `npm test -- integration/modeMutex.test.ts`.

## Toggle-off wipe round-trip

### Scenario

Toggling LLM-Assist off must wipe the store AND strip every `llmComment` mark from the doc.

### Steps

1. Activate LLM-Assist; add one line comment and one text comment (with mark applied).
2. Confirm the doc HTML contains a `data-llm-comment-id` span.
3. Call `llmToggle.toggle()` to deactivate.
4. Inspect store, doc HTML, and the title-bar button.

### Expected Result

- `store.getCount() === 0`.
- No `data-llm-comment-id` span survives in the doc HTML.
- Title-bar button reads `'Assist: Off'`; action row is hidden.
- The editor `update` listener registered on activate is detached (calling editor commands does not re-trigger plugin state updates from the toggle).

### Executor

Automated. `npm test -- integration/toggleOff.test.ts`.

# Human Checkpoints

The following must be verified by a human in the Extension Development Host (`F5`) because they depend on real mouse/selection events, real CSS hover, real VS Code clipboard origin, or real visual layout that happy-dom cannot reproduce.

## H1 — Gutter `+` hover affordance

- **What to verify**: hovering a commentable line shows the `+` in the gutter; hovering a non-commentable element (horizontal rule, blockquote container, table cell) does NOT show a `+`; hovering a line that already has a line-level comment hides the `+` and shows the badge instead.
- **When**: after the LlmGutterPlugin and styles.css changes are merged into a build.
- **Time**: 5 minutes.
- **How**: open a doc with one heading, two paragraphs, a list with two items, a 2x2 table, a blockquote, and `---`. Activate LLM-Assist. Hover each element in turn.
- **Pass criteria**: `+` appears on heading, paragraphs, both list items, the table (top-left), and the blockquote's inner paragraph. `+` does NOT appear on the blockquote container, table cells, or `---`.

## H2 — Selection `+` positioning and click

- **What to verify**: selecting text shows the floating `+` above the selection; the `+` tracks the selection rectangle; clicking the `+` opens the panel; the right-edge clamp keeps the `+` inside the viewport.
- **When**: after `LlmSelectionAnchor` lands.
- **Time**: 5 minutes.
- **How**: open a doc with a long line that wraps near the right edge of the editor. Activate LLM-Assist. Select text near the left edge, then near the right edge, then a multi-line span. Click the `+` each time.
- **Pass criteria**: `+` appears above the selection in all three cases; never goes off-screen on the right; the panel opens and the textarea has focus; cancelling the panel removes the highlight (no orphan span).

## H3 — Copy all hits the system clipboard

- **What to verify**: `Copy all` writes the payload to the system clipboard via the real `navigator.clipboard.writeText` (CSP and origin are correct).
- **When**: after `LlmToggle` is wired and at least one comment can be saved.
- **Time**: 3 minutes.
- **How**: activate LLM-Assist, add one line comment, click `Copy all`, then paste into a plain-text editor (e.g. `Cmd+N` in TextEdit, or a fresh VS Code untitled buffer).
- **Pass criteria**: pasted content is the LLD-defined `File: ... Line N — Selected text: """..."""...` payload; button label briefly flips to `Copied ✓`.

## H4 — Mode mutual exclusion banner

- **What to verify**: trying to activate LLM-Assist while Review mode is on shows the transient error banner and does not flip state.
- **When**: after `LlmToggle` lands.
- **Time**: 2 minutes.
- **How**: activate Review mode first, then click the LLM-Assist title-bar button.
- **Pass criteria**: error text reads `Review mode is active — toggle it off first`; LLM-Assist title-bar button still reads `Assist: Off`; no second-row bar appears.

## H5 — Save round-trip with marks present (regression)

- **What to verify**: hitting `Cmd+S` while text-level marks are present in the doc does NOT leak `<span data-llm-comment-id>` into the saved markdown file.
- **When**: after `llmCommentMark.ts` markdown serialiser config lands.
- **Time**: 3 minutes.
- **How**: activate LLM-Assist, select a phrase, save a comment so the mark is applied, then `Cmd+S` to save the file. Open the file on disk in a plain text editor.
- **Pass criteria**: the saved file content matches the pre-comment markdown exactly. No `<span data-llm-comment-id>` anywhere in the file.

## H6 — Theme integration

- **What to verify**: the highlight, gutter `+`, badge, and panel use VS Code theme colours and look correct in light, dark, and high-contrast themes.
- **When**: after styles.css changes land.
- **Time**: 5 minutes.
- **How**: open the editor, activate LLM-Assist, add one line comment and one text comment. Switch between Light+, Dark+, and High Contrast themes via `Cmd+K Cmd+T`.
- **Pass criteria**: highlight is visible against the background in all three themes; `+` and badge are legible; panel chrome matches the theme.

## H7 — In-session edit re-render

- **What to verify**: editing the document while comments exist re-renders the gutter decorations on every keystroke; the live quoted text in the payload reflects the post-edit content.
- **When**: after the toggle's `editor.on('update', ...)` listener is wired.
- **Time**: 3 minutes.
- **How**: activate LLM-Assist, add a line comment to line 5, then insert two new lines above line 5 so the original content is now on line 7. Click the badge — it should still open with the original comment. Click `Copy all` and paste.
- **Pass criteria**: per the LLD, stored `startLine`/`endLine` are NOT re-anchored — the payload still says `Line 5` (the original number). The quoted text reflects the LIVE content of whatever ProseMirror node is currently at the original anchor position. (This is the intentional non-goal documented in HLD and LLD.)

Total human verification time: ~26 minutes.

# Verification Checklist

- [ ] LlmComment: C1–C4 pass; empty-body edge case handled by panel layer.
- [ ] LlmCommentStore: S1–S8 pass; getForLine inclusive bounds and snapshot isolation verified.
- [ ] LlmCommentStore.toPayload: P1–P10 pass; live quoted-text edge case verified; empty-mark fallback verified.
- [ ] LlmCommentMark: M1–M7 pass; overlap stacking matches Spike 1 output; markdown serialiser is invisible.
- [ ] LlmGutterPlugin: G1–G11 pass; commentable filter exactly matches the LLD table; mutual exclusion with Review mode verified at decoration level.
- [ ] LlmSelectionAnchor: A1–A6 pass; right-edge clamp verified; cancel-without-save unwinds the mark.
- [ ] LlmCommentPanel: L1–L11 pass; thread-mode regression suite still green; per-entry Copy uses body, not payload.
- [ ] LlmToggle: T1–T12 pass; Copy success and Copy failed label transitions verified with fake timers; postMessage routing verified.
- [ ] InitMessage extension + extension-host wiring: I1–I6 pass; `asRelativePath(uri, false)` argument verified; basename fallback verified.
- [ ] Integration — Line-flow round-trip: store, decoration, and clipboard payload all consistent.
- [ ] Integration — Text-flow with overlap: nested spans, count badge `2`, two payload blocks each reflecting their own marked range only.
- [ ] Integration — Mode mutual exclusion: error banner on the disallowed transition; clean swap once Review is off.
- [ ] Integration — Toggle-off wipe: store empty, no `data-llm-comment-id` survives, listener detached.
- [ ] H1 — Gutter `+` hover affordance verified by hand against the commentable filter.
- [ ] H2 — Selection `+` positioning and click verified at left, right, and multi-line.
- [ ] H3 — Copy all hits the system clipboard (real paste).
- [ ] H4 — Mode mutual exclusion banner visible; state unchanged.
- [ ] H5 — Save with marks present does not leak `<span data-llm-comment-id>` to disk.
- [ ] H6 — Light, Dark, and High Contrast themes all render correctly.
- [ ] H7 — In-session edits re-render decorations; payload reflects live quoted text and stored line numbers.

# Next Step

Run `/write:task-breakdown` to turn this verification surface into ordered implementation phases with dependencies. Each phase should land at least one component's automated tests in the same change as its production code, so the verification checklist can be ticked incrementally.

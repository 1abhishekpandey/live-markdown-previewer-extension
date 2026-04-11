LLM-Assist Mode - Low-Level Design

Status: Draft
Owner: Abhishek
Last updated: 2026-04-12
Related: `HLD.md` (this directory), `SPIKE-PLAN.md`, `spike-results/01-05`

# Scope

This document pins down contracts, data shapes, algorithms, and error handling for the webview-resident LLM-Assist feature described in the HLD. Every external contract below is Verified (grounded in a spike or a direct code read) or Documented (grounded in a TipTap / VS Code / Web API reference). No "Assumed" contracts remain.

The feature ships five net-new webview modules and two small touches in the extension host. No sync-protocol message on the write path needs to round-trip clipboard content: the webview calls `navigator.clipboard.writeText` directly (Spike 3).

# LlmComment (data record)

## Purpose

Single in-memory record for one LLM-Assist comment, produced by user input, consumed by `LlmCommentStore` and the payload emitter.

## Shape

- `id: string` — stable identifier. Generated via `crypto.randomUUID()` if available, falling back to `llm-${Date.now()}-${random}` (same pattern `commentPanel.ts:279-281` already uses for `tempId`).
- `kind: 'line' | 'text'` — which anchoring affordance created it.
- `body: string` — the user's note, verbatim. Trimmed on save (leading/trailing whitespace only), never otherwise transformed.
- `createdAt: number` — `Date.now()` at creation. Used as the secondary sort key inside the payload when two text-level comments share a starting line.
- `startLine: number` / `endLine: number` — 1-indexed working-copy line range the comment covers, matching the convention used by `commentPanel.ts:403-408` for the existing Review mode.
- For `kind: 'line'`: `startLine === endLine`.
- For `kind: 'text'`: a single selection that happens to span lines N..M sets `startLine = N`, `endLine = M`.

## Derived at copy time, not stored

The quoted text (`"""..."""`) is NOT stored on `LlmComment`. The store walks the live editor document at copy time and reads:

- For `kind: 'line'` — the text content of the commentable block at that line (one of `paragraph`, `heading`, `list_item`, `task_item`, `code_block`, `table`; see LlmGutterPlugin for the walk).
- For `kind: 'text'` — the concatenation of every text range whose `llmCommentMark` carries this `id`.

Storing the quoted text on the record would go stale the instant the user edits the document during the session (HLD explicitly permits in-session edits; only external edits during the session are out of scope). Reading it at copy time keeps the payload aligned with what the user sees.

# LlmCommentStore

## Purpose

In-memory registry for every `LlmComment` in the current session. Exposes an API shaped like `PendingCommentStore` (`src/webview/pendingCommentStore.ts`) but forks on the persistence point: no `postMessage({type: 'savePendingQueue', ...})` call, no `persist()` method, no `hydrate()` path.

## Inputs

- `add(comment: LlmComment): void`
- `remove(id: string): void`
- `update(id: string, body: string): void` — replaces the body of an existing comment, used by the panel's edit flow. Touches only `body`, never `kind`, `startLine`, `endLine`, `createdAt`.
- `clear(): void`
- `get(id: string): LlmComment | undefined`
- `getAll(): LlmComment[]` — returns a snapshot copy (not the live array), matching `PendingCommentStore.getAll()`.
- `getCount(): number`
- `getForLine(line1: number): LlmComment[]` — returns every comment whose range covers `line1`. Used by `LlmCommentPanel` to render the line-panel list, and by `LlmGutterPlugin` for the badge count.
- `onChange(listener: () => void): () => void` — pub/sub, matches `PendingCommentStore.onChange`.

## Outputs

- `toPayload(editor: Editor, filePath: string): string` — produces the clipboard payload described in the Payload Format section. The editor reference is required so the store can walk the live doc for quoted text; `filePath` is the workspace-relative path from the init message.

## Behaviour

1. `add`/`remove`/`update`/`clear` mutate the internal array and call `notify()`. No `persist()` — the omission is the point.
2. `getForLine(line1)` returns every comment where `startLine <= line1 <= endLine`. Order within the result: `kind: 'line'` first, then `kind: 'text'` sorted by `createdAt` ascending (document order for a single user session is effectively creation order).
3. `toPayload` walks `getAll()` sorted first by `startLine`, then by `kind` (`line` before `text`), then by `createdAt`, then emits the format defined below.

## Configuration

None. The store has no tunables; the HLD is explicit that sessions are ephemeral and unconfigured.

## Error handling

- `remove(id)` on a missing id is a silent no-op (matches `PendingCommentStore.remove` which filters and always notifies).
- `update(id, body)` on a missing id is a silent no-op.
- `toPayload` with zero comments returns an empty string; the caller (`LlmCommentBar`) suppresses the clipboard call when the string is empty and does not flash a toast.

# LlmCommentMark

## Purpose

A TipTap inline mark that wraps a user-selected text range with a class and a `data-llm-comment-id` attribute. Produces the highlighted span in the DOM, stacks with other `llmCommentMark` instances on overlapping ranges (Spike 1 verified), and is click-addressable so the panel can reopen an existing comment.

## Interface (TipTap Mark definition)

- `name: 'llmComment'`
- `excludes: ''` — critical. Removes ProseMirror's default single-mark-per-type exclusion, which enables overlapping / stacking (Spike 1: `src/__tests__/spikes/llmCommentMark.spike.test.ts`).
- `inclusive: false` — typing at either edge of the mark should not extend it; a new comment on a selection directly abutting an existing mark must produce a distinct stacked mark, not absorb the cursor position.
- Attributes:
  - `commentId: string` — the `LlmComment.id`. Stored both as the ProseMirror attr and as `data-llm-comment-id` on the rendered span so click dispatch can read it from the DOM.
- `parseHTML`: a single rule matching `span[data-llm-comment-id]` with `getAttrs` returning `{ commentId: el.getAttribute('data-llm-comment-id') }`.
- `renderHTML`: returns `['span', { class: 'llm-comment-mark', 'data-llm-comment-id': HTMLAttributes.commentId }, 0]`.
- `addCommands`:
  - `setLlmComment(attrs: { commentId: string })` — wraps the current selection.
  - `unsetLlmCommentById(id: string)` — walks the doc, removes every mark instance with the given id.

## Markdown serialisation policy

`tiptap-markdown`'s mark serialiser chain is the surface that writes the mark to the saved file when the user hits `Cmd+S` during a session. `LlmCommentMark` must emit the wrapped text with no wrapping characters: `open: ''`, `close: ''`, `mixable: true`, `expelEnclosingWhitespace: false`. This is provided via `addStorage() { return { markdown: { serialize: { open: '', close: '', mixable: true } } } }`. The net effect: the user's saved markdown never contains a `<span data-llm-comment-id>` wrapper, matching the HLD's "comments exist only for the lifetime of a session" guarantee. The mark lives only in the ProseMirror document tree, not on disk.

## Behaviour

- On `setLlmComment({ commentId })` with a non-collapsed selection: the mark is applied via `commands.setMark` across the selection range. If the selection is collapsed, the command is a no-op and the panel is never opened (the selection anchor `+` is only rendered for non-collapsed selections anyway).
- On overlap: per Spike 1, overlapping ranges produce nested spans with distinct `data-llm-comment-id` attributes. The DOM click handler uses `closest('[data-llm-comment-id]')` and so lands on the innermost mark; clicking at an edge where only one mark exists lands on the outer mark — this is the intended UX ("click the highlight that you see").
- `unsetLlmCommentById(id)`: walks the doc via `tr.doc.descendants`, and for every text node with a matching `llmComment` mark, creates a `removeMark` transaction step for that range. All steps are dispatched in a single transaction.

## Error handling

- `setLlmComment` on a read-only editor (e.g. Review mode is active) is rejected by the TipTap command framework; the caller is expected not to try — the HLD's LlmToggle and Review-mode toggle are mutually exclusive.
- A DOM click that lands on an `llmComment` span whose id is not in the store (possible if the mark was stripped by `unsetLlmCommentById` between the visual frame and the click handler) opens nothing and logs nothing — the id lookup via `store.get(id)` returns `undefined`, the handler returns.

# LlmGutterPlugin

## Purpose

ProseMirror plugin that emits one `Decoration.node` per commentable block node in the live document. Each decoration gates the hover `+` affordance (when the line has no line-level comment) and the count badge (when any comment exists on that line). Per HLD key decisions, this plugin is implemented by extending `commentIndicator.ts` so one plugin owns every per-line widget rather than two competing plugins.

## Inputs

Plugin state fields added to the existing `CommentIndicatorState` in `src/webview/commentIndicator.ts:9-16`:

- `llmAssistActive: boolean` — mirror of `reviewMode` but for LLM-Assist. Exactly one of `reviewMode` / `llmAssistActive` is true at a time; the title-bar toggles mutually gate each other (see LlmToggle).
- `llmComments: LlmComment[]` — snapshot from `LlmCommentStore.getAll()`, refreshed on every `onChange`.

The existing `lineMap` field stays as-is — both modes reuse the same source-line→pos map.

## Outputs

For each line in `lineMap.posToLineRange`, at most one `Decoration.node` is produced:

| Condition | Class | Data attrs |
|---|---|---|
| No comments on the line, node type is commentable | `llm-line-commentable` | none |
| ≥1 comment on the line | `llm-line-commented` | `data-llm-count="N"`, `data-llm-line="${line1}"` |

The `+` on hover is a pure CSS effect on `.llm-line-commentable:hover::after`, matching the `commentIndicator.ts` badge rendering approach (`::after` + `data-comment-count`, verified at `commentIndicator.ts:109-128`). No `Decoration.widget` slot is used, which is why Spike 2a's two-class, single-plugin strategy was viable.

## Commentable node-type set

Per Spike 2b, the filter is:

| Node type | Decorate | Reason |
|---|---|---|
| `paragraph`, `heading`, `list_item`, `task_item`, `code_block` | Yes | Leaf-commentable block units. |
| `table` | Yes, whole table | One `+` per table; avoids cell-level noise. The `+` sits at the top-left of the table. |
| `blockquote` | No | Container. Its inner paragraphs already get decorated. Exception covered naturally: GFM alert blockquotes still get decorated via their inner paragraph. |
| `bullet_list`, `ordered_list`, `task_list` | No | Containers; children are decorated instead. |
| `table_row`, `table_cell`, `table_header` | No | Too granular for the UX. |
| `horizontal_rule` | No | Nothing to comment on. |

## Walk algorithm

1. Iterate the entries of `lineMap.posToLineRange`. Each entry is `(pos, { startLine, endLine })` where lines are 0-indexed.
2. For each pos, call `doc.nodeAt(pos)` to get the node.
3. If `node == null` or `node.type.name` is not in the commentable set, skip.
4. Convert to 1-indexed: `line1 = startLine + 1` (the store, the panel, and the payload all use 1-indexed line numbers).
5. Count the comments for this line: `count = llmComments.filter(c => c.startLine <= line1 && line1 <= c.endLine).length`.
6. Emit either the `llm-line-commentable` decoration (count == 0) or the `llm-line-commented` decoration with the count and line attrs.

The existing Review-mode decoration emission in `buildDecorations` (`commentIndicator.ts:65-168`) is preserved verbatim and is gated on `reviewMode`. A new branch, gated on `llmAssistActive`, runs the above algorithm. The two branches are exclusive: the `buildDecorations` early-out at `commentIndicator.ts:44-46` grows one check — return empty if neither mode is active and the line map is unset.

## Configuration

None at runtime. The commentable node-type set is a const in the plugin module.

## Error handling

- Stale `lineMap`: if a pending edit has advanced the ProseMirror doc past the line map's view, `doc.nodeAt(pos)` can return a node whose type no longer matches what the line map recorded. The filter step naturally drops these; no error path is needed. The plugin re-runs on every doc change via the standard ProseMirror `apply` path.
- `findPosForLine` returning `null` for a line (source line with no ProseMirror counterpart) — skip the line, emit no decoration. Matches `commentIndicator.ts:96-99`.

# LlmSelectionAnchor (the selection `+` button)

## Purpose

The text-level flow's entry point. A floating `+` button that appears above a non-collapsed selection while LLM-Assist is active, anchored to the selection using the same `view.coordsAtPos` trick already used by `linkDialog.ts:20-36` (Spike 5).

## Inputs

- `editor: Editor` — needed for `view.coordsAtPos`.
- `store: LlmCommentStore` — needed so the click handler can emit a new `LlmComment`.
- `panel: LlmCommentPanel` — opened on click.

## Outputs

A single `<button class="llm-selection-plus">+</button>` in `document.body`, shown/hidden on `selectionchange`. Its screen position tracks the current selection range.

## Behaviour

1. On `selectionchange`:
   - If `llmAssistActive` is false → hide, return.
   - If `window.getSelection()` is null, collapsed, or has zero ranges → hide, return.
   - If the selection is entirely outside the editor element (e.g. in a panel textarea) → hide, return.
   - Otherwise → compute screen coords using `positionNearSelection(btn, editor)` (a copy of `positionOverlay` from `linkDialog.ts:20-36`, renamed and placed in a new `src/webview/llmSelectionAnchor.ts`).
2. On click:
   - Read the current selection range: `{ from, to } = editor.view.state.selection`.
   - Resolve start and end source lines via `findLineForPos(lineMap, from)` and `findLineForPos(lineMap, to - 1)`; convert both to 1-indexed.
   - Generate a `commentId` via the same helper `LlmComment.id` uses.
   - Apply the mark immediately via `editor.chain().focus().setLlmComment({ commentId }).run()`. This wraps the selection in the highlighted span right away — the user gets visual feedback before they've typed anything.
   - Open `LlmCommentPanel` in "new text-level comment" mode with the anchor rect of the first span carrying this `commentId`.
   - On panel Save, the store gets a new `LlmComment` with the generated `commentId`.
   - On panel cancel (close without save), the mark must be unwound via `unsetLlmCommentById(commentId)` to avoid orphan highlights.

## Configuration

None.

## Error handling

- Viewport-edge overflow: `positionNearSelection` gains a right-edge clamp (Spike 5 flagged this as a gap in `linkDialog.ts`). If `btn.left + btn.width > window.innerWidth - 16`, push `left = window.innerWidth - btn.width - 16`.
- Empty `lineMap` (before first build): the whole selection anchor short-circuits to hidden. The toggle-on path guarantees the line map exists before `llmAssistActive` flips true — see LlmToggle behaviour.

# LlmCommentPanel

## Purpose

Floating popover that opens for either anchor type. Contains a textarea plus Save / Copy / Delete buttons. Implemented by extending `CommentPanel` in `src/webview/commentPanel.ts` with a `mode` branch, per Spike 4's REUSABLE verdict.

## Interface

New public methods added to `CommentPanel`:

- `openLlmLine(line1: number, anchorEl: HTMLElement)` — open for a line-level new-or-existing comment. The panel lists every comment on the line (line-level first, then text marks in `createdAt` order). If the line has no comments yet, the list section is empty and the textarea is focused for the first new comment.
- `openLlmText(commentId: string, anchorEl: HTMLElement)` — open pre-filled with the text-level comment's existing body; Save updates, Delete removes.
- `openLlmNewText(commentId: string, anchorEl: HTMLElement)` — open for a just-created, not-yet-saved text-level comment. Same shape as `openLlmText` but the body is empty and Delete (or close-without-save) also runs `unsetLlmCommentById(commentId)` on the editor.

The constructor gets a new optional parameter:

- `llmStore?: LlmCommentStore` — the LLM-Assist store. Used only by the three `openLlm*` entry points; the existing thread methods ignore it.
- `editor?: Editor` — needed so the panel can dispatch `unsetLlmCommentById` on delete/cancel. The existing thread methods don't need it but the param is safe to add to the constructor.

## Internal `mode` branching

`buildPanel` gains a `mode: 'thread' | 'llm-assist'` field in its options object. When `mode === 'llm-assist'`:

1. Skip the loops at `commentPanel.ts:168-173` that call `renderComment` and `renderPendingComment`. In place, render a list of `LlmComment` entries (see below).
2. Skip the `hasPendingAlready` guard at `commentPanel.ts:179-196`. Always render the reply section.
3. Rename the "Queue" button to "Save". It calls a new `onLlmSaveClick` handler instead of `onQueueClick`.
4. Render a "Copy" and "Delete" button next to Save, in the same row.
5. Do not call `subscribeToStore` for LLM-Assist — the thread-store subscription assumes `PendingCommentStore`. A parallel subscription to `llmStore` is registered separately and drives list re-rendering only.

## LlmComment list item rendering

Each `LlmComment` in the panel's list renders a lightweight entry:

- A short label: `Line` for `kind: 'line'`, or the first 30 chars of the quoted text for `kind: 'text'` with an ellipsis.
- The body text, rendered with `textContent` (no HTML, no markdown parsing).
- A row of three buttons: Edit, Copy, Delete.
  - Edit: replaces the body with an inline textarea pre-filled with the current body; Save writes back via `store.update`.
  - Copy: calls `navigator.clipboard.writeText(entry.body)` — just the body, not the payload format. Meant for quickly grabbing one note.
  - Delete: calls `store.remove(entry.id)`; for `kind: 'text'` it also runs `unsetLlmCommentById(entry.id)` on the editor.

These are purely additive or purely destructive — Copy never removes, Delete never copies. Matches HLD principle.

## Positioning

`positionPanel` (`commentPanel.ts:315-330`) is used verbatim — Spike 4 confirmed it has zero thread-state references.

## Close handlers

`registerCloseHandlers` (`commentPanel.ts:332-354`) is used verbatim. The textarea-focus guard at line 336-337 already protects against accidental close while typing.

## Error handling

- Empty textarea on Save: no-op (the button does nothing). Matches the existing `onQueueClick` behaviour at `commentPanel.ts:276-278`.
- Close-without-save in `openLlmNewText` mode: runs `unsetLlmCommentById(commentId)` so the highlight disappears. This is wired via the close path, not the textarea blur — the textarea-focus Escape guard still applies.

# LlmToggle

## Purpose

Title-bar button + second-row bar for LLM-Assist, mirroring the `CommentToggle` DOM shape but with no PR badge, no refresh, no staleness timer, no submit/discard confirmation states.

## Interface

- Constructor: `new LlmToggle(editor, vscode, store, panel, commentToggle)` where `commentToggle` is the existing Review-mode toggle. Needed so LLM-Assist can refuse to activate while Review is active, and vice versa — see Behaviour.
- `toggle()`: public entry point used both by the button click and by the VS Code command.
- `isActive(): boolean`

## DOM shape

Row 1 — title-bar button:
- `<button class="llm-toggle">Assist: Off</button>` — text flips to `Assist: On` when active.

Row 2 — action strip (hidden via `display: none` when inactive OR when `store.getCount() === 0`, matching `commentToggle.ts:241`):
- `<button class="llm-copy-all">Copy all (N)</button>`
- `<button class="llm-clear-all">Clear all (N)</button>`

Both buttons' labels are re-rendered on every `store.onChange` via the same pattern as `commentToggle.ts:238-250`.

## Behaviour

1. `toggle()` called while inactive:
   - If `commentToggle.isActive()` → show a transient error ("Review mode is active — toggle it off first") and return. Mutual exclusion is enforced here because the plugin's decoration branches are exclusive.
   - Build the line map (same code path `index.ts:51-54` already runs on `commentData`): `buildLineMap(editor.state.doc, markdown, md)`.
   - Flip `llmAssistActive = true` in the plugin state via `updateCommentIndicatorState`.
   - Register a `editor.on('update', ...)` handler that rebuilds the line map on every doc change and re-publishes plugin state. This is the path that keeps gutter decorations in sync with in-session edits.
   - Show the action row (still empty-gated on `store.getCount() === 0`).
2. `toggle()` called while active:
   - Call `store.clear()`. Every listener fires; the gutter re-renders with zero decorations; the panel closes if open.
   - Call `editor.commands.unsetLlmCommentById('*')` equivalent: actually, implement this as a dedicated `editor.commands.clearAllLlmComments()` that walks the doc once and removes every `llmComment` mark in a single transaction.
   - Flip `llmAssistActive = false`; detach the update listener.
   - Hide the second row; reset the title-bar button text.
3. VS Code command `liveMarkdown.toggleLlmAssist`: the command (registered in `extension.ts`) sends a `postMessage({ type: 'toggleLlmAssist' })` to the active webview. `index.ts` routes this message to `LlmToggle.toggle()`. No new protocol type is needed on the webview→extension path.

## Copy all click

1. `store.toPayload(editor, workspaceRelativePath)` returns the clipboard string.
2. If the string is non-empty, call `navigator.clipboard.writeText(payload)`.
3. On success: flash the button label from `Copy all (N)` to `Copied ✓` for 1500 ms, then restore.
4. On clipboard write rejection (the Promise from `writeText` rejects): set the button label to `Copy failed` for 3000 ms and log to `console.warn`. No further action.

`workspaceRelativePath` is stashed on the toggle at construction time from a new `workspaceRelativePath` field on the `InitMessage` (see Data Formats).

## Clear all click

1. `store.clear()` — fires the onChange chain; the plugin state refreshes with zero comments.
2. `editor.commands.clearAllLlmComments()` — strips every mark from the doc in one transaction.
3. No confirmation. Matches `commentToggle.ts:233-236`.

## Error handling

- Clipboard write rejection: see above.
- Attempting to activate while Review is active: silent error banner, no state change.

# Data Formats

## Clipboard payload

Exact format emitted by `LlmCommentStore.toPayload`. All fields are verbatim strings except the line-range header, which is produced by the existing `formatLineHeader` helper reused from `commentPanel.ts:403-408`.

```
File: <workspace-relative path>

<block-1>

-----

<block-2>
```

Each block:

```
<line-range-header> — Selected text:
"""
<verbatim quoted text>
"""

<comment-label>:
"""
<verbatim comment body>
"""
```

Rules, all load-bearing:

- `<line-range-header>` is `Line N` for a 1-line anchor and `Lines N-M` for a multi-line anchor. `formatLineHeader(line, startLine)` with `isNew=false` produces exactly this string.
- `<verbatim quoted text>` is the text content the store extracts at copy time (see LlmComment Shape). No trimming, no normalisation, no escape sequences — triple-quote fences survive markdown headings, code fences, tables, and backticks inside the quoted content.
- `<comment-label>` is `Comment:` if the payload has exactly one block total, and `Comment-1:`, `Comment-2:`, ... if it has more than one. Numbering is global across the payload, not per-file (there is only one file in a payload).
- The separator between blocks is exactly five dashes on their own line: `-----`. No surrounding whitespace other than the required blank lines before and after.
- Block ordering: by `startLine` ascending, then `kind: 'line'` before `kind: 'text'`, then by `createdAt` ascending.
- `File:` header is emitted once at the top, then one blank line, then blocks separated by `\n\n-----\n\n`.
- `workspace-relative path` is computed on the extension side via `vscode.workspace.asRelativePath(document.uri, false)` and sent to the webview in the init message. The webview never derives this string itself.

## Example (single comment)

```
File: docs/design.md

Line 42 — Selected text:
"""
retainContextWhenHidden: true avoids re-parsing markdown on tab switches
"""

Comment:
"""
Expand this with a concrete example.
"""
```

## Example (two comments)

```
File: docs/design.md

Lines 5-7 — Selected text:
"""
The moment the user selects a range, a small floating toolbar appears.
The toolbar contains a single Comment button.
"""

Comment-1:
"""
Rewrite this more formally.
"""

-----

Line 42 — Selected text:
"""
retainContextWhenHidden: true avoids re-parsing markdown on tab switches
"""

Comment-2:
"""
Expand this with a concrete example.
"""
```

## InitMessage extension

One field is added to `InitMessage` in `src/sync/syncProtocol.ts:5-10`:

- `workspaceRelativePath?: string` — the workspace-relative path of the document, produced by `vscode.workspace.asRelativePath(document.uri, false)`. Optional so older message handlers keep working during a mixed deploy of the two bundles. The webview caches it on the `LlmToggle` constructor; if absent, the copy flow falls back to the basename of the document URI.

No other protocol types change. No new webview→extension message is added.

## Webview → webview toggle message

The VS Code command `liveMarkdown.toggleLlmAssist` sends a plain `postMessage({ type: 'toggleLlmAssist' })` to the webview panel. This message is NOT added to `WebviewToExtensionMessage` or `ExtensionToWebviewMessage` because it is a side-channel control message that never participates in document sync. It is handled in `index.ts` alongside `commentData` etc. with a small type check.

# Integration & Lifecycle

## Module layout

| File | Role | Status |
|---|---|---|
| `src/webview/llmCommentStore.ts` | New — in-memory store | New |
| `src/webview/llmCommentMark.ts` | New — TipTap mark extension | New |
| `src/webview/llmSelectionAnchor.ts` | New — selection `+` button + positioning helper | New |
| `src/webview/llmToggle.ts` | New — title bar + action row | New |
| `src/webview/commentIndicator.ts` | Modify — add `llmAssistActive`, `llmComments` to `CommentIndicatorState`; add a mutually-exclusive decoration branch | Modify |
| `src/webview/commentPanel.ts` | Modify — add `mode` parameter to `buildPanel`, three new entry points for LLM-Assist flows | Modify |
| `src/webview/editor.ts` | Modify — register `LlmCommentMark` extension in the `createEditor` extension list, alongside `Link`, `Markdown`, etc. | Modify |
| `src/webview/index.ts` | Modify — instantiate `LlmCommentStore`, `LlmToggle`, `LlmSelectionAnchor`; wire the toggle message handler | Modify |
| `src/sync/syncProtocol.ts` | Modify — add `workspaceRelativePath?: string` to `InitMessage` | Modify |
| `src/extension.ts` | Modify — register `liveMarkdown.toggleLlmAssist` command | Modify |
| `src/markdownEditorProvider.ts` | Modify — pass `workspaceRelativePath` into the init message that `DocumentSyncManager` emits | Modify |
| `src/sync/documentSync.ts` | Modify — populate the new init field from the computed relative path | Modify |
| `package.json` | Modify — add the command contribution and keybinding (none for V1 per HLD) | Modify |

## Mount sequence (webview)

In `src/webview/index.ts`, after the existing Review-mode wiring:

1. `const llmStore = new LlmCommentStore()`
2. `const llmToggle = new LlmToggle(editor, vscode, llmStore, commentPanel, commentToggle)`
3. `const llmSelection = new LlmSelectionAnchor(editor, llmStore, commentPanel)`
4. Register the `llmCommentMark` extension inside `createEditor` (in `editor.ts`), not at mount time — marks must be part of the schema at editor construction.
5. On receipt of `toggleLlmAssist` postMessage → call `llmToggle.toggle()`.
6. On receipt of `init` postMessage → cache `workspaceRelativePath` on `llmToggle` for use at copy time.

The Review-mode init sequence is untouched. Both toggles coexist on the page but are mutually exclusive at runtime.

## Mount sequence (extension host)

In `src/extension.ts`, alongside the existing `toggleCmd` registration:

1. Register `liveMarkdown.toggleLlmAssist` via `vscode.commands.registerCommand`. The handler walks the active tab, grabs the webview panel via `MarkdownEditorProvider`, and posts `{ type: 'toggleLlmAssist' }`.
2. `MarkdownEditorProvider` gains a small accessor: `getWebviewForUri(docUri: string): Webview | undefined` (a read of `anchorStates.get(docUri)?.webview`). Used by the command handler above.
3. In `MarkdownEditorProvider.resolveCustomTextEditor`, compute `workspaceRelativePath = vscode.workspace.asRelativePath(document.uri, false)` and pass it to `DocumentSyncManager`, which in turn includes it in the `init` message it emits.

## Lifecycle (runtime)

Startup (extension):

- Command registered on activate.
- `MarkdownEditorProvider` unchanged apart from the relative-path piping.

Document open:

- Init message includes `workspaceRelativePath`. Webview caches it on `llmToggle`.

Toggle on:

- `LlmToggle.toggle()` → build line map → flip plugin state → register editor update listener → show action row (empty).

Line flow:

- Hover a commentable line → CSS `:hover::after` renders `+`.
- Click `+` → `LlmCommentPanel.openLlmLine(line1, anchorEl)`.
- Save → `store.add({ kind: 'line', startLine: line1, endLine: line1, body, ... })` → onChange fires → plugin re-renders → badge appears → action row shows.

Text flow:

- Selection fires `selectionchange` → `LlmSelectionAnchor` shows `+` above selection.
- Click `+` → generate `commentId` → `editor.chain().setLlmComment({ commentId }).run()` → `LlmCommentPanel.openLlmNewText(commentId, anchorEl)`.
- Save → `store.add({ kind: 'text', startLine, endLine, body, id: commentId, ... })` → onChange fires → plugin re-renders (count incremented).
- Close without save → `unsetLlmCommentById(commentId)`.

Click an existing highlight:

- DOM click on `[data-llm-comment-id]` → read id from `closest` → `store.get(id)` → `commentPanel.openLlmText(id, spanEl)`.

Click an existing badge:

- DOM click on `.llm-line-commented` → read `data-llm-line` → `commentPanel.openLlmLine(line1, lineEl)`.

Copy all:

- `store.toPayload(editor, workspaceRelativePath)` → `navigator.clipboard.writeText(payload)`.

Clear all:

- `store.clear()` + `editor.commands.clearAllLlmComments()` — wipes both the store and the marks.

Toggle off:

- Same as Clear all, then detach update listener, flip plugin state, hide row.

Tab close / reload / extension disable:

- Nothing to clean up. The webview is destroyed; the store and marks die with it.

# Error Handling

| Scenario | Behaviour |
|---|---|
| `navigator.clipboard.writeText` Promise rejects (permission lost mid-session) | Button label flips to `Copy failed` for 3000 ms, `console.warn` logs the error. No fallback path. |
| Toggle-on while Review mode is active | Transient error banner `Review mode is active — toggle it off first`. State unchanged. |
| Selection `+` click with an empty `lineMap` | Silent no-op; the button is hidden when the line map is unavailable. |
| `store.get(id)` returns undefined on a DOM click (mark was removed between frame and click) | Handler returns silently. |
| `findLineForPos` returns null for either end of a text selection | Fallback: round the pos to the nearest mapped line via `lineMap.posToLineRange`. If both ends miss, silently drop the creation (rare — only happens mid-transaction). |
| Empty textarea on Save | Button does nothing. No error shown. |
| `toPayload` called with zero comments | Returns empty string; caller suppresses the clipboard write. |
| Mark serialised into saved markdown (regression check) | The mark's markdown serialiser emits `open: ''`, `close: ''`, so the wrapped text round-trips as plain text. A smoke test in `src/__tests__/unit/llmCommentMark.test.ts` asserts that a doc containing `llmComment` marks serialises to the same markdown as the same doc without them. |
| Line number changes mid-session due to in-session edits | Decorations re-run on every doc update (the editor `update` listener rebuilds the line map and re-publishes plugin state). Stored `startLine`/`endLine` on existing comments are NOT re-anchored — the HLD explicitly lists in-session re-anchoring as a non-goal. A user who edits and then hits Copy all gets the stored line numbers; the quoted text is still correct because it's read live. |

# External Dependency Contracts

## `navigator.clipboard.writeText(text: string): Promise<void>`

- **Status:** Verified (Spike 3, `docs/feat/plans/spike-results/03-clipboard.md`).
- **Call site:** `LlmToggle.onCopyAllClick` and `LlmCommentPanel`'s per-entry Copy button.
- **Input:** a plain string (payload format above, or a single comment body).
- **Output:** a Promise that resolves when the clipboard has been written. Rejects on permission failure.
- **Evidence:** Spike 3 read the CSP directive at `src/markdownEditorProvider.ts:190`. No directive blocks the Clipboard API. VS Code 1.96.0 (engine floor) is past the 1.64 threshold at which clipboard write was enabled for trusted webview origins.
- **Gotcha:** A failed Promise is possible in theory (permission revoked). The HLD accepts this as a surface error; the LLD surfaces it via the `Copy failed` button label.

## TipTap `Mark.create({ excludes: '', ...})`

- **Status:** Verified (Spike 1, `src/__tests__/spikes/llmCommentMark.spike.test.ts`).
- **Call site:** `src/webview/llmCommentMark.ts`.
- **Input:** a mark definition object with `excludes: ''`.
- **Output:** a TipTap mark whose instances with distinct `commentId` attrs stack freely on overlapping ranges.
- **Evidence:** Spike 1 output recorded `HTML after overlapping marks: <p>The <span data-comment-id="A">quick <span data-comment-id="B">brown</span></span>...</p>` and `Mark IDs at overlap region: [ 'A', 'B' ]`.
- **Gotcha:** Without `excludes: ''`, ProseMirror's default exclusion logic drops the second mark. This is the single line that makes the text-level flow viable.

## TipTap `tiptap-markdown` mark serialiser contract

- **Status:** Documented (`tiptap-markdown` README and source under `node_modules/tiptap-markdown/src/extensions/marks/`). The library reads `storage.markdown.serialize` from each mark extension; providing `{ open: '', close: '', mixable: true }` makes the mark emit the wrapped text without any markdown markers.
- **Call site:** `src/webview/llmCommentMark.ts` in `addStorage`.
- **Input:** a storage object with the markdown serialiser fields above.
- **Output:** at `Cmd+S` time, the mark is effectively invisible in the saved markdown.
- **Gotcha:** If the library's behaviour changes in a future version, regression risk is a leaked `<span data-llm-comment-id>` in the saved file. A smoke test (see Error Handling table) guards this.

## ProseMirror `Decoration.node(pos, pos + node.nodeSize, attrs)`

- **Status:** Verified (Spike 2a + existing `commentIndicator.ts:121-128` read).
- **Call site:** `src/webview/commentIndicator.ts` in the extended `buildDecorations`.
- **Input:** start pos (positive integer pointing at the start of a block node), end pos (start + `node.nodeSize`), attrs object including `class` and any `data-*` fields.
- **Output:** a `Decoration` whose attrs are applied to the rendered block DOM node.
- **Evidence:** `commentIndicator.ts:121-128` already uses this exact API for the review-mode badge.

## `LineMap.posToLineRange` / `findLineForPos`

- **Status:** Verified (`src/webview/lineMap.ts` read; `commentIndicator.ts:94-104` consumes it).
- **Call site:** `LlmGutterPlugin` walk; `LlmSelectionAnchor` click handler.
- **Input:** a built `LineMap` for the current doc.
- **Output:** `posToLineRange` is a `Map<number, { startLine: number; endLine: number }>` where both line fields are 0-indexed; `findLineForPos` returns the 0-indexed source line for a pos, or null.
- **Evidence:** `lineMap.ts:4-11` type definition; `commentIndicator.ts:96` uses `findPosForLine` on 0-indexed inputs.
- **Gotcha:** Line numbers in the store and payload are 1-indexed; every call site converts at the boundary.

## `view.coordsAtPos(pos): { left, right, top, bottom }`

- **Status:** Verified (Spike 5, `src/webview/linkDialog.ts:23-24`).
- **Call site:** `LlmSelectionAnchor.positionNearSelection`.
- **Input:** a ProseMirror pos in the current document.
- **Output:** viewport coordinates usable directly with `position: fixed`.
- **Evidence:** `linkDialog.ts:20-36` uses this exact pattern and has shipped for the link dialog.
- **Gotcha:** No viewport-edge clamping in `linkDialog.ts`; the LLD adds it for the selection anchor.

## `vscode.workspace.asRelativePath(uri, false)`

- **Status:** Verified (`src/gh/commentHandler.ts:284` already uses it to compute the file path for the existing Review mode's GitHub submit path).
- **Call site:** `src/markdownEditorProvider.ts` `resolveCustomTextEditor`.
- **Input:** the document URI.
- **Output:** a workspace-relative path string, or the full path if the URI is outside any workspace folder.
- **Evidence:** `commentHandler.ts:284` and the corresponding unit test in `src/__tests__/unit/commentHandler.test.ts:7` mock it.
- **Gotcha:** the `false` second argument omits the workspace folder name prefix — the HLD's `File: docs/design.md` convention needs this. Reading with the default (`true`) would produce `File: workspace-name/docs/design.md`, which clutters the LLM prompt.

## `vscode.commands.registerCommand(commandId, handler)`

- **Status:** Verified (`src/extension.ts:155` registers `liveMarkdown.toggleRawMarkdown` via the same API).
- **Call site:** `src/extension.ts` `activate`.
- **Input:** command id string and a handler function.
- **Output:** a `Disposable` the caller pushes to `context.subscriptions`.
- **Evidence:** existing `toggleCmd` registration at `extension.ts:155-263`.

# Files Changed Summary

| File | Action | Description |
|---|---|---|
| `src/webview/llmCommentStore.ts` | New | In-memory store with `add`/`remove`/`update`/`clear`/`get`/`getAll`/`getCount`/`getForLine`/`onChange`/`toPayload` |
| `src/webview/llmCommentMark.ts` | New | TipTap `Mark` extension `llmComment` with `excludes: ''`, `addAttributes({ commentId })`, and markdown storage that emits `open: ''`, `close: ''` |
| `src/webview/llmSelectionAnchor.ts` | New | Selection-anchored `+` button; `positionNearSelection` helper (copy of `positionOverlay` with right-edge clamp) |
| `src/webview/llmToggle.ts` | New | Title-bar button + second-row action strip; `toggle()`, Copy all, Clear all; consumes `store`, `panel`, `commentToggle` |
| `src/webview/commentIndicator.ts` | Modify | Extend `CommentIndicatorState` with `llmAssistActive` and `llmComments`; add a mutually-exclusive decoration branch; reuse `lineMap` walk and `Decoration.node` emitter |
| `src/webview/commentPanel.ts` | Modify | Add `mode: 'thread' \| 'llm-assist'` branching in `buildPanel`; add `openLlmLine`, `openLlmText`, `openLlmNewText`; rename "Queue" to "Save" in llm-assist mode |
| `src/webview/editor.ts` | Modify | Register `LlmCommentMark` in the extension list |
| `src/webview/index.ts` | Modify | Instantiate store, toggle, selection anchor; route `toggleLlmAssist` postMessage; cache `workspaceRelativePath` from `init` |
| `src/sync/syncProtocol.ts` | Modify | Add optional `workspaceRelativePath` to `InitMessage` |
| `src/sync/documentSync.ts` | Modify | Populate `workspaceRelativePath` in the `init` message emission |
| `src/markdownEditorProvider.ts` | Modify | Compute `workspaceRelativePath` from `vscode.workspace.asRelativePath`; expose `getWebviewForUri` for the command handler |
| `src/extension.ts` | Modify | Register `liveMarkdown.toggleLlmAssist` command; route to active webview via `getWebviewForUri` |
| `package.json` | Modify | Add command contribution (no keybinding per HLD V1) |
| `src/__tests__/unit/llmCommentStore.test.ts` | New | Unit tests: payload formatting, `getForLine` filter, ordering rules |
| `src/__tests__/unit/llmCommentMark.test.ts` | New | Smoke test: a doc with `llmComment` marks serialises identically to a doc without them (serialiser regression guard) |
| `src/__tests__/unit/llmGutterPlugin.test.ts` | New | Filter test: only commentable node types get decorated; list items and table rows both produce the expected counts |
| `src/webview/styles.css` | Modify | Add `.llm-line-commentable:hover::after`, `.llm-line-commented::after`, `.llm-comment-mark`, `.llm-selection-plus`, `.llm-toggle`, `.llm-bar`, `.llm-actions-row` rules; theme-aware via `var(--vscode-*)` |

# Next Step

Run `/write:test-plan` to define the verification strategy (manual test matrix for the five lifecycle transitions + the two anchor flows, plus the unit tests listed above), then `/write:task-breakdown` to split the work into implementation phases.

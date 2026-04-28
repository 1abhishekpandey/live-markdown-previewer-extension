LLM-Assist Mode - High-Level Design

Status: Draft
Owner: Abhishek
Last updated: 2026-04-12

# Overview

LLM-Assist is an in-editor mode that lets the author of a markdown document point at a specific line or phrase, attach a natural-language note to it, and copy a single structured payload that any LLM chat can consume directly. The mode is local, ephemeral, and never talks to a server: its only output is a block of text the user pastes wherever they want to work with the LLM. It extends the Live Markdown WYSIWYG editor so iterating on a spec, PR description, or design note with an LLM stops requiring the author to describe locations in prose.

# Principles

- Comments exist only for the lifetime of a single LLM-Assist session. There is no sidecar file, no workspace state, no cross-session recovery — the webview's memory is the only backing store.
- The payload, not the UI, is the product. Every design decision is graded by how unambiguously it lets an LLM identify the target text and the human's instruction on the other end of a copy-paste.
- Two commenting granularities coexist on the same line: one line-level comment and any number of phrase-level comments. The payload format is identical for both — the quoted text is either the whole line or the selected substring.
- Reuse the existing Review-mode patterns (toggle + second-row bar, floating comment panel, per-line decorations, count-in-button-label) rather than inventing parallel primitives. Divergences are limited to where semantics genuinely differ.
- Copy actions never clear. Clear actions never copy. Every mutation is either purely additive or purely destructive, never both.

# Goals

- An author can toggle LLM-Assist on, hover a line, click a gutter "+", type a note, and see the line highlighted with a badge showing the comment count — without any other setup.
- An author can select a phrase inside a line, click a selection-anchored "+", type a note, and see the phrase highlighted as a new inline mark — on the same line as any existing line-level comment, without conflict.
- A single click on "Copy all" yields a clipboard payload that an LLM can parse unambiguously: one `File:` header, per-comment `Line N`/`Lines N-M` headers, triple-quote-fenced selections and comment bodies, and `-----` separators between blocks.
- A single click on "Clear all" removes every comment and highlight from the current session with no confirmation dialog, matching the existing Review mode's discard semantics.
- Toggling LLM-Assist off wipes every comment and highlight so the next toggle-on starts from a blank session. No cleanup prompt, no confirmation.

# Non-Goals

- No LLM API integration inside the extension. The extension produces a payload; the user pastes it wherever. The extension never makes a network call for this feature.
- No cross-session persistence. Comments die on toggle-off, tab close, extension disable, VS Code restart, and "Clear all" click. There is no "reload the doc and reattach comments" problem to solve because the design does not attempt to solve it.
- No threads, authors, timestamps, `Outdated`/`Draft`/`Pending` markers, or resolved state. A comment is a single body attached to a single anchor.
- No integration with VS Code's native Comments API gutter. Considered for a later phase; out of scope for V1.
- No re-anchoring after external edits. If the underlying document changes while a comment is attached, anchors may drift — the session is ephemeral, so the user clears and re-comments.
- No paste-size handling for long documents. "Copy all" is a single blob. If a real document hits a clipboard ceiling, that is future work.
- No keyboard shortcuts. Every affordance is driven by hover, selection, and click.

# Architecture

LLM-Assist runs entirely inside the webview. The extension host is not involved except for the `liveMarkdown.toggleLlmAssist` command binding — the clipboard write goes directly through `navigator.clipboard.writeText` in the webview (Spike 3 verified the CSP permits it; no `postMessage` round-trip needed).

```
┌──────────────────────────────────────────────────────────────┐
│ Webview (browser)                                            │
│                                                              │
│  ┌──────────────┐   ┌────────────────┐   ┌───────────────┐   │
│  │ LlmToggle    │──►│ LlmCommentBar  │   │ TipTap Editor │   │
│  │ (title bar)  │   │ (second row)   │   │               │   │
│  └──────┬───────┘   │  Copy all (N)  │   │ ┌───────────┐ │   │
│         │           │  Clear all (N) │◄──┤ │LlmComment │ │   │
│         │           └───────┬────────┘   │ │Mark (new) │ │   │
│         │                   │            │ └───────────┘ │   │
│         │                   │            │ ┌───────────┐ │   │
│         ▼                   │            │ │LlmGutter  │ │   │
│  ┌──────────────────────────▼────────┐   │ │Plugin(new)│ │   │
│  │ LlmCommentStore (in-memory)       │◄──┤ └───────────┘ │   │
│  │  add/remove/clear/getAll/onChange │   └───────┬───────┘   │
│  └──────────┬────────────────────────┘           │           │
│             │                                    ▼           │
│             │               ┌────────────────────────────┐   │
│             └──────────────►│ LlmCommentPanel (floating) │   │
│                             │  textarea + Save/Copy/Del  │   │
│                             └────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                     │
                     ▼
            navigator.clipboard.writeText
            (direct webview API; CSP permits it)
```

Components:

- **LlmToggle** — a title-bar button that flips `llmAssistActive` and (when on) reveals the `LlmCommentBar`. Mirrors `commentToggle.ts`. Registers the `liveMarkdown.toggleLlmAssist` VS Code command.
- **LlmCommentBar** — the second-row action strip containing `Copy all (N)` and `Clear all (N)`. Hidden entirely when the mode is off. When the mode is on but no comments exist, the action row is `display: none` so the chrome stays minimal. Mirrors `commentToggle.ts:238-250`.
- **LlmCommentStore** — the in-memory store of `LlmComment` records. Exposes `add`, `remove`, `clear`, `getAll`, `getCount`, `onChange`. Shape mirrors `PendingCommentStore` but drops the `postMessage({type: 'savePendingQueue'})` call on every mutation — this is the key divergence that makes the store ephemeral instead of persistent.
- **LlmGutterPlugin** — a new ProseMirror plugin that decorates every **commentable** block node with a hover-sensitive widget: renders `+` on hover when the node has no line-level comment, renders the total comment count `N` (line-level + text-level combined) once any comment exists on it. Extends the pattern in `commentIndicator.ts` by walking `lineMap.posToLineRange` (the same source-line→position map the existing Review mode uses) and filtering to the commentable node-type set: `paragraph`, `heading`, `list_item`, `task_item`, `code_block`, `table`. Containers (`blockquote`, `bullet_list`, `ordered_list`, `task_list`, `table_row`, `table_cell`, `table_header`) and `horizontal_rule` are skipped so the `+` sits on the leaf-commentable unit without double-counting. A naïve `doc.forEach` walk over top-level children is **wrong** — it misses every list item, nested paragraph, and table row; confirmed during Spike 2b visual check.
- **LlmCommentMark** — a new TipTap inline mark that wraps a selected text range with a class and a comment identifier. Rendered as a highlighted span. Clicking the span opens the panel pre-filled with that comment's body.
- **LlmCommentPanel** — a floating popover positioned to the right of the clicked line or above the clicked selection. Contains a textarea, a Save button, a Copy button, and a Delete button. Close on Escape or click-outside. Mirrors `commentPanel.ts` with the thread UI stripped (no author, no timestamps, no reply section, no Outdated/Draft/Pending markers).

Lifecycle:

- On toggle-on: `LlmCommentBar` mounts, `LlmGutterPlugin` activates, `LlmCommentMark` becomes clickable.
- On toggle-off: store `clear()`, bar unmounts, plugin deactivates, every `LlmCommentMark` is stripped from the doc. No confirmation.
- On tab close, extension disable, or window reload: webview is destroyed; the store goes with it. No cleanup code needed.

# Commenting Affordances

Both flows open the same floating panel. The panel content is identical regardless of anchor type: a single textarea, Save / Copy / Delete. The panel does not know or care whether the anchor is a line or a phrase.

## Line-level flow (gutter "+")

1. User hovers a line that has no line-level comment. The `LlmGutterPlugin` renders a `+` in the left margin for that line.
2. User clicks `+`. `LlmCommentPanel` opens anchored to the right of the line.
3. User types a note, clicks Save. The line gets a `llm-comment-line` class (background highlight) and the gutter widget switches from `+` to a badge showing the total comment count on that line.
4. On a line that already has a line-level comment, the `+` is suppressed on hover. The badge still grows as text-level comments are added to the same line.
5. Clicking the highlight or the badge opens a panel listing every comment on that line — line-level first, then text-level in document order — each with Edit / Copy / Delete.

## Text-level flow (selection "+")

1. User selects a phrase inside a line. A BubbleMenu-style `+` appears just above the selection.
2. User clicks `+`. `LlmCommentPanel` opens anchored to the selection.
3. User types a note, clicks Save. The selected range is wrapped in an `LlmCommentMark` and rendered as a highlighted span. The gutter badge count on the containing line increments.
4. Multiple text-level comments on the same line are allowed. User can select different phrases and comment on each.
5. Overlapping selections layer a new mark on top of the existing one, creating a second independent comment. This matches GitHub's "new selection = new comment" behaviour.
6. Clicking a highlighted phrase opens the panel pre-filled with that comment's body.

## Invariants

- One line-level comment per line. The gutter `+` is suppressed once the line has one.
- Any number of text-level comments per line, including on lines that already have a line-level comment.
- The gutter badge counts line-level and text-level comments together. A badge of `3` could mean one line-level plus two text-level, or three text-level.
- Panel behaviour and styling are identical across both anchor types.
- No keyboard shortcuts. Hover, selection, click.

# Export Format

The payload is a plain-text block designed to paste directly into an LLM chat. It has four building blocks, in this order:

```
File: <workspace-relative path>

<per-comment block>

-----

<per-comment block>

...
```

Each per-comment block has this shape:

```
Line <N> — Selected text:
"""
<the verbatim quoted text>
"""

Comment[-<k>]:
"""
<the verbatim comment body>
"""
```

Rules:

- The `File:` header appears once at the top and applies to every block in the payload. It uses the workspace-relative path.
- The line-range header is `Line N` for a single-line anchor or `Lines N-M` for a multi-line selection, followed by an em dash and `Selected text:`. The numbering mirrors `formatLineHeader` in `commentPanel.ts:403-408` (verified), so LLM-Assist and the existing Review mode use the same convention.
- Triple-quote fences (`"""`) wrap both the quoted selection and the comment body. Triple quotes survive markdown headings, code fences, tables, and stray backticks inside the fenced content. A `>` blockquote prefix does not — it is lost the moment the selection contains its own `>` lines.
- Numbering is `Comment:` when the payload contains exactly one comment, `Comment-1:`, `Comment-2:`, ... when it contains more than one.
- The separator between blocks is a single line of five dashes, `-----`. Distinct from markdown horizontal rules (`---`, `***`) so it cannot collide with a rule inside the quoted text.
- A single block always includes both the line-range header and the quoted selection, even though they are redundant when the LLM has access to the full doc. The redundancy is intentional: the quoted text works standalone when the user pastes only the payload, and the line number pinpoints the location when the user also pastes the full doc.

## Example: single comment

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

## Example: multiple comments

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

## Why this format indicates intent clearly

- **Labelled blocks tell the LLM what role each piece plays.** `Selected text:` is source; `Comment:` is the human's instruction. No ambiguity about which one the LLM should rewrite.
- **Line numbers plus quoted text is belt-and-braces.** The quoted text alone works even if the LLM has no access to the doc; the line number pinpoints the location when the user also pastes the full doc.
- **Triple-quote fencing is robust to any selected content.** Markdown headings, code fences, tables, and backticks all survive inside `"""` fences.
- **The `-----` separator is unmistakable.** Longer than a markdown horizontal rule, on its own line, no interpretation in any markdown flavour.

Details on how `LlmCommentStore.toPayload()` walks the store and emits this format belong in the LLD.

# Session Lifecycle

A comment's lifetime is bounded by the session. The session ends — and all comments and highlights are wiped — on any of:

- Toggling LLM-Assist off via the title-bar button or the `liveMarkdown.toggleLlmAssist` command.
- Closing the editor tab.
- Disabling the Live Markdown extension.
- Restarting VS Code.
- Clicking "Clear all" in the second-row bar.

Deleting an individual comment via its Delete button removes only that comment and its highlight. Copy actions — single or all — never remove anything. Copy is pure copy.

# Reuse from the Existing Review Mode

The extension already ships a GitHub Review mode across `commentToggle.ts`, `commentIndicator.ts`, `commentPanel.ts`, and `pendingCommentStore.ts`. LLM-Assist reuses those patterns where the semantics match, and forks where they genuinely diverge.

## Reuse

- **Toggle button + second-row bar layout.** `commentToggle.ts` wires a title-bar toggle to a `review-bar` container with child rows. LLM-Assist copies the DOM structure with renamed classes (`llm-toggle`, `llm-bar`, `llm-actions-row`).
- **Count-in-button-label convention.** `commentToggle.ts:238-250` updates `Submit Review (${count})` reactively via `updateSubmitButton` on store changes (verified). LLM-Assist uses the same hook to render `Copy all (N)` and `Clear all (N)`.
- **Action row hidden until there is something to act on.** `commentToggle.ts:241` sets `actionsRow.style.display = 'none'` while the count is zero (verified). LLM-Assist follows suit — the bar itself shows, but the action row stays hidden until the first comment exists.
- **Per-line decoration via `Decoration.node`.** `commentIndicator.ts:121-128` wraps block-level nodes with a class + `data-comment-count` attribute and renders the badge via a CSS `::after` pseudo-element (verified). LLM-Assist's line widget extends this plugin rather than forking it, so one plugin owns every per-line UI element.
- **Floating comment panel.** `commentPanel.ts` already implements floating positioning, click-outside-to-close, Escape-to-close, and textarea text preservation on refresh. LLM-Assist's panel is this one with the thread UI stripped — single body, Save / Copy / Delete, no author/timestamp/reply.
- **Clear-with-no-confirmation.** `commentToggle.ts:233-236` calls `store.clear()` with no prompt (verified). "Clear all" in LLM-Assist matches.
- **`formatLineHeader` numbering.** `commentPanel.ts:403-408` returns `Line N` / `Lines N-M` (verified). LLM-Assist's payload uses the same helper so line numbering stays consistent across the two modes.

## Divergences

- **`LlmCommentStore` cannot reuse `PendingCommentStore`.** `pendingCommentStore.ts:70-72` calls `vscode.postMessage({type: 'savePendingQueue', pending: ...})` on every `add`/`remove`/`clear`, which is incompatible with "in-memory only, no cross-session persistence" (verified). LLM-Assist needs a new store class with the same API shape but no `persist()` method.
- **No sync-protocol additions.** `commentToggle`, `commentRefresh`, `submitReview`, `validateLine` and the other Review-mode protocol messages stay out of LLM-Assist's code path entirely.
- **Toggling off wipes the store.** The existing Review mode hides the bar but keeps the store intact across toggle cycles so pending comments survive. LLM-Assist deliberately wipes on toggle-off.
- **Two anchoring granularities.** The existing Review mode is line-only. LLM-Assist adds phrase-level anchoring via a new `LlmCommentMark` inline mark. Line anchoring extends `commentIndicator.ts`; phrase anchoring is net-new.
- **Two net-new UI pieces.** A hover-activated gutter `+` on uncommented lines (the existing mode only draws the badge after a comment exists), and a selection-anchored `+` rendered BubbleMenu-style above a selection.

# Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Persistence | In-memory only, webview-scoped | The feature is a copy-a-payload tool, not a review tracker. Eliminating persistence removes anchor-drift, orphan-recovery, and sidecar-file work entirely. |
| Anchor granularity | Line-level + phrase-level on the same line | Phrase-level tells the LLM exactly which substring to rewrite; line-level covers the cases where the comment is about the whole line. Supporting both adds one inline mark for disproportionate payload precision. |
| Gutter widget owner | Extend `commentIndicator.ts` | Keeps every per-line widget (existing badges, new `+`, new combined count) inside one ProseMirror plugin. Avoids two plugins fighting over the same decoration surface. |
| Store divergence | Fork to `LlmCommentStore` | `pendingCommentStore.ts:70-72` unconditionally persists on every mutation. Reusing it would require threading a "skip persist" flag through every method, which is noisier than a fresh class with the same API. |
| Comment panel | Reuse `commentPanel.ts` with thread UI stripped | Positioning, click-outside, Escape, and text preservation are already correct. The thread UI is removable without changing those. |
| Toggle-off semantics | Wipe the store on toggle-off | The session is a unit of LLM iteration. Starting a new iteration means starting fresh; carrying stale comments across toggles would surprise the user more than it would save work. |
| Payload line disambiguator | Line numbers + quoted text (both) | Line numbers work when the user pastes the full doc; quoted text works standalone. Including both makes the payload robust to both workflows at negligible cost. |
| Payload fencing | Triple-quote `"""` | Survives markdown headings, code fences, tables, and stray backticks inside the fenced content. `>` blockquote and single-backtick fencing do not. |
| Payload separator | Single-line `-----` | Longer than any markdown horizontal rule, on its own line, no interpretation in any markdown flavour. |
| Clear-all confirmation | None | Matches the existing Review mode (`commentToggle.ts:233-236`). A misclick costs a few notes — recoverable work. |
| Action row visibility when empty | Hidden until first comment | Matches `commentToggle.ts:241`. Keeps chrome minimal on an empty session. |
| Per-comment controls | Edit / Copy / Delete, per comment | Symmetric with "Copy all" / "Clear all": one comment or all, always copy-only or clear-only, never both in the same action. |

# Alternatives Considered

## Persistence model

- **Chosen: in-memory only, cleared on toggle-off.** Comments live in the webview for one session. No sidecar, no workspace state, no cross-session recovery.
- **Alternative: sidecar JSON file.** A `.vscode/llm-assist/<doc-hash>.json` sidecar that restores comments on tab reopen. Rejected: the feature's output is a paste-once payload, so comments that survive a session have no job to do. Persistence would also drag in anchor drift, orphan recovery, and file-rename tracking — all the hard problems this design deliberately sidesteps.
- **Alternative: VS Code `workspaceState`.** Store comments as JSON in the extension's `workspaceState` keyed by document URI. Rejected for the same reason as the sidecar file. The storage mechanism is easier but the semantic problems (drift, orphans, renames) are identical.

## Anchor granularity

- **Chosen: line-level + phrase-level on the same line.** Both affordances coexist. Gutter `+` for line-level, selection `+` for phrase-level, single panel for both.
- **Alternative: line-only (GitHub PR review style).** Ship only the line-level gutter affordance and match GitHub exactly. Rejected: the whole point of the feature is to tell the LLM which substring to rewrite. Line-only forces the author back into "the part I mean is ...", which is the problem the feature exists to eliminate.
- **Alternative: phrase-only.** Drop line-level entirely and require a selection before any comment can be made. Rejected: when the comment applies to the whole line, forcing a selection is friction. The cost of supporting both is one extra affordance and one extra flag in the store; the benefit is the author picks the granularity that matches the comment.

## Copy payload fencing

- **Chosen: triple-quote `"""`.** Strong, LLM-recognised verbatim literal delimiter.
- **Alternative: `>` blockquote prefix.** Each line of the selection gets a `>` prefix. Rejected: the moment the selection contains its own `>` lines (common in nested quotes) the fence is ambiguous. An LLM cannot tell where the selection ends and the user's framing begins.
- **Alternative: single-backtick or triple-backtick code fence.** Standard markdown code fencing. Rejected: selections that contain code fences (common in engineering docs) collide with the delimiter. Escaping them changes the quoted content, which defeats the purpose of quoting.

## Toggle-off semantics

- **Chosen: wipe the store on toggle-off.** Toggling off clears every comment and highlight. Toggling back on starts fresh.
- **Alternative: preserve comments across toggle cycles (matches existing Review mode).** Rejected: the mental model is "a session is a round of LLM iteration". Preserving stale comments across toggles surprises the user more than it helps — and the only reason the existing Review mode preserves state is that submitting to GitHub is a user-visible commit point, which LLM-Assist does not have.

# Assumptions & Unknowns

- **[Verified] `commentPanel.ts:403-408` uses `Line N` / `Lines N-M` line-range headers.** Read directly; LLM-Assist's payload numbering can call the same helper.
- **[Verified] `commentToggle.ts:233-236` clears the store with no confirmation prompt.** Read directly; "Clear all" copies this behaviour.
- **[Verified] `commentToggle.ts:238-250` hides the action row when `store.getCount() === 0`.** Read directly; LLM-Assist's bar uses the same hook.
- **[Verified] `commentIndicator.ts:121-128` decorates block-level nodes via `Decoration.node` with a class + `data-comment-count` attribute.** Read directly; the new gutter `+` widget extends this plugin rather than forking.
- **[Verified] `pendingCommentStore.ts:70-72` auto-persists on every mutation via `postMessage({type: 'savePendingQueue'})`.** Read directly; this is why LLM-Assist must fork to `LlmCommentStore` instead of reusing `PendingCommentStore`.
- **[Verified] `commentPanel.ts` can be refactored to strip the thread UI without disturbing positioning, click-outside, Escape, and textarea preservation.** Spike 4 (`docs/feat/plans/spike-results/04-comment-panel.md`) mapped the file: thread rendering lives in `renderComment` (lines 201-243) and `renderPendingComment` (lines 245-273), both leaf methods called from two loops in `buildPanel` (lines 168-173). `positionPanel` (315-330) touches only `getBoundingClientRect` and `window.innerWidth` — zero thread-state references. `registerCloseHandlers` (332-354) has one thread-adjacent check (unsaved-textarea guard) that applies equally to LLM-Assist. Strategy: add a `mode: 'thread' | 'llm-assist'` parameter to `buildPanel`, skip the two comment-rendering loops on `llm-assist`, rename the Queue button — roughly 30 lines of conditionals, no structural surgery.
- **[Verified] TipTap inline marks support overlapping stacking with distinct comment IDs.** Spike 1 (`docs/feat/plans/spike-results/01-mark-stacking.md`, test file `src/__tests__/spikes/llmCommentMark.spike.test.ts`) proved it. The `excludes: ''` attribute on `Mark.create` is the unlock — it removes ProseMirror's default constraint that prevents two marks of the same type from stacking. Two overlapping marks with IDs `A` and `B` both persisted in the ProseMirror doc state at the overlap region, and rendered as nested spans (`<span data-comment-id="A">quick <span data-comment-id="B">brown</span></span><span data-comment-id="B"> fox</span>`). The text-level flow's "overlapping selections = new comment" rule (rule 5) is viable as written.
- **[Verified] ProseMirror decoration plugin can emit hover-sensitive `+` and a count badge on the same document without slot conflicts.** Spike 2a (`docs/feat/plans/spike-results/02-gutter-plugin.md`, test file `src/__tests__/spikes/llmGutterPlugin.spike.test.ts`) proved the two-class decoration mechanism. Spike 2b (visual check in the dev extension host) confirmed the CSS `:hover` rule fires correctly for paragraphs and headings. **Scope refinement:** the visual check surfaced that a naïve `doc.forEach` walk misses list items, nested paragraphs in blockquotes, and table rows — the real plugin must walk `lineMap.posToLineRange` (like `commentIndicator.ts`) or `state.doc.descendants` (like `gfmAlert.ts:19`), and filter to the commentable node-type set defined in the `LlmGutterPlugin` architecture bullet.
- **[Verified] The selection-anchored `+` button can reuse existing positioning code without importing `@tiptap/extension-bubble-menu`.** Spike 5 (`docs/feat/plans/spike-results/05-selection-anchor.md`) confirmed that `positionOverlay` in `src/webview/linkDialog.ts:20-36` is already selection-anchored: it reads `view.state.selection.from/to` and calls TipTap's `view.coordsAtPos()` to get viewport coordinates, with a graceful fallback for empty selections. Copy/rename to `positionNearSelection`, call it on `selectionchange`, and pass the `+` button element — no new dependency. One gap: no viewport-edge clamping today; add it if overflow is observed during LLD implementation.
- **[Verified] The webview can write directly to the clipboard via `navigator.clipboard.writeText`; no `postMessage` round-trip needed.** Spike 3 (`docs/feat/plans/spike-results/03-clipboard.md`) read the CSP in `src/markdownEditorProvider.ts:190` (`default-src 'none'; style-src ... 'unsafe-inline'; script-src 'nonce-...'; font-src ...; img-src ...`) and confirmed no directive blocks the Clipboard API — CSP restricts resource loading, not JS runtime APIs. VS Code 1.96.0 (the engine floor in `package.json`) is past the 1.64 threshold where clipboard write was enabled for trusted webview origins. **Decision**: Path 1 (webview-direct). `src/sync/syncProtocol.ts` needs NO new `copyToClipboard` message type; the LLM-Assist UI code calls `navigator.clipboard.writeText(text)` on the user's copy gesture. Note: `copyToolbar.ts`'s synthetic `copy` event pattern solves a different problem (intercepting an in-progress `copy` event to rewrite its payload) and should not be changed.

# Next Step

All five spike assumptions have been validated (see Assumptions & Unknowns above and the five files under `docs/feat/plans/spike-results/`). Run `/write:lld` to turn this HLD into a Low-Level Design, using the spike results to pin down contract details: the `llmCommentMark` `excludes: ''` attribute, the `LlmGutterPlugin` walk via `lineMap.posToLineRange` with the commentable-node-type filter, the `commentPanel.ts` `mode` parameter, the `positionOverlay`-derived selection anchor, and the `navigator.clipboard.writeText` direct call.

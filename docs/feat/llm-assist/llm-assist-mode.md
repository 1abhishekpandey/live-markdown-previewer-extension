LLM-Assist Mode — Inline Comments for LLM Review

Status: Requirements (pre-grooming)
Owner: Abhishek
Last updated: 2026-04-11

# Intent

When iterating on a markdown document with an LLM — a spec, a PR description, a design note, a blog draft — the author often wants to point at a specific phrase and say "rewrite this", "this is wrong because X", "expand with an example". Today the only way is to paste the full doc into a chat and describe the location in prose. That is slow, ambiguous, and breaks as soon as the doc is edited.

LLM-Assist brings GitHub's inline-review UX to the Live Markdown WYSIWYG editor and makes the annotations trivially consumable by any LLM via a structured clipboard payload. Nothing talks to a server — the mode is purely local, purely ephemeral, and its output is a block of text the user pastes wherever they like.

# Entry point — "LLM-Assist" toggle

- A single toggle named **LLM-Assist** controls whether the mode is active.
- Exposed as an editor title-bar button and as a VS Code command `liveMarkdown.toggleLlmAssist`.
- Default: **off**. When off the editor behaves exactly as today.
- Distinct from the existing "Review" toggle (which is for GitHub review). LLM-Assist never talks to any server.
- Toggling LLM-Assist off **clears all in-memory comments and highlights**. Toggling back on starts a fresh review session from a clean slate.

# UI layout when LLM-Assist is on

When the toggle is on, a **second row** appears directly under the editor title bar (or under the existing toolbar, whichever is stylistically cleaner). This row is the LLM-Assist control strip and is only visible while the mode is on.

The second-row strip contains, at minimum:

- A **"Clear all"** button — wipes every comment and highlight in the current session with a confirmation. This is the bulk reset affordance.
- A **"Copy all"** button — copies the structured payload for every comment to the clipboard. Does **not** clear anything.
- (Room to add more actions later — "Copy unresolved", "Export as diff", etc.)

When the mode is off, the second-row strip is hidden entirely so the editor chrome stays minimal.

# UX — two complementary affordances on the same line

With LLM-Assist on, commenting works at two granularities, and both coexist on the same line:

1. **Line-level** — a comment that covers the whole line. Triggered by hovering the line and clicking the "+" button that appears in the left margin (GitHub-gutter style). The extension's existing Review mode is already line-level via `commentIndicator.ts`.
2. **Text-level** — a comment anchored to a specific phrase within a line. Triggered by selecting the phrase; a small "+" button appears near the selection (TipTap BubbleMenu style). Net-new for this mode.

A single line can have one line-level comment **and** any number of text-level comments on different phrases inside it. This deliberately diverges from GitHub's PR review flow, which only supports line-level comments — phrase-scoped comments are worth the extra UI because they tell the LLM exactly which substring to rewrite, not just which line contains it.

## Line-level flow (gutter "+")

1. The user hovers a line that has no line-level comment yet. A small "+" appears in the left margin.
2. Clicking "+" opens a floating comment panel anchored to the right of the line, containing a textarea and a "Save" button.
3. On Save, the whole line gets a subtle background highlight plus a gutter badge showing the total comment count on that line.
4. Once a line has a line-level comment, the gutter "+" **no longer appears on hover** for that line — duplicate line-level comments are suppressed. Text-level commenting on phrases inside the line continues to work.
5. Clicking the highlight or the gutter badge opens a panel listing every comment on that line (line-level first, then text-level in document order), each with Edit / Copy / Delete actions.

## Text-level flow (selection "+")

1. The user selects a phrase within a line (a word, a multi-word span, or a whole paragraph). A small "+" button appears just above the selection, BubbleMenu-style.
2. Clicking "+" opens the same floating comment panel, anchored to the selection.
3. On Save, the selected range is wrapped in a new TipTap inline mark (`LlmCommentMark`) rendered as a highlighted span. The gutter badge count on the containing line increments.
4. Multiple text-level comments on the same line are allowed. The user can select different phrases one after another and comment on each.
5. Overlapping selections are allowed: if a new selection overlaps an existing comment-marked range, a new `LlmCommentMark` is layered on top (a second comment is created, the existing mark is left alone). Match GitHub's "new selection = new comment" behaviour.
6. Clicking a highlighted phrase opens the panel pre-filled with that comment's body.

## Rules at a glance

- **One line-level comment per line.** Gutter "+" is suppressed on lines that already have a line-level comment.
- **Any number of text-level comments per line**, including on lines that already have a line-level comment.
- **The gutter badge counts all comments on the line**, line-level and text-level combined. A badge of `3` could mean one line-level plus two text-level, or three text-level.
- **Both flows open the same floating panel**, anchored to the clicked line or the selection as appropriate. The panel contents look identical — single body, Save / Delete / Copy.
- **No keyboard shortcuts.** Everything is driven by hover, selection, and click.

# Individual-comment controls

Every comment — in the popover, in the side list, wherever it appears — exposes three actions:

- **Edit** — reopen the box.
- **Copy** — copy just this comment's structured payload to the clipboard. Does **not** clear the comment.
- **Delete** — remove this single comment and its highlight. Does not touch any other comment.

This is symmetric with the second-row "Clear all" / "Copy all" actions: one comment or all comments, always either copy-only or clear-only, never both in the same action.

# Export format

The payload is a plain-text block designed to be pasted into an LLM chat directly. Every verbatim block — both the quoted source text and the human's comment — is fenced with triple quotes (`"""`). Triple quotes are a strong, LLM-recognised "verbatim literal" delimiter that survives markdown characters, code fences, and backticks inside the fenced content, which a `>` blockquote or single-backtick fence would not.

The line-range header (`Line 42` for a single line, `Lines 5-7` for a range) reuses the convention already used by the existing Review mode's `formatLineHeader` (`commentPanel.ts:403-408`), so the numbering stays consistent across the two modes.

## Copy one comment

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

When only one comment is in the payload, the label is just `Comment:` (no number).

## Copy all comments

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

Conventions:

- **`File:` header** appears once at the top and applies to every comment in the payload. Uses the workspace-relative path.
- **Line-range header** is `Line N` for a single-line block or `Lines N-M` for a multi-line range, followed by an em dash and `Selected text:`. Mirrors `formatLineHeader` (`commentPanel.ts:403-408`).
- **Triple-quote fences** (`"""`) wrap both the quoted selection and the comment body. Verbatim, no escaping, no markdown interpretation.
- **Numbering** is `Comment:` for a single-comment payload, `Comment-1:`, `Comment-2:`, ... for multi-comment payloads.
- **Separator** between comment blocks in "Copy all" is a single line of five dashes: `-----`. Visually distinct from markdown horizontal rules (`---` / `***`) so it will not collide with any rule inside the quoted text.

## Why this format indicates intent clearly

- **Labelled blocks tell the LLM what role each piece plays.** `Selected text:` is source; `Comment:` is the human's instruction. No ambiguity about which one the LLM should rewrite vs which one it should treat as guidance.
- **Line numbers + quoted text is belt-and-braces.** The quoted text alone works even if the LLM has no access to the doc; the line number pinpoints the exact location when the user also pastes the full doc into the chat. The two disambiguators together cover both workflows.
- **Triple-quote fencing is robust to any content.** Selected text may contain markdown headings, code fences, tables, or stray backticks. Triple quotes do not care. A `>` blockquote prefix, by contrast, is lost the moment the selection contains its own `>` lines.
- **The `-----` separator is unmistakable.** It is longer than a markdown horizontal rule, sits on its own line, and has no interpretation in any markdown flavour.

Both line numbers and the quoted text are included, so the payload is robust to two independent workflows: pasting only the comments block (the LLM finds the quoted text by search), and pasting the full document plus the comments block (the LLM uses the line numbers to jump directly).

# Persistence — in-memory only

- Comments live in webview memory for the lifetime of the current LLM-Assist session.
- No sidecar JSON file. No `.vscode/` storage. No persistence to the markdown body.
- Comments are cleared on any of:
    - Toggling LLM-Assist off.
    - Closing the editor tab.
    - Disabling the extension.
    - Restarting VS Code.
    - Clicking "Clear all" in the second-row strip.
    - Clicking "Delete" on an individual comment (only that comment).
- Copy actions (single or all) **do not** clear anything. Copy is pure copy.

# Reuse from the existing Review mode

The extension already ships a GitHub Review mode implemented in `src/webview/commentToggle.ts`, `commentIndicator.ts`, `commentPanel.ts`, and `pendingCommentStore.ts`. LLM-Assist should reuse those patterns wholesale where possible, forking only where the semantics genuinely diverge (no GitHub, in-memory only, line-local storage, cleared on toggle off).

**Reusable patterns:**

- **Toggle button + second-row bar layout.** `commentToggle.ts` already implements a title-bar toggle that reveals a `review-bar` container with child rows (`review-refresh-row`, `review-actions-row`). LLM-Assist can copy the DOM structure and CSS verbatim with renamed classes (`llm-toggle`, `llm-bar`, `llm-actions-row`).
- **Count-in-button-label convention.** Existing: `Submit Review (3)` updated reactively via `updateSubmitButton` on store changes. LLM-Assist: `Copy all (3)` and `Clear all (3)` updated the same way.
- **Action row is hidden until there is something to act on.** In the existing mode, the actions row is `display: none` unless the pending count is greater than zero. LLM-Assist should do the same — "Copy all" and "Clear all" only render once the first comment exists, so the chrome stays minimal on an empty session.
- **Store shape.** `PendingCommentStore` is an in-memory store exposing `add`, `remove`, `clear`, `getAll`, `getCount`, `onChange`. Exactly the API LLM-Assist needs. Fork to `LlmCommentStore` only if the entity type diverges enough to warrant it.
- **Line decoration via `Decoration.node`.** `commentIndicator.ts` wraps block-level nodes with a class + data attributes, rendering the badge via a CSS `::after` pseudo-element. LLM-Assist copies this verbatim with renamed classes and a different data source.
- **Floating comment panel.** `commentPanel.ts` already has `openNew(line, startLine, anchorEl)`, `openThread`, click-outside-to-close, Escape-to-close, and text-preserving refresh. LLM-Assist's comment box is this panel with the reply/thread UI stripped (single body, no author, no timestamps, no GitHub `Outdated` / `Draft` / `Pending` markers).
- **Clear-with-no-confirmation convention.** The existing `onDiscardClick` (`commentToggle.ts:233`) calls `store.clear()` with no prompt. LLM-Assist "Clear all" matches.

**Intentional divergences:**

- LLM-Assist is purely webview-local. No sync-protocol additions for fetch / submit / validate. The existing `commentToggle`, `commentRefresh`, `submitReview`, `validateLine` messages stay out of LLM-Assist's code path entirely.
- Toggling LLM-Assist off **clears the store**. The existing Review mode's `cleanup()` hides the bar but keeps the store intact across toggle cycles; LLM-Assist deliberately wipes on toggle off.
- No threads, no authors, no timestamps, no `Outdated` / `Draft` / `Pending` labels. A comment is just a body attached to a line or a phrase.
- **Two anchoring granularities instead of one.** The existing Review mode is line-only. LLM-Assist adds a text-level (phrase-scoped) anchor via a net-new TipTap inline mark. Line anchoring reuses `Decoration.node` from `commentIndicator.ts`; phrase anchoring is new.
- **Two net-new UI pieces** have no analogue in the existing Review mode:
    1. A gutter "+" hover affordance that appears on uncommented lines (the existing mode only draws the badge once a comment exists).
    2. A selection-anchored "+" button shown BubbleMenu-style just above a text selection, plus the `LlmCommentMark` it creates.

# Non-goals for V1

- No LLM API integration inside the extension. The extension produces a payload; the user pastes it wherever.
- No multi-user / threaded / resolved-state comments. Single author, single note per selection.
- No integration with VS Code's native Comments API gutter (considered for a later phase).
- No cross-session persistence. Comments die with the session by design.
- No re-anchoring after external edits. Since the session is ephemeral, there is no "reload the doc and reattach comments" problem to solve.

# Grooming outcomes

Resolved against the existing Review mode's conventions:

1. **Affordance shape** → **line-level, gutter "+" on hover.** Matches both GitHub's PR review flow and the extension's existing Review mode, which uses `Decoration.node` on block-level nodes via `commentIndicator.ts`. Selection-based anchoring is rejected.
2. **"Clear all" confirmation** → **no confirmation.** Existing `onDiscardClick` in `commentToggle.ts:233` calls `store.clear()` immediately with no prompt. Match that. A misclick just means rewriting a few notes — recoverable work.
3. **Overlapping selections** → **moot.** Line-level anchoring dissolves the question entirely — there is no selection range to overlap.
4. **Visible comment count in the strip** → **yes.** The existing mode reactively renders `Submit Review (${count})` via `updateSubmitButton`. LLM-Assist uses the same hook to render `Copy all (3)` and `Clear all (3)`.
5. **Second-row chrome when empty** → **hide the action row until the first comment exists.** Matches the existing mode's `actionsRow.style.display = 'none'` behaviour (`commentToggle.ts:241`). Keeps the chrome minimal until there is something to act on.
6. **Side panel vs inline-only** → **inline-only, via a `CommentPanel`-style floating popover.** The existing mode has no side panel either; it uses a floating panel positioned to the right of the clicked line, closed by Escape or click-outside.
7. **Panel styling** → **single-body, no thread UI.** Strip author, timestamp, `Outdated` / `Draft` / `Pending` markers, and the reply section from the existing `CommentPanel`. Keep the positioning, close handlers, and textarea-text preservation.

Also resolved:

8. **Payload disambiguation** → **line numbers + quoted text, not heading path.** Reuses the existing `lineMap.ts` and `formatLineHeader` conventions from the Review mode. Line numbers let the LLM jump directly when the user also pastes the doc; the quoted text works standalone when they do not. Triple-quote fenced to survive markdown/code inside the selection, `-----` separator between comments. Full format documented in the "Export format" section above.
9. **Per-line comment count** → **one line-level comment per line, unlimited text-level comments per line.** Deliberately diverges from the existing Review mode and from GitHub. Gutter "+" is suppressed once a line has a line-level comment; selection-based commenting (phrase-scoped, via a new `LlmCommentMark` inline mark) keeps working and can stack multiple comments on the same line. Payload format is identical for both — the quoted text is either the whole line or the selected substring.
10. **Where the gutter "+" gets drawn** → **extend `commentIndicator.ts`.** Add an always-on per-line widget to the ProseMirror decoration set: renders `+` on hover when the line has no line-level comment, renders the total comment count `N` once any comment exists on the line. Keeps every per-line UI element inside one plugin, consistent with how the existing badge is drawn.
11. **Long-doc payload size** → **no handling in V1.** Ship "Copy all" as one blob. Revisit only if a real document actually hits a paste-size ceiling. An "include only commented paragraphs" mode is deferred to a later phase.

No open items remaining before V1 can be designed in detail. Move to implementation planning next.

# Why this fits the extension

The extension's thesis is that markdown is the lingua franca between humans, VS Code, and LLMs, and that a WYSIWYG view makes that material easier to author. LLM-Assist extends the thesis one step further: it makes the material easier to *collaborate on with an LLM*. The feature reuses the existing webview ↔ extension sync protocol, the existing TipTap editor, and VS Code's existing clipboard and command infrastructure. No new runtime dependency is required. Because everything is in memory and scoped to one toggle, there is no sidecar-file mess, no rename-tracking, no orphaned-anchor recovery — the whole design collapses to a much smaller surface than the original plan.

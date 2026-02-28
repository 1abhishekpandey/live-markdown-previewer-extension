Code Block Behaviour Issues — Investigation & Fixes

# Background

The WYSIWYG markdown editor renders code blocks via TipTap's `CodeBlockLowlight` extension,
which produces `<pre><code>…</code></pre>` in the DOM. Three independent bugs were found and
fixed across the CSS layer and the webview ↔ extension sync layer.

---

# Issue 1 — Code block capped at 720 px

## Symptom
Long lines inside a code block were clipped at roughly 720 px. Content beyond that width was
invisible; no horizontal scrollbar appeared.

## Root cause
`styles.css` had `max-width: min(720px, 100%)` on `.ProseMirror pre`, imposing a hard cap.

## Fix
Changed `max-width: min(720px, 100%)` → `max-width: 100%` and kept `overflow-x: auto` on
`pre`. Code blocks now fill the editor column and scroll horizontally for lines that exceed
the window width.

---

# Issue 2 — Text wraps inside code block when typing

## Symptom
Typing in a code block caused content to wrap to the next line once it reached the right edge
of the editor, instead of scrolling horizontally.

## Root cause
Two compounding factors:

1. **`display: inline` on `<code>` (browser default).** An inline element is laid out as a
   run of text inside its parent's inline formatting context. Because the browser measures it
   as inline text, "overflow" from the inline content causes the parent (`<pre>`) to reflow,
   not scroll. The `overflow-x: auto` on `<pre>` never triggered because the scroll container
   never saw content wider than itself — the inline `<code>` was simply reflowed.

2. **Inherited `white-space: pre-wrap` from ProseMirror.** ProseMirror injects
   `.ProseMirror { white-space: pre-wrap; word-wrap: break-word; }` globally. Although
   `.ProseMirror pre { white-space: pre !important }` overrode this on `<pre>`, the `<code>`
   element — sitting one level deeper — could still pick up `word-wrap: break-word` via
   inheritance, allowing forced breaks at the container boundary.

## Fix
`styles.css` — `.ProseMirror pre code` was updated:

```css
.ProseMirror pre code {
  display: inline-block;   /* sizes to content width; can exceed <pre> width */
  min-width: 100%;         /* always at least as wide as <pre> */
  white-space: pre !important;
  word-break: normal;
  overflow-wrap: normal;
  /* … existing colour / font rules … */
}
```

With `display: inline-block`, `<code>` is a self-contained box that sizes to its content.
Combined with `white-space: pre`, the box can be wider than `<pre>`, at which point `<pre>`'s
`overflow-x: auto` provides a horizontal scrollbar. `word-break: normal` and
`overflow-wrap: normal` cancel ProseMirror's inherited break rules.

A matching `.code-wrap .ProseMirror pre code` rule was also added so the "Wrap: On" toggle
still works:

```css
.code-wrap .ProseMirror pre code {
  white-space: pre-wrap !important;
  word-break: break-word;
  overflow-wrap: break-word;
}
```

---

# Issue 3 — Empty line in code block removed ~1 second after pressing Enter

## Symptom
Pressing Enter at the end of a code block created a new empty line (cursor on the new line).
Approximately one second later the empty line disappeared and the cursor jumped back.

## Root cause

The bug is a two-step cascade in the webview ↔ extension sync round-trip.

### Step 1 — `tiptap-markdown` absorbs the trailing `\n`

`tiptap-markdown` serialises code blocks as fenced code:

```
```typescript
code here
```
```

When the code block text is `"code here\n"` (one trailing newline representing the empty
line), the serialiser writes:

```
```typescript
code here
```
```

The `\n` before the closing fence is syntactically part of the fence, not part of the code
content. When `markdown-it` parses this back, it produces a code block with text
`"code here"` — the trailing newline is gone. The empty line does not survive a
serialise → parse round-trip.

### Step 2 — VS Code's `insertFinalNewline` breaks echo prevention

The sync flow after pressing Enter:

1. TipTap state: `"code here\n"` → empty line visible.
2. Debounce fires (300 ms) → `getMarkdown()` → `md` (trailing `\n` in code is absorbed by
   the fence; `md` does **not** encode the empty line).
3. Extension applies `md` to the `TextDocument`; stores `lastAppliedContent = md`.
4. VS Code's `insertFinalNewline` normalisation appends `\n` to the file buffer (~1 s later,
   on auto-save), firing `onDidChangeTextDocument` with `content = md + '\n'`.
5. `handleDocumentChange` compares `content` with `lastAppliedContent`:
   `md + '\n' !== md` → **mismatch** → `externalUpdate` sent with `content`.
6. Webview receives `externalUpdate`, calls `setContent(md + '\n')`.
7. `markdown-it` parses `md + '\n'` → code block text = `"code here"` (no trailing `\n`).
8. Empty line removed; cursor jumps.

The `isApplyingEdit` flag does not help here because the buffer modification from
`insertFinalNewline` happens after `applyMarkdownEdit` has already completed and set the flag
back to `false`.

## Fix

Two guards were added, one in each layer.

### `src/sync/documentSync.ts` — normalise the echo-prevention comparison

```typescript
// Before
if (this.lastAppliedContent !== null && content === this.lastAppliedContent) {

// After
if (this.lastAppliedContent !== null &&
    content.trimEnd() === this.lastAppliedContent.trimEnd()) {
```

`trimEnd()` strips the trailing `\n` that `insertFinalNewline` adds before comparing.
The event is now correctly identified as an echo and suppressed.

### `src/webview/syncClient.ts` — skip `setContent` when markdown is semantically identical

```typescript
case 'externalUpdate': {
  if (msg.version <= this.currentVersion) return;

  const currentMarkdown = this.editor.storage.markdown.getMarkdown();
  if (msg.markdown.trimEnd() === currentMarkdown.trimEnd()) {
    this.currentVersion = msg.version;
    break;                 // same content — update version, don't re-render
  }

  // … existing setContent / cursor-restore logic …
}
```

Even if a spurious `externalUpdate` reaches the webview (e.g. from another VS Code extension
modifying the file), re-rendering is skipped when the incoming markdown serialises to the
same content the editor already holds. Only genuinely different external changes are applied.


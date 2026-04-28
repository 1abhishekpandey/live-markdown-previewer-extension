# LiveMarkdown — Features

A visual markdown editor that replaces VS Code's default text view for `.md` files.

# Rich-Text Editing

- Inline rendering of headings, bold, italic, strikethrough, and inline code as you type
- Full GitHub Flavored Markdown support — tables, task lists (nested), fenced code blocks, blockquotes
- Syntax highlighting inside code blocks via `lowlight`
- GFM alert callouts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`) with visual styling

# Toggle Visual / Raw Markdown

Switch between visual and raw source with `Shift+Cmd+M` (`Ctrl+Shift+M` on Windows/Linux) or the `$(code)` toolbar button. Scroll position is preserved across switches using anchor-text matching with percentage-based fallback.

# Find

`Cmd+F` (`Ctrl+F`) opens an in-editor search bar with:

- Real-time match count (X/Y)
- Previous/Next navigation (`Shift+Enter` / `Enter`)
- Auto-populates from current selection
- Smooth scroll-to-match

# Link Dialog

`Cmd+K` (`Ctrl+K`) opens a quick overlay for inserting or editing hyperlinks. Validates URLs against safe protocols (`http`, `https`, `ftp`, `mailto`). Pre-fills the URL when the cursor is inside an existing link.

# Undo / Redo / Save

TipTap owns undo/redo with a 500 ms new-group delay — consecutive keystrokes batch into one undo step; a pause starts a new group. This matches VS Code's native editor and Microsoft Word. Every keystroke reaches the TextDocument synchronously, so `files.autoSave` fires with no extension-owned delay. `Cmd+S` (`Ctrl+S`) is the only shortcut still forwarded to the extension, for explicit save.

# External Change Sync

Edits from other extensions, git operations, or concurrent tools appear instantly. A version counter prevents echo loops and drops stale messages. Incoming external updates are applied without touching the local undo stack, so Cmd+Z always reflects only your own edits.

# Copy Mode

Toggle between **Raw** (markdown syntax) and **Rich** (rendered HTML) copy via the bottom-left "Copy: Raw/Rich" button.

# Code Block Wrapping

Toggle long-line wrapping in code blocks with the "Wrap: On/Off" button (bottom-left). State persists across sessions.

# Theme Integration

All colours derive from VS Code CSS variables (`var(--vscode-*)`), so the editor follows light, dark, and high-contrast themes automatically.

# PR Review Comments

Review GitHub pull request comments directly in the editor — no need to switch to the browser.

- **Review mode** — toggle on to see diff highlights (green background on changed lines) and existing PR comments
- **View comments** — click the 💬 badge on a commented line to see the thread
- **Add comments** — click the `+` on any highlighted line, or select text across multiple lines to comment on a range
- **Batch submission** — comments are queued locally and posted as a draft review (no notifications until you publish on GitHub)
- **Discard** — remove individual pending comments or discard all at once
- **One comment per line** — multiple separate comments on the same line are not supported (may be added in future)
- **Requires `gh` CLI** — all GitHub communication goes through the [GitHub CLI](https://cli.github.com) (must be installed and authenticated)

# LLM Assist Mode

Annotate any block or text selection with structured comments, then copy a machine-readable payload for pasting into an LLM chat.

- **Toggle** — click "LLM-Assist: Off" in the toolbar or use the Command Palette (`Toggle LLM-Assist`). Mutually exclusive with PR Review mode.
- **Block comments** — hover over any paragraph, heading, list item, task item, code block, or table to reveal a "+" gutter button. Click to open the comment panel anchored to that block.
- **Selection comments** — select any text range to reveal a floating "+ Comment" button. Click to apply an inline mark and open the comment panel linked to the exact selection.
- **Threaded replies** — each comment supports inline replies. Navigate between threads with prev/next buttons.
- **Copy** — click "Copy" on a thread to copy a structured payload containing the workspace-relative file path, quoted source lines, and labelled comments. "Copy All" copies every thread.
- **Ephemeral** — comments are not saved to the markdown file. Toggling off clears all comments and inline marks.

# Read-Only Support

Git diff views and other non-writable documents display a "Read-only" banner with editing and shortcuts disabled.
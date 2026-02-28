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

Keyboard shortcuts (`Cmd+Z`, `Cmd+Shift+Z`, `Cmd+S`) are intercepted and forwarded to VS Code's native `TextDocument` history — no separate undo stack.

# External Change Sync

Edits from other extensions, git operations, or concurrent tools appear instantly. A version counter prevents echo loops and drops stale messages. Edit sending is adaptively debounced (300 ms default, scaling to 800 ms for large files).

# Copy Mode

Toggle between **Raw** (markdown syntax) and **Rich** (rendered HTML) copy via the bottom-left "Copy: Raw/Rich" button.

# Code Block Wrapping

Toggle long-line wrapping in code blocks with the "Wrap: On/Off" button (bottom-left). State persists across sessions.

# Theme Integration

All colours derive from VS Code CSS variables (`var(--vscode-*)`), so the editor follows light, dark, and high-contrast themes automatically.

# Read-Only Support

Git diff views and other non-writable documents display a "Read-only" banner with editing and shortcuts disabled.
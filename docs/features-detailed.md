# LiveMarkdown — Detailed Feature Guide

A visual markdown editor that replaces VS Code's default text view for `.md` files. This document covers every feature in depth — behaviour, keyboard shortcuts, edge cases, and design rationale.

# Keyboard Shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Toggle visual / raw | `Shift+Cmd+M` | `Ctrl+Shift+M` |
| Find | `Cmd+F` | `Ctrl+F` |
| Insert link | `Cmd+K` | `Ctrl+K` |
| Undo | `Cmd+Z` | `Ctrl+Z` |
| Redo | `Shift+Cmd+Z` | `Shift+Ctrl+Z` |
| Save | `Cmd+S` | `Ctrl+S` |

---

# Rich-Text Editing

LiveMarkdown renders markdown formatting inline as you type. Headings, bold, italic, strikethrough, inline code, blockquotes, and horizontal rules all display visually without leaving the editor.

## GitHub Flavored Markdown

Full GFM support is built in:

| Element | Details |
| --- | --- |
| Tables | Multi-row and multi-column editing (resize handles disabled) |
| Task lists | Checkboxes with nested item support — click to toggle |
| Fenced code blocks | Language-aware syntax highlighting via `lowlight` |
| Strikethrough | `~~text~~` renders with a line-through style |
| Blockquotes | Nested blockquotes with left-border styling |

## GFM Alert Callouts

GitHub-style alert blocks render with distinct colours and icons:

```markdown
> [!NOTE]
> Informational note.

> [!TIP]
> Helpful advice.

> [!IMPORTANT]
> Key information.

> [!WARNING]
> Potential issue.

> [!CAUTION]
> Dangerous action.
```

Each type has a coloured left border, semi-transparent background, and icon prepended to the title. Detection is case-insensitive.

## Code Block Syntax Highlighting

Fenced code blocks with a language identifier (e.g., ```` ```typescript ````) display with syntax colouring. Highlighting covers keywords, strings, numbers, comments, functions, types, attributes, and variables. Colours follow VS Code's active theme.

Trailing newlines inside code blocks are preserved during round-trip serialisation to prevent content loss.

---

# Toggle Visual / Raw Markdown

Switch between the visual editor and raw markdown source.

| Platform | Shortcut |
| --- | --- |
| macOS | `Shift+Cmd+M` |
| Windows / Linux | `Ctrl+Shift+M` |

Also available via the code icon (`$(code)`) in the editor title bar.

## Scroll Position Preservation

When toggling views, the editor scrolls to the corresponding location in the target view:

1. **Anchor-text matching** — the first visible block's text (trimmed) is recorded along with its document position. The target view searches for a block with matching text.
2. **Prefix matching** — if no exact match is found and the anchor is longer than 20 characters, the first 30 characters are tried.
3. **Multiple matches** — when several blocks share the same text, the one closest to the expected document fraction is selected.
4. **Fraction fallback** — if no text match is found, the scroll position is estimated from the document fraction (`lineIndex / totalLines`).

The system retries up to 5 times (50 ms apart) if position calculation fails, then falls back to percentage-based scrolling.

---

# Find

`Cmd+F` (macOS) or `Ctrl+F` (Windows/Linux) opens an in-editor search bar.

## Search Behaviour

- **Case-insensitive** matching across all text nodes in the document.
- **Real-time match count** displayed as `N/M` (e.g., `3/7` — third of seven matches). Shows `No results` when the query has no matches.
- **Selection prefill** — if text is selected when the bar opens (up to 80 characters), it populates the search field and triggers an immediate search.
- **Re-opening** the bar when it is already visible focuses the input and selects all text.

## Navigation

| Action | Trigger |
| --- | --- |
| Next match | `Enter` or `↓` button |
| Previous match | `Shift+Enter` or `↑` button |
| Close bar | `Escape` or `✕` button |

Navigation wraps around — pressing Next on the last match jumps to the first, and vice versa.

## Match Highlighting

- **Inactive matches** — orange background at 33% opacity.
- **Active match** — orange background at 60% opacity with a border outline.
- **Scroll-to-match** — the active match is scrolled into view. If ProseMirror's built-in scroll is insufficient, a fallback checks whether the match is within 100 px of the viewport edge and smooth-scrolls to centre it in the upper third of the screen.

---

# Link Dialog

`Cmd+K` (macOS) or `Ctrl+K` (Windows/Linux) opens a floating overlay for inserting or editing hyperlinks.

## Behaviour

| Input | Result |
| --- | --- |
| Enter a URL and press `Enter` | Link is applied if the URL passes validation |
| Press `Enter` with an empty input | Existing link on the selection is removed |
| Press `Escape` | Dialog closes, focus returns to editor |
| Open when cursor is inside a link | Input pre-fills with the existing URL |
| Open when dialog is already visible | Dialog closes (toggle) |

## URL Validation

Only safe protocols are allowed: `http:`, `https:`, `ftp:`, and `mailto:`. URLs with other protocols (e.g., `javascript:`) are silently rejected — the dialog stays open so the user can correct the input.

## Positioning

The dialog appears below the current text selection, horizontally centred on the selection midpoint. If coordinates cannot be determined, it falls back to the centre of the editor viewport.

---

# Undo / Redo / Save

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Undo | `Cmd+Z` | `Ctrl+Z` |
| Redo | `Shift+Cmd+Z` | `Shift+Ctrl+Z` |
| Save | `Cmd+S` | `Ctrl+S` |

TipTap's built-in history is disabled. The webview intercepts these shortcuts, prevents default browser behaviour, and forwards them to the extension. VS Code's native `TextDocument` manages the undo/redo stack, ensuring consistency with the file on disk.

Save applies any pending edits to the document and writes the file.

---

# External Change Sync

When the underlying file is modified outside the editor — by another extension, a git operation, or a concurrent tool — changes appear in the webview immediately.

## Echo Prevention

Two flags prevent infinite sync loops:

- **Extension side** (`isApplyingEdit`) — set while the extension writes a webview edit to the document. The document-change listener skips events that originate from this flag.
- **Webview side** (`isExternalUpdate`) — set while the editor applies an incoming external update. The editor's update listener skips sending edits back.

## Version Counter

Both sides maintain a monotonically increasing version number. Stale messages (version equal to or lower than the current) are silently dropped. This handles out-of-order delivery and rapid edit bursts.

## Adaptive Debouncing

Edit messages from the webview are debounced to reduce overhead:

| Document size | Debounce delay |
| --- | --- |
| ≤ 30 KB | 300 ms |
| 30–100 KB | 500 ms |
| &gt; 100 KB | 800 ms |

If an external update arrives while the debounce timer is active, it is buffered and applied immediately after the pending edit is sent.

## Trailing Whitespace

Both sides compare content with trailing whitespace trimmed. Differences that consist solely of trailing whitespace are ignored to prevent unnecessary sync cycles.

---

# Copy Mode

A toggle button in the bottom-left corner of the editor switches between two clipboard modes:

| Mode | Label | Behaviour |
| --- | --- | --- |
| Raw (default) | `Copy: Raw` | Copies the selection as markdown syntax (plain text) |
| Rich | `Copy: Rich` | Copies the selection as rendered HTML (browser default) |

In Raw mode, the extension intercepts the DOM `copy` event, serialises the selected content back to markdown, and places it on the clipboard as plain text.

---

# Code Block Wrapping

The "Wrap: On/Off" button in the bottom-left corner toggles how long lines inside code blocks are displayed:

| State | Behaviour |
| --- | --- |
| Off (default) | Long lines scroll horizontally (`white-space: pre`) |
| On | Long lines wrap to the next line (`white-space: pre-wrap`) with word breaking enabled |

The setting persists across tab switches via VS Code's webview state API.

---

# Theme Integration

All editor colours are derived from VS Code CSS variables (`var(--vscode-*)`), so the editor adapts to light, dark, and high-contrast themes automatically.

Key mappings include:

| Element | CSS Variable |
| --- | --- |
| Background | `--vscode-editor-background` |
| Text | `--vscode-editor-foreground` |
| Links | `--vscode-textLink-foreground` |
| Code blocks | `--vscode-textCodeBlock-background` |
| Selection | `--vscode-editor-selectionBackground` |
| Search matches | `--vscode-editor-findMatchBackground` |
| Widgets (search bar, banner) | `--vscode-editorWidget-background` |
| Loading spinner | `--vscode-progressBar-background` |

Syntax highlighting classes inside code blocks (`.hljs-keyword`, `.hljs-string`, etc.) are mapped to appropriate theme-aware colours.

---

# Read-Only Support

Documents opened from non-writable sources (e.g., git diff views, git blob URIs) are displayed in read-only mode.

- The editor is set to non-editable — all input is disabled.
- A **"Read-only" banner** appears at the top centre of the viewport.
- Keyboard shortcuts for undo, redo, and save are silently ignored.
- The document-change listener is not registered, so no sync overhead is incurred.

Detection is based on the document URI scheme: only `file:` and `untitled:` are treated as writable.

---

# Loading Overlay

A spinner overlay covers the editor during initialisation. It is removed when the first `init` message arrives from the extension. A safety timeout of 8 seconds ensures the overlay is hidden even if initialisation stalls.

The spinner uses the `--vscode-progressBar-background` colour and fades out over 300 ms.

---

# Content Security Policy

The webview enforces a strict CSP:

```
default-src 'none';
style-src {webview-csp-source} 'unsafe-inline';
script-src 'nonce-{random}';
font-src {webview-csp-source};
```

- **Scripts** are gated by a unique nonce (16 random bytes, hex-encoded) generated per webview instance.
- `unsafe-inline` **for styles** is required because TipTap and ProseMirror inject inline styles dynamically.
- **No external resources** are loaded — all assets are bundled.

---

# Panel Re-sync

When a webview panel becomes visible after being hidden (e.g., switching tabs), the extension re-sends the full document content with `version: 0`, forcing the webview to reload the latest state. This handles cases where external edits occurred while the panel was in the background.
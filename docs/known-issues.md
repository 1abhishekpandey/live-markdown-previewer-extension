# Known Issues

LiveMarkdown works well for daily use, but there are rough edges worth knowing about.

# Single-click preview tabs show raw markdown

Single-clicking an `.md` file in the Explorer opens a preview tab — VS Code's standard behaviour for uncommitted tabs. The extension deliberately does not auto-swap preview tabs to WYSIWYG, because doing so would steal focus from the Explorer and break native file shortcuts (Enter to rename, Cmd+Delete to trash, F2, Cmd+C/V/X).

As soon as you commit the tab — by double-clicking it, clicking the tab title, typing into the document, or opening it via Cmd+P — the view swaps to WYSIWYG automatically. No manual toggle is needed.

# Keyboard shortcut conflicts

Some shortcuts overlap with VS Code's defaults. The most noticeable: `Ctrl+B` (toggle bold in TipTap) conflicts with VS Code's "Toggle Sidebar" binding. The sidebar toggles instead of bolding text. You'd need to rebind one or the other in your keybindings.

# Empty Enter presses don't persist

Pressing Enter without typing any text creates an empty paragraph in TipTap, but markdown normalises multiple blank lines into a single blank line. Since the serialised output doesn't change, the edit is effectively a no-op and nothing is written to the file. This is a limitation of the markdown format — empty paragraphs have no distinct representation. The Enter is reflected once you type actual content on the new line.

# Selection isn't visible to Claude Code and other extensions

Tools that read `window.activeTextEditor.selections` — Claude Code's "N lines selected" indicator, GitLens hovers, and similar — can't see text selected inside the WYSIWYG editor. This is a VS Code design decision: when a webview or custom editor is focused, `activeTextEditor` is deliberately `undefined` ([vscode#101682](https://github.com/microsoft/vscode/issues/101682)), and there is no API to expose a custom editor's selection back to the rest of VS Code without opening the same file in a second, visible text editor.

If you need another extension to act on the current selection, toggle raw mode on that tab (`LiveMarkdown: Toggle Raw Markdown View`) and the native text editor will report the selection normally.

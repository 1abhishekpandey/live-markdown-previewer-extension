# Known Issues

LiveMarkdown works well for daily use, but there are rough edges worth knowing about.

# Single-click preview tabs show raw markdown

Single-clicking an `.md` file in the Explorer opens a preview tab — VS Code's standard behaviour for uncommitted tabs. The extension deliberately does not auto-swap preview tabs to WYSIWYG, because doing so would steal focus from the Explorer and break native file shortcuts (Enter to rename, Cmd+Delete to trash, F2, Cmd+C/V/X).

As soon as you commit the tab — by double-clicking it, clicking the tab title, typing into the document, or opening it via Cmd+P — the view swaps to WYSIWYG automatically. No manual toggle is needed.

# Keyboard shortcut conflicts

Some shortcuts overlap with VS Code's defaults. The most noticeable: `Ctrl+B` (toggle bold in TipTap) conflicts with VS Code's "Toggle Sidebar" binding. The sidebar toggles instead of bolding text. You'd need to rebind one or the other in your keybindings.

# Empty Enter presses don't persist

Pressing Enter without typing any text creates an empty paragraph in TipTap, but markdown normalises multiple blank lines into a single blank line. Since the serialised output doesn't change, the edit is effectively a no-op and nothing is written to the file. This is a limitation of the markdown format — empty paragraphs have no distinct representation. The Enter is reflected once you type actual content on the new line.

# Scroll position drift

When toggling between raw and visual modes repeatedly, scroll position can drift slightly. The extension uses anchor-text matching with a fraction-based fallback to restore position, but sub-pixel rounding and content re-initialisation cause small shifts over multiple toggles.

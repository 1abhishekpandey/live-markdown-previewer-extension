# Known Issues

LiveMarkdown works well for daily use, but there are rough edges worth knowing about.

# File operations on `.md` files

Once the extension is active, right-clicking an `.md` file in the explorer gives you the WYSIWYG view. To rename or delete, you need to double-click the file first (to focus it in the editor), then select Rename or Delete. This is a limitation of how VS Code's `CustomTextEditorProvider` claims ownership of file types.

# First open requires a toggle

When you open an `.md` file for the very first time after installing, you need to click the "Toggle Raw Markdown" button (or press `Shift+Cmd+M` / `Ctrl+Shift+M`) to activate the visual preview mode. After that first toggle, it works as expected.

# Keyboard shortcut conflicts

Some shortcuts overlap with VS Code's defaults. The most noticeable: `Ctrl+B` (toggle bold in TipTap) conflicts with VS Code's "Toggle Sidebar" binding. The sidebar toggles instead of bolding text. You'd need to rebind one or the other in your keybindings.

# Scroll position drift

When toggling between raw and visual modes repeatedly, scroll position can drift slightly. The extension uses anchor-text matching with a fraction-based fallback to restore position, but sub-pixel rounding and content re-initialisation cause small shifts over multiple toggles.
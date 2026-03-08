# LiveMarkdown

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/1AbhishekPandey.live-markdown?label=VS%20Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=1AbhishekPandey.live-markdown)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/1AbhishekPandey.live-markdown?color=green)](https://marketplace.visualstudio.com/items?itemName=1AbhishekPandey.live-markdown)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A VS Code extension that replaces the default markdown preview with a live **WYSIWYG** editor. Edit markdown files visually — headings, links, tables, task lists, and code blocks render inline as you type.

Built with [TipTap](https://tiptap.dev) and the VS Code `CustomTextEditorProvider` API.

## Install

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=1AbhishekPandey.live-markdown), or search for **LiveMarkdown** in the Extensions sidebar (`Cmd+Shift+X`).

When you open a `.md` file for the first time, click the **"Toggle raw markdown"** button in the top-right editor toolbar (or press `Shift+Cmd+M` / `Ctrl+Shift+M`) to switch to the visual preview mode.

## Features

- **WYSIWYG editing** — rich-text editing for `.md` files, no split pane needed
- **GFM support** — tables, task lists, strikethrough, and fenced code blocks with syntax highlighting
- **Full theme integration** — adapts to light, dark, and high-contrast VS Code themes
- **Native undo/redo** — backed by VS Code's `TextDocument` history, not a separate undo stack
- **Toggle view** — switch between visual and raw markdown with `Shift+Cmd+M`
- **Link insertion** — `Cmd+K` overlay for quick link creation
- **Copy mode toggle** — copy as raw Markdown or rendered rich text
- **GFM alert callouts** — `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, and `[!CAUTION]` blocks with distinct colours and icons
- **Real-time sync** — edits from other extensions or external tools appear instantly

## How it Works

The extension replaces VS Code's default text view for `.md` files. No split pane, no manual toggle — rendered content is the default. Raw markdown is one shortcut away when you need it.

Under the hood, the extension runs in two contexts connected via `postMessage`: the extension host manages document sync with VS Code's workspace API, while the webview runs a TipTap editor that debounces edits and forwards undo/redo/save commands back.

For more details, see:
- [Why LiveMarkdown?](https://github.com/1abhishekpandey/live-markdown-previewer-extension/blob/main/docs/motivation.md) — the problem with VS Code's built-in preview and how this solves it
- [Features](https://github.com/1abhishekpandey/live-markdown-previewer-extension/blob/main/docs/features.md) — quick feature overview
- [Detailed feature guide](https://github.com/1abhishekpandey/live-markdown-previewer-extension/blob/main/docs/features-detailed.md) — in-depth behaviour, shortcuts, edge cases, and design rationale

## Licence

[MIT](LICENSE)

---

**Made with ❤️ by Vibe Coding!**
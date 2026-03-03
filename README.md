# LiveMarkdown

A VS Code extension that replaces the default markdown preview with a live **WYSIWYG** editor. Edit markdown files visually — headings, links, tables, task lists, and code blocks render inline as you type.

Built with [TipTap](https://tiptap.dev) and the VS Code `CustomTextEditorProvider` API.

## Features

- **WYSIWYG editing** — rich-text editing for `.md` files, no split pane needed
- **GFM support** — tables, task lists, strikethrough, and fenced code blocks with syntax highlighting
- **Full theme integration** — adapts to light, dark, and high-contrast VS Code themes
- **Native undo/redo** — backed by VS Code's `TextDocument` history, not a separate undo stack
- **Toggle view** — switch between visual and raw markdown with `Shift+Cmd+M`
- **Link insertion** — `Cmd+K` overlay for quick link creation
- **Copy mode toggle** — copy as raw Markdown or rendered rich text
- **Real-time sync** — edits from other extensions or external tools appear instantly

## Docs

| Document | Description |
| --- | --- |
| [Setup](docs/setup.md) | Install instructions, build commands, and dev workflow |
| [Why LiveMarkdown?](docs/motivation.md) | The problem with VS Code's built-in preview and how this solves it |
| [Features](docs/features.md) | Quick feature overview |
| [Detailed feature guide](docs/features-detailed.md) | In-depth behaviour, shortcuts, edge cases, and design rationale |

## How it works

The extension runs in two contexts connected via `postMessage`:

- **Extension host (Node)** — registers the custom editor provider, manages document sync with VS Code's workspace API
- **Webview (Browser)** — runs a TipTap editor instance, debounces edits, and forwards undo/redo/save commands back to the extension

Echo prevention flags and a version counter on both sides keep the two in sync without loops.

## Licence

[MIT](LICENSE)

---

**Made with ❤️ by Vibe Coding!**
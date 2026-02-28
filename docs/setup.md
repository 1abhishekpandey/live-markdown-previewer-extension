# Setup

Two ways to run the extension locally.

## Development mode (no install, fastest iteration)

1. Build:

   ```bash
   npm install
   npm run build
   ```
2. Open the repo in VS Code and press **F5**. A second *Extension Development Host* window opens with the extension active.
3. Open any `.md` file — LiveMarkdown is the default editor.

Changes require a rebuild (`npm run build`) and an **F5** relaunch to take effect. Use `npm run watch` to rebuild automatically on save.

## VSIX install (persistent, survives restarts)

A single npm script handles the full flow — build, package, and install:

```bash
npm install
npm run vscode:install
```

Then reload VS Code: `Cmd+Shift+P` → **Developer: Reload Window**

Any `.md` file now opens with LiveMarkdown as the default editor.

### What the script does

1. `npm run package` — production build (minified, no sourcemaps)
2. `npx @vscode/vsce package` — bundles into `live-markdown-<version>.vsix`
3. Installs via the real VS Code CLI binary (the shell `code` alias on macOS wraps `open` and doesn't support `--install-extension`)

> **Note:** VS Code does not expose a reload command via the CLI, so a manual reload is always required after install: `Cmd+Shift+P` → **Developer: Reload Window**

## Updating after code changes

Run `npm run vscode:install` again and reload. The reinstall overwrites the previous version in-place; no manual uninstall is needed.

## Reopening with the default editor

To open a file with the built-in markdown preview instead, right-click the tab → **Reopen Editor With…** → select the default VS Code option.

## Build commands

```bash
npm run build          # Dev build
npm run watch          # Watch mode
npm run package        # Production build (minified)
npm run check-types    # TypeScript type check
npm test               # Run test suite
```
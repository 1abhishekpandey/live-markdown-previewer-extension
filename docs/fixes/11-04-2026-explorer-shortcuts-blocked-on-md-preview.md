Explorer Shortcuts Blocked on `.md` Preview Tabs

# Problem

Native VS Code Explorer shortcuts stopped working on `.md` files:

1. Selecting a `.md` file in the Explorer and pressing `Enter` did nothing — no inline rename.
2. `Cmd+Delete` on a selected `.md` file did nothing — no trash.
3. The only way to rename was the slow double-click gesture on the file name.

Every other file type (`.txt`, `.json`, `.ts`, …) worked correctly. The regression was specific to markdown files that LiveMarkdown's custom editor claims.

The expectation: file-level Explorer shortcuts should behave identically for `.md` files and every other file type, because those shortcuts are owned by the Explorer view, not the editor.

# Root Cause

The custom editor is registered with `priority: "option"` in `package.json`, so VS Code opens `.md` files in the default text editor by default. To still give users the WYSIWYG experience, `activate()` in `src/extension.ts` installed an `onDidChangeActiveTextEditor` listener that, the moment any `.md` file became the active text editor, ran:

```ts
await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
await vscode.commands.executeCommand(
  'vscode.openWith', uri, 'liveMarkdown.markdownEditor'
);
```

This hijack fired on a single-click preview from the Explorer. Single-click preview is how VS Code lets users browse files without committing a tab — crucially, it keeps DOM focus in the Explorer so keyboard shortcuts like `Enter` = rename and `Cmd+Delete` = trash still work. The hijack broke this in two steps:

1. `workbench.action.closeActiveEditor` closed the raw preview tab and moved focus into the editor group area, away from the Explorer.
2. `vscode.openWith(..., 'liveMarkdown.markdownEditor')` then opened the WYSIWYG tab, which defaulted to taking focus.

By the time the user's `Enter` or `Cmd+Delete` keystroke landed, focus was no longer in the Explorer, so the shortcut missed its target. Passing `{ preserveFocus: true }` to `openWith` did not help — `closeActiveEditor` had already moved focus before `openWith` ran, so there was no Explorer focus left to preserve.

The interaction was invisible on other file types because no other extension in the user's setup hijacks `onDidChangeActiveTextEditor` on single-click preview.

# Fix

The hijack now leaves preview tabs alone entirely. WYSIWYG auto-swap runs only once a tab is committed (non-preview), at which point the user has already signalled they want to interact with the file and focus-in-editor is the correct behaviour.

Two listeners cooperate in `src/extension.ts`:

1. `onDidChangeActiveTextEditor` — bails out when `vscode.window.tabGroups.activeTabGroup.activeTab?.isPreview === true`. For committed tabs (`Cmd+P`, double-click), it runs the existing close-then-open swap.
2. `onDidChangeTabs` — the `changed` event fires when `isPreview` flips from `true` to `false`, which is how VS Code signals that a preview has been committed (double-click on the file, click on the tab title, type into the editor). When the listener sees an `.md` text tab become non-preview and that tab is the active tab, it runs the same swap to WYSIWYG.

A shared `swapToWysiwyg(uri)` helper wraps `closeActiveEditor` + `openWith` behind the existing `isAutoSwitching` guard so the two listeners cannot reenter each other. A `shouldAutoSwap(tab, uri)` predicate centralises the filename/scheme/raw-mode checks.

The existing tab-close cleanup of the `rawModeUris` set (used by the raw-mode toggle command) is folded into the same `onDidChangeTabs` listener — the old `tabCloseDisposable` is gone and the subscription list is updated.

```ts
const swapToWysiwyg = async (uri: vscode.Uri) => {
  isAutoSwitching = true;
  try {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.commands.executeCommand(
      'vscode.openWith',
      uri,
      'liveMarkdown.markdownEditor'
    );
  } finally {
    isAutoSwitching = false;
  }
};

const autoOpenDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
  if (isAutoSwitching || !editor) return;
  if (editor.document.languageId !== 'markdown') return;
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (activeTab?.input instanceof vscode.TabInputTextDiff) return;
  if (activeTab?.isPreview === true) return;   // key change
  if (!shouldAutoSwap(activeTab, editor.document.uri)) return;
  await swapToWysiwyg(editor.document.uri);
});

const tabChangeDisposable = vscode.window.tabGroups.onDidChangeTabs(async (e) => {
  for (const tab of e.closed) {
    if (tab.input instanceof vscode.TabInputText) {
      rawModeUris.delete(tab.input.uri.toString());
    }
  }
  if (isAutoSwitching) return;
  for (const tab of e.changed) {
    if (isAutoSwitching) return;
    if (tab.isPreview) continue;
    if (!(tab.input instanceof vscode.TabInputText)) continue;
    if (!shouldAutoSwap(tab, tab.input.uri)) continue;
    if (tab !== vscode.window.tabGroups.activeTabGroup.activeTab) continue;
    await swapToWysiwyg(tab.input.uri);
    break;
  }
});
```

# Why Not Simply `priority: "default"`

The obvious alternative — promote the custom editor to `priority: "default"` and delete the hijack entirely — is blocked by commit `1c835e5` (`fix: render native diff in Source Control by switching to option priority`). With `default` priority, both sides of a Source Control diff view routed through our custom editor, which produced plain-text output via a fallback path instead of the native diff editor's red/green highlighting and gutter marks. `option` priority is required to keep native diff working, so the hijack pattern has to stay — just trained to respect preview tabs.

# Trade-off

Single-click preview on a `.md` file in the Explorer now shows the raw markdown text instead of the rendered WYSIWYG view. The swap to WYSIWYG happens the moment the user commits to the tab:

- Double-click the file in the Explorer.
- Click the tab title.
- Type into the editor (which implicitly commits).
- Open via `Cmd+P` (non-preview by default on modern VS Code).

This is the cost of never stealing focus from the Explorer during preview — the two goals are mutually exclusive. Keeping Explorer shortcuts native was judged the more important of the two since preview is transient by design.

# Files Changed

- `src/extension.ts` — `autoOpenDisposable` now skips preview tabs; new `swapToWysiwyg` helper and `shouldAutoSwap` predicate; `onDidChangeTabs` listener handles both tab-close cleanup and preview-commit swap; subscription list updated.

# Verification

- `npm run check-types` — clean.
- Manual in the Extension Development Host:
  - Single-click a `.md` file in the Explorer → raw preview tab opens, Explorer keeps focus (keyboard-navigation outline still on the file entry).
  - With the `.md` file selected in the Explorer, press `Enter` → inline rename starts.
  - With the `.md` file selected, press `Cmd+Delete` → file moves to trash.
  - `F2`, `Cmd+C`/`Cmd+V`, `Alt+Up`/`Alt+Down` on a selected `.md` → behave the same as on a `.txt` file.
  - Double-click a `.md` file → opens directly in WYSIWYG.
  - Single-click to preview, then click the tab title → preview commits and swaps to WYSIWYG.
  - Single-click to preview, then click into the editor and type → preview commits and swaps to WYSIWYG.
  - Open a `.md` file via `Cmd+P` → opens directly in WYSIWYG.
  - Toggle raw ↔ WYSIWYG with `Shift+Cmd+M` → both directions still work, raw-mode preference persists while the tab is open.
  - Open a changed `.md` file from the Source Control view → native text diff renders with red/green highlighting (custom editor does not intercept).

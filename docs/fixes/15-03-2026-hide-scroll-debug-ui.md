Hide Scroll Debug UI

# What Changed

The scroll-position debug overlays used during development have been hidden from the UI. The underlying logic is retained for future debugging.

# Debug Elements Hidden

- **Raw mode status bar** (`extension.ts`): Removed `debugStatus.show()` so the status bar item is created and updated but never displayed. Call `debugStatus.show()` to re-enable.
- **Preview mode overlay** (`index.ts`): The `debugLineInfo` message handler no longer calls `updateDebugOverlay`. The method remains on `SyncClient` for manual use.
- **Debug line info message** (`markdownEditorProvider.ts`): `scrollAnchorUpdate` handler still calls `findAnchorLine` (keeps the anchor cache warm) but no longer posts `debugLineInfo` back to the webview.

# How to Re-enable

- **Raw mode**: Add `debugStatus.show()` after line 85 in `extension.ts`
- **Preview mode**: Restore `syncClient.updateDebugOverlay(data.lineNum, data.lineText)` in `index.ts` and re-add the `webview.postMessage` call in `markdownEditorProvider.ts`

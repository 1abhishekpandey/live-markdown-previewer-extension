Scroll Debug Overlays

Developer-only debug overlays for diagnosing scroll sync issues. Hidden by default — re-enable when debugging scroll position drift or toggle sync problems.

# What Exists

## Raw mode - status bar item

`extension.ts` creates a status bar item that shows the top visible line number and text in the raw markdown editor.

Format: `$(debug) L25 | bgElevated | #1A1A36 | Selected sta…`

The item is created and updated on every scroll/editor change but not shown (`debugStatus.show()` is commented out).

## Preview mode - fixed overlay

`syncClient.ts` has `updateDebugOverlay()` which renders a fixed-position green-on-black overlay at the top-right of the webview showing the resolved raw line number and text.

Format: `L25 | bgElevated | #1A1A36 | Selected states, hover |`

The message pipeline exists (`scrollAnchorUpdate` -> `findAnchorLine` -> `debugLineInfo` -> `updateDebugOverlay`) but the final call is skipped in `index.ts`.

# How to Re-enable

## Raw mode status bar

In `extension.ts`, add `debugStatus.show()` after the `debugStatus.name = 'Scroll Debug';` line (~line 85).

## Preview mode overlay

Two changes needed:

1. In `markdownEditorProvider.ts`, restore the `debugLineInfo` post inside the `scrollAnchorUpdate` handler:
```ts
const line = findAnchorLine(document, msg.anchorText, msg.roughFraction);
const lineText = document.lineAt(line).text;
webview.postMessage({ type: 'debugLineInfo', lineNum: line + 1, lineText });
```

2. In `webview/index.ts`, restore the overlay call inside the `debugLineInfo` handler:
```ts
if (data.type === 'debugLineInfo') {
  syncClient.updateDebugOverlay(data.lineNum, data.lineText);
  return;
}
```

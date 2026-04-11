Spike 3 — Clipboard write path decision

Status: DECIDED

# Existing state

- navigator.clipboard usage in src/: NONE
- vscode.env.clipboard usage in src/: NONE
- Existing synthetic-copy pattern: src/webview/copyToolbar.ts:24-34

# CSP evidence

Line 190 of src/markdownEditorProvider.ts:

```
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource};">
```

The CSP has `default-src 'none'` and no `connect-src`, no `worker-src`, and crucially no `clipboard-write` permissions policy. `navigator.clipboard.writeText` is a browser API call — it does not require a CSP directive (CSP does not gate Clipboard API access), but VS Code webviews do require the `clipboard-write` permission to be granted. VS Code grants this automatically for webviews on trusted origins (since 1.64), so the CSP is not the blocking factor. However, the webview HTML has no explicit `permissions` attribute on any script tag, which is fine — VS Code handles clipboard permission at the webview container level. The CSP does not block `navigator.clipboard.writeText`.

# Chosen path

Path 1 — webview-direct `navigator.clipboard.writeText`

**Rationale**: The CSP contains no directive that blocks the Clipboard API; `default-src 'none'` restricts resource loading (scripts, styles, images, fonts, connections) but does not govern JS runtime APIs such as `navigator.clipboard`. VS Code 1.96.0 (the engine floor) is well past the 1.64 threshold at which clipboard write was enabled for trusted webview origins. Path 1 requires zero protocol changes and adds no cross-context round-trip.

# Follow-up for LLD

Path 1 requires no changes to `src/sync/syncProtocol.ts` or `src/markdownEditorProvider.ts`.

Note: `src/webview/copyToolbar.ts` uses the synthetic `copy` event pattern (lines 24-34) because it must intercept an in-progress clipboard operation and rewrite its content — a different problem from writing an arbitrary string on demand. The LLM-Assist output copy should call `navigator.clipboard.writeText(text)` directly at the point the user triggers the copy action. Migrating `copyToolbar.ts` to `navigator.clipboard` is out of scope for LLM-Assist.

# Evidence for HLD update

assumed → verified — chosen path: Path 1 (webview-direct navigator.clipboard.writeText)

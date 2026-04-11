Spike 2 — ProseMirror gutter decoration plugin

Status: 2a PASS (vitest) / 2b PASS with scope gap (human visual)
Test file: src/__tests__/spikes/llmGutterPlugin.spike.test.ts
Run command: npm test -- src/__tests__/spikes/llmGutterPlugin.spike.test.ts

# 2a — Vitest result

All three assertions passed in ~15 ms; both decoration classes were applied to
the correct DOM nodes.

Console output:
```
Empty gutter lines: 2
Counted gutter lines: 1
  count attr: 2
```

ProseMirror's `Decoration.node` correctly attaches `class` and `data-count` to
block-level nodes, and happy-dom reflects them to the DOM immediately. The
HLD's `LlmGutterPlugin` design (one plugin, two decoration classes, data
attribute for badge count) is viable without any `Decoration.widget` fallback.

# 2b — Human visual result

**PASS for the core behaviours** (verified on a real README.md):

- Uncommented top-level paragraphs and headings show a translucent `+` on
  hover that fades out on mouse-out.
- The fake-count line (index 1) always shows `2` in the left margin
  regardless of hover state.
- The `+` colour tracks `--vscode-editor-foreground` across light/dark themes.

**Scope gap observed**: the `+` does NOT appear for list items (bullet /
ordered / task), code blocks, blockquote inner content, or table rows. Only
top-level block children of `doc` are decorated.

## Root cause

The spike's plugin walks `state.doc.forEach(...)`, which only iterates
top-level children of the doc node. Every nested block (each `list_item`
inside a `bullet_list`, each `paragraph` inside a `blockquote`, each
`table_row` inside a `table`) is skipped. A bullet list of five items gets
one decoration on its `bullet_list` container — which is why the first `+`
appears to float near the first bullet but none of the later items get one.

This is a flaw in the spike plugin's walk, not a limitation of
`Decoration.node`. Proof: `src/webview/gfmAlert.ts:19` uses
`state.doc.descendants((node, pos) => ...)` and correctly finds nested
`blockquote` nodes. The existing `commentIndicator.ts` uses a different
approach: it walks `lineMap.posToLineRange` entries (markdown-source-line →
ProseMirror position), which gives one decoration slot per commentable
markdown source line — exactly the primitive the HLD intended when it said
"extend `commentIndicator.ts`". The spike took a shortcut that the real
implementation will not.

## Commentable-block scope for the feature

The HLD's "every block-level node" wording was loose. Working set of block
node types registered in the editor (`src/webview/editor.ts`):

| Node type | Source | Decorate? | Notes |
|---|---|---|---|
| `paragraph` | StarterKit | **Yes** | Baseline text block. |
| `heading` | StarterKit | **Yes** | All six levels. |
| `list_item` | StarterKit | **Yes** | Each bullet/ordered item is an independent commentable unit. |
| `task_item` | `@tiptap/extension-task-item` | **Yes** | Same as list_item — one `+` per checkbox row. |
| `code_block` | `CustomCodeBlock` (CodeBlockLowlight) | **Yes** | Whole block is one comment target; no per-line commenting inside a code block. |
| `blockquote` | StarterKit | **No** (container) | Its inner `paragraph`s already get decorations; decorating the container too would double up. Exception: GFM alerts (`gfm-alert-*` class) — leave those alone or decorate only the inner paragraph. |
| `horizontal_rule` | StarterKit | **No** | Nothing to comment on. |
| `bullet_list` / `ordered_list` / `task_list` | StarterKit + extensions | **No** (containers) | The `list_item` / `task_item` children get the `+`. |
| `table` | `@tiptap/extension-table` | **Yes, whole table** | Commenting on a whole table is the common case. Skip `table_row`, `table_cell`, `table_header` to avoid `+`-per-cell noise. |
| `table_row` / `table_cell` / `table_header` | `@tiptap/extension-table` | **No** | Too granular for the UX; the user wants "comment on this table", not "comment on cell (3, 2)". |
| Image (`localImage`) | `LocalImage` | N/A — inline node, not a block; it lives inside a paragraph. |

Rule: **decorate leaf-commentable blocks; skip containers.** A node is
leaf-commentable if (a) a human reader would point at it as a single unit
and (b) decorating its parent would double-count.

## Recommended fix for the LLD / implementation

The real `LlmGutterPlugin` (extending `commentIndicator.ts` per the HLD)
must:

1. Walk the doc with `state.doc.descendants((node, pos) => ...)` instead of
   `doc.forEach`, OR walk `lineMap.posToLineRange` entries like
   `commentIndicator.ts` already does — prefer the latter for consistency
   with the existing Review-mode plugin.
2. Filter to the commentable-node set above: accept
   `paragraph`, `heading`, `list_item`, `task_item`, `code_block`, `table`.
   Skip every other node type.
3. When the containing block is a `table`, the `+` sits in the gutter next
   to the top-left of the table — confirm this is visually acceptable in
   the first implementation pass; fall back to "comment on table_row" only
   if the whole-table affordance reads wrong.

This does not change the Spike 2 outcome: the decoration mechanism itself
is validated. The scope expansion is an implementation detail of the real
plugin, not a new unvalidated assumption.

# Evidence for HLD update

[Assumed] → [Verified]: decoration plugin can render hover-sensitive `+`
and count badge on block nodes without the two competing for the same
slot. Spike file: `src/__tests__/spikes/llmGutterPlugin.spike.test.ts`.

The HLD's LlmGutterPlugin entry should be amended to list the commentable
node-type set explicitly (rather than "every block-level node"), and to
specify that the walk uses `lineMap` or `descendants`, not `doc.forEach`.

LLM-Assist Mode - Spike Plan

Status: Draft
Owner: Abhishek
Last updated: 2026-04-12

# Overview

The HLD at `docs/feat/plans/HLD.md` lists five unvalidated assumptions that the design stakes significant behaviour on. Three of them gate the feature outright — if TipTap cannot stack overlapping marks, the text-level flow collapses; if ProseMirror cannot render a hover-sensitive decoration, the gutter `+` needs a different mechanism; if the webview has no clipboard write path, the entire feature has no output. The other two are degrades-UX risks with known fallbacks.

All five validations below are runnable in this repo using the existing vitest + happy-dom infrastructure (`src/__tests__/unit/` has `commentPanel.test.ts`, `commentIndicator.test.ts`, and `searchBar.test.ts` as working templates). Four are tagged LLM-executable and one needs a ten-minute human visual check in the dev extension host.

Total estimated spike time: ~95 minutes (~85 LLM-executable, ~10 human).

# Validations

## TipTap inline mark stacking on overlapping ranges

- **Assumption**: multiple `LlmCommentMark` instances can coexist on overlapping text ranges with distinct comment IDs, and clicks on the overlap region can be routed to a specific mark instance.
- **Source**: HLD § Architecture (`LlmCommentMark`) and § Commenting Affordances / Text-level flow rule 5 ("Overlapping selections layer a new mark on top of the existing one, creating a second independent comment").
- **Risk if wrong**: blocks feature. The text-level flow's overlapping-selections invariant breaks. If TipTap flattens overlapping marks or cannot keep per-instance attributes distinct, phrase-level commenting either (a) can only support one comment per range, or (b) has to be rebuilt on top of ProseMirror widget decorations instead of inline marks, which is a substantial redesign.
- **Executor**: LLM-executable
- **Time estimate**: 30 min

### Validation Script

Create a new file `src/__tests__/spikes/llmCommentMark.spike.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Mark, mergeAttributes } from '@tiptap/core';

const LlmCommentMark = Mark.create({
  name: 'llmCommentMark',
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: el => el.getAttribute('data-comment-id'),
        renderHTML: attrs => ({ 'data-comment-id': attrs.commentId }),
      },
    };
  },
  // Allow multiple marks of this type on the same range (distinct attrs = distinct instances)
  excludes: '',
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'llm-comment' }, HTMLAttributes), 0];
  },
});

describe('LlmCommentMark stacking', () => {
  test('two overlapping marks with distinct IDs both persist', () => {
    const editor = new Editor({
      extensions: [StarterKit, LlmCommentMark],
      content: '<p>The quick brown fox jumps over the lazy dog</p>',
    });

    // Mark A: positions 5-15 ("quick brown")
    editor.chain().focus().setTextSelection({ from: 5, to: 16 })
      .setMark('llmCommentMark', { commentId: 'A' }).run();

    // Mark B: positions 11-20 ("brown fox") — overlaps with A at "brown"
    editor.chain().focus().setTextSelection({ from: 11, to: 20 })
      .setMark('llmCommentMark', { commentId: 'B' }).run();

    const html = editor.getHTML();
    console.log('HTML after overlapping marks:', html);

    // Inspect the ProseMirror doc directly
    const marksAtOverlap: string[] = [];
    editor.state.doc.nodesBetween(11, 16, node => {
      for (const mark of node.marks) {
        if (mark.type.name === 'llmCommentMark') {
          marksAtOverlap.push(mark.attrs.commentId);
        }
      }
      return true;
    });

    console.log('Mark IDs at overlap region:', marksAtOverlap);

    // Expect both A and B to be present in the overlap region
    expect(marksAtOverlap).toContain('A');
    expect(marksAtOverlap).toContain('B');

    // Expect distinct spans in the rendered HTML
    const spanMatches = html.match(/data-comment-id="[AB]"/g);
    expect(spanMatches?.length).toBeGreaterThanOrEqual(2);

    editor.destroy();
  });
});
```

Run: `npm test -- src/__tests__/spikes/llmCommentMark.spike.test.ts`

### Expected Result

Test passes. Console output shows `marksAtOverlap` contains both `'A'` and `'B'` for the "brown" region, and the rendered HTML contains at least two distinct `data-comment-id` attributes (either as nested `<span>` elements or as a single span carrying stacked attributes). The specific DOM shape matters less than the ProseMirror state — if the doc knows both marks exist at positions 11-16, the design works.

### If Validation Fails

Two fallback paths in priority order:

1. **Drop the `excludes: ''` approach and model each comment as a ProseMirror widget decoration instead of an inline mark.** Widget decorations are layered per-plugin and do not compete for the same range, so overlap is free. Cost: click-routing becomes a DOM event listener on each widget rather than a natural mark click; selection preservation during edits is harder because widgets do not move with the text. This is a meaningful redesign but still achievable within the HLD's "two granularities" goal.
2. **Downgrade the "overlapping selections = new comment" invariant to "overlapping selections merge into the existing comment".** Match-and-append rather than stack. The HLD's rule 5 changes from "layer on top" to "new selection that overlaps an existing mark edits the existing comment". Less expressive but keeps inline marks viable.

### Acceptance Criteria

This assumption is validated when the spike test passes and the console output confirms both comment IDs are present in the overlap region, as observed both in the ProseMirror doc state and in the rendered HTML.

---

## ProseMirror decoration plugin with hover-activated `+` and count badge

- **Assumption**: a single ProseMirror plugin can render both a hover-activated `+` widget (when the line has no line-level comment) and a static count badge (once any comment exists on the line) on the same block-level node, without the two competing for the same decoration slot.
- **Source**: HLD § Architecture (`LlmGutterPlugin`) and § Key Decisions row "Gutter widget owner".
- **Risk if wrong**: blocks feature UX. If hover state cannot be modelled inside a decoration, the gutter `+` needs a different mechanism — most likely a pure CSS `:hover` rule on the decorated block node, with the `+` rendered as an always-present DOM element hidden by default. That fallback works but loses the ability to suppress `+` on commented lines via decoration state; it has to be done via a second data attribute and a CSS selector. Net result is an extra CSS file and a small divergence from `commentIndicator.ts`'s pattern.
- **Executor**: LLM-executable part + Human-required visual check
- **Time estimate**: 15 min LLM + 10 min human = 25 min

### Validation Script (LLM-executable part)

Create `src/__tests__/spikes/llmGutterPlugin.spike.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/core';

const PK = new PluginKey('llmGutter');

// Minimal plugin that decorates every block node with:
//   - class="llm-gutter-empty" (hover rule in CSS shows "+")
//   - OR class="llm-gutter-count" data-count="N" (commented lines)
const LlmGutterExtension = Extension.create({
  name: 'llmGutter',
  addProseMirrorPlugins() {
    const commentCounts = new Map<number, number>();
    commentCounts.set(1, 2); // line index 1 has 2 comments

    return [
      new Plugin({
        key: PK,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            let lineIndex = 0;
            state.doc.forEach((node, offset) => {
              if (node.isBlock) {
                const count = commentCounts.get(lineIndex);
                if (count && count > 0) {
                  decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                      class: 'llm-gutter-count',
                      'data-count': String(count),
                    }),
                  );
                } else {
                  decorations.push(
                    Decoration.node(offset, offset + node.nodeSize, {
                      class: 'llm-gutter-empty',
                    }),
                  );
                }
                lineIndex++;
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

describe('LlmGutterPlugin decoration slots', () => {
  test('decorates uncommented and commented lines with distinct classes', () => {
    const editor = new Editor({
      extensions: [StarterKit, LlmGutterExtension],
      content: '<p>first line</p><p>second line</p><p>third line</p>',
    });

    // Wait one microtask for decoration application
    const dom = editor.view.dom as HTMLElement;
    const empty = dom.querySelectorAll('.llm-gutter-empty');
    const counted = dom.querySelectorAll('.llm-gutter-count');

    console.log('Empty gutter lines:', empty.length);
    console.log('Counted gutter lines:', counted.length);
    counted.forEach(el => console.log('  count attr:', el.getAttribute('data-count')));

    expect(empty.length).toBe(2); // lines 0 and 2
    expect(counted.length).toBe(1); // line 1
    expect(counted[0]?.getAttribute('data-count')).toBe('2');

    editor.destroy();
  });
});
```

Run: `npm test -- src/__tests__/spikes/llmGutterPlugin.spike.test.ts`

### Validation Script (Human-required part)

After the LLM-executable part passes, visually confirm the hover affordance works in the actual webview:

1. `cd /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension`
2. Temporarily add this CSS to `src/webview/styles.css`:

   ```css
   .llm-gutter-empty { position: relative; }
   .llm-gutter-empty::before {
     content: '+';
     position: absolute;
     left: -24px;
     color: var(--vscode-editor-foreground);
     opacity: 0;
     transition: opacity 100ms;
   }
   .llm-gutter-empty:hover::before { opacity: 0.6; }
   .llm-gutter-count::before {
     content: attr(data-count);
     position: absolute;
     left: -24px;
     color: var(--vscode-editor-foreground);
   }
   ```

3. Temporarily register `LlmGutterExtension` in `src/webview/editor.ts` alongside the other extensions.
4. `npm run vscode:install`, reload VS Code, open any `.md` file.
5. Observe: lines with no count should show `+` on hover and nothing otherwise; lines with a count (faked via the hardcoded `commentCounts.set(1, 2)`) should always show `2`.
6. Revert the temporary edits (`git restore src/webview/styles.css src/webview/editor.ts`).

### Expected Result

- **LLM part**: test passes; console shows 2 empty gutter lines, 1 counted gutter line with `data-count="2"`.
- **Human part**: hovering an uncommented line shows a translucent `+` in the left margin that disappears on mouse-out; line index 1 always shows `2` in the left margin regardless of hover.

### If Validation Fails

- **LLM part fails**: decoration classes are not being applied to block nodes. Check whether `Decoration.node` is the right primitive; fall back to `Decoration.widget` with an explicit side position. Widget decorations are guaranteed to render a DOM element at a specific position, at the cost of the element not being tied to the block node's layout.
- **Human part fails**: hover rule does not fire because the decorated class is on a wrapper that does not receive mouse events. Fall back to putting the hover rule on a child pseudo-element or attaching a `mouseenter`/`mouseleave` listener in the plugin's `view()` prop and toggling a second class manually.

### Acceptance Criteria

This assumption is validated when (a) the vitest spike confirms the plugin can emit both decoration classes on the same doc, and (b) the human-visual spike in the dev extension host confirms the CSS hover rule fires correctly on uncommented lines.

---

## Clipboard write path from the webview

- **Assumption**: the webview can write a multi-line plain-text payload to the system clipboard, either directly via `navigator.clipboard.writeText` or by posting a message to the extension host which then calls `vscode.env.clipboard.writeText`.
- **Source**: HLD § Architecture (diagram shows `vscode.env.clipboard.writeText` via the existing `postMessage` bridge) and § Assumptions & Unknowns § "clipboard write path".
- **Risk if wrong**: blocks feature. If neither path works, the payload has nowhere to go. The entire feature's output is the clipboard; if writing fails, there is no feature.
- **Executor**: LLM-executable
- **Time estimate**: 15 min

### Validation Script

Two-part code search followed by a decision:

Part A: check whether the webview already uses `navigator.clipboard` and whether the webview CSP permits it.

Run these commands:

```bash
# Existing clipboard usage in the webview
grep -rn "navigator.clipboard" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/webview

# CSP in the generated webview HTML
grep -n "Content-Security-Policy\|clipboard-write" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/markdownEditorProvider.ts
```

Part B: check for existing extension-host clipboard usage and any `postMessage` handler that could carry a `copyToClipboard` payload.

```bash
grep -rn "env.clipboard\|vscode.env.clipboard" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src

# Existing postMessage message types for inspiration on where to add a new one
grep -n "type:" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/sync/syncProtocol.ts
```

Part C (decision): based on A and B, choose one of three outcomes:

1. **Webview-direct via `navigator.clipboard.writeText`** — if the CSP allows it and VS Code webviews expose the API. No protocol addition needed.
2. **Extension-host via `postMessage → vscode.env.clipboard.writeText`** — if the webview path is blocked. Requires adding a new `copyToClipboard` message type to `src/sync/syncProtocol.ts` and a handler in `src/markdownEditorProvider.ts`.
3. **Synthetic `copy` event** — if both fail, dispatch a synthetic `copy` event and write to `event.clipboardData` (the same technique `copyToolbar.ts:24-33` already uses for markdown copy). Works but requires the webview to hold focus at copy time.

### Expected Result

One of the three paths is confirmed viable. The spike output is a short decision note: "Clipboard write path: [chosen approach] — [one-sentence rationale from the grep output]."

### If Validation Fails

All three paths failing is extremely unlikely (the extension already ships a markdown-copy feature via `copyToolbar.ts`), but if it happens: fall back to rendering the payload into a textarea inside the panel, pre-selected, with an instruction "press Cmd+C to copy". Ugly but guaranteed to work.

### Acceptance Criteria

This assumption is validated when the grep output lets us pick a specific clipboard write path, documented in the spike decision note, and that path is known to work in VS Code webviews (either by existing usage in this repo or by VS Code docs).

---

## `commentPanel.ts` thread-UI strip refactorability

- **Assumption**: the thread UI (author, timestamps, Outdated/Draft/Pending markers, reply section) in `commentPanel.ts` can be removed or gated behind a flag without disturbing the panel's positioning, click-outside-to-close, Escape-to-close, and textarea text preservation on refresh.
- **Source**: HLD § Reuse ("Floating comment panel") and § Key Decisions row "Comment panel".
- **Risk if wrong**: degrades implementation cost, not user-visible behaviour. If the thread UI is tangled into the panel's core layout, the "reuse with thread UI stripped" claim collapses into "fork and maintain a 425-line parallel file". The feature still works; it just carries more code.
- **Executor**: LLM-executable
- **Time estimate**: 15 min

### Validation Script

Read `src/webview/commentPanel.ts` end-to-end and answer three questions:

```bash
wc -l /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/webview/commentPanel.ts
# Confirmed: 425 lines

# Find the thread-rendering boundaries
grep -n "author\|timestamp\|relativeTime\|outdated\|draft\|pending\|reply" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/webview/commentPanel.ts

# Find the positioning / close-handler boundaries
grep -n "getBoundingClientRect\|addEventListener\|Escape\|click" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/webview/commentPanel.ts
```

Then answer on paper:

1. Is the thread rendering inside a single method (e.g. `renderThread`, `renderComment`) that can be replaced with a no-op for LLM-Assist, or is it interleaved with the textarea and save-button rendering in `openNew` / `openThread`?
2. Do the positioning methods (anchor-rect, window-bound clamping) call anything inside the thread-rendering path, or are they independent?
3. Does the close handler depend on thread state (e.g. "do not close while a reply is being edited") or is it a flat click-outside / Escape listener?

### Expected Result

A short structural assessment recorded in the spike output, shaped like:

> `commentPanel.ts`: thread UI lives in `renderThread` (lines X-Y) and `formatRelativeTime` (lines A-B). Positioning (`anchorTo`, lines P-Q) and close handlers (lines C-D) do not reference thread state. Stripping the thread UI means: (a) skip `renderThread`, (b) replace `formatLineHeader(..., isNew=true)` usage to always go through the single-body path. No changes to positioning or close handlers. Estimated LOC change: small.

### If Validation Fails

If the thread UI is interleaved with positioning or close logic, fork `commentPanel.ts` to `llmCommentPanel.ts` and maintain it as an independent file. Accept the ~425 LOC duplication cost. The HLD's Key Decisions row "Comment panel" flips from "Reuse with thread UI stripped" to "Fork; track upstream fixes manually".

### Acceptance Criteria

This assumption is validated when the structural assessment shows thread-UI rendering is a self-contained subtree that can be gated behind a flag, AND positioning + close handlers have zero references to thread state.

---

## Selection-anchored `+` button positioning without `BubbleMenu`

- **Assumption**: the selection-anchored `+` button for the text-level flow can be positioned using `window.getSelection().getRangeAt(0).getBoundingClientRect()` (plus the existing pattern in `linkDialog.ts`), without importing the full `@tiptap/extension-bubble-menu` dependency.
- **Source**: HLD § Assumptions & Unknowns § "BubbleMenu-style selection-anchored `+`".
- **Risk if wrong**: cosmetic. If the hand-rolled positioning is fiddly, fall back to importing `BubbleMenu`. Bundle size goes up by a modest amount; no user-visible impact.
- **Executor**: LLM-executable
- **Time estimate**: 10 min

### Validation Script

Read `src/webview/linkDialog.ts` (125 lines) end-to-end and check whether its positioning logic is:

```bash
grep -n "getBoundingClientRect\|getSelection\|offsetTop\|offsetLeft\|top\|left" /Users/abhishekpandey/Documents/Abhishek/personal/Ideas/live-markdown-previewer-extension/src/webview/linkDialog.ts
```

Then answer:

1. Does `linkDialog.ts` already anchor a floating element to the current selection? (It opens on Cmd+K, which is selection-based, so it probably does.)
2. Is the positioning logic a single function or scattered across multiple places?
3. Does it handle edge cases (viewport edges, scroll position) that the LLM-Assist `+` button would also need?

### Expected Result

A short note confirming `linkDialog.ts` has reusable selection-anchoring logic. If it does, the LLM-Assist `+` button is a thin adaptation of the same pattern — no `BubbleMenu` import needed.

### If Validation Fails

If `linkDialog.ts`'s positioning is not reusable or does not handle selection rects at all, fall back to `import { BubbleMenu } from '@tiptap/extension-bubble-menu'`. The dependency already lives in TipTap's extension ecosystem and is compatible with the existing editor config.

### Acceptance Criteria

This assumption is validated when `linkDialog.ts` is confirmed to have reusable selection-rect positioning, OR when the fallback decision to import `BubbleMenu` is recorded with a bundle-size estimate.

---

# Human Checkpoint Budget

| Validation | Time | When |
|---|---|---|
| LlmGutterPlugin hover visual check in dev extension host | 10 min | After LLM vitest spike passes |

Total human time: 10 minutes.

# Validation Checklist

Ordered by risk severity (blocks feature first, cosmetic last):

- [ ] **TipTap inline mark stacking on overlapping ranges** — vitest spike proves two marks with distinct IDs coexist on an overlap region (LLM, 30 min)
- [ ] **ProseMirror decoration plugin emits empty and counted gutter classes** — vitest spike proves the plugin can produce both decoration states on the same doc (LLM, 15 min)
- [ ] **Gutter `+` hover visual check** — CSS hover rule fires on uncommented lines in the actual webview (Human, 10 min)
- [ ] **Clipboard write path decision** — grep confirms one of three paths (webview-direct, extension-host, synthetic copy event) is viable (LLM, 15 min)
- [ ] **`commentPanel.ts` refactorability assessment** — structural read confirms thread UI is a removable subtree (LLM, 15 min)
- [ ] **Selection-anchored `+` positioning reuse** — `linkDialog.ts` confirmed to have reusable selection-rect positioning, or fallback to `BubbleMenu` recorded (LLM, 10 min)

# Next Step

Execute the validations in checklist order. Run the four LLM-executable items in a single batch (they do not interact). Schedule the one human-required item after its LLM-executable counterpart passes. Once all six boxes are checked, update the HLD's Assumptions & Unknowns section — promote each `[Assumed]` item to `[Verified]` with the spike test file path as evidence — then run `/write:lld` to define detailed contracts.

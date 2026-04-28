Spike 1 — TipTap inline mark stacking on overlapping ranges

Status: PASS
Test file: src/__tests__/spikes/llmCommentMark.spike.test.ts
Run command: npm test -- src/__tests__/spikes/llmCommentMark.spike.test.ts

# Result

Passed — both overlapping marks with distinct commentIds coexist in the ProseMirror document and render correctly to HTML.

# Console output

HTML after overlapping marks: <p>The <span class="llm-comment" data-comment-id="A">quick <span class="llm-comment" data-comment-id="B">brown</span></span><span class="llm-comment" data-comment-id="B"> fox</span> jumps over the lazy dog</p>
Mark IDs at overlap region: [ 'A', 'B' ]

# Interpretation

Both comment IDs coexist in the overlap region. ProseMirror renders overlapping marks as **nested spans**, not stacked attributes on a single element. In the HTML, the "brown" segment (the overlap) is rendered as a nested `<span data-comment-id="B">` inside `<span data-comment-id="A">`, and the non-overlapping "fox" segment gets its own `<span data-comment-id="B">`. The `nodesBetween` inspection confirms both 'A' and 'B' mark IDs are present on nodes in the overlap range.

The key enabler is `excludes: ''` on the mark definition. Without it, ProseMirror's default mark exclusion logic would prevent two marks of the same type from coexisting. With it, each `llmCommentMark` instance (differentiated by `commentId`) stacks freely.

This confirms the HLD's text-level flow rule 5 is viable as written: the extension can apply multiple `llmCommentMark` instances with distinct IDs over overlapping text ranges, and ProseMirror will track them independently in the document model. No redesign needed.

# Evidence for HLD update

[assumed → verified]: `excludes: ''` + distinct `commentId` attrs enables true mark stacking on overlapping ranges in TipTap/ProseMirror.

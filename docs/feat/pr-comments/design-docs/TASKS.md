PR Comments Integration - Task Breakdown

# Overview

10 phases (0-9) covering the full feature: from a line-mapping feasibility gate through types, gh CLI layer, diff parsing, extension wiring, webview UI, end-to-end verification with stubbed writes, and finally real GitHub posting.

Strategy: all gh CLI **reads** are real from Phase 1. Only comment **posting** is stubbed until Phase 9. This means real PR detection, real comments, real diffs throughout development.

# Dependency Graph

```
Phase 0 (line mapping gate)
  │
  ▼
Phase 1 (types + protocol + ghCli)
  │
  ▼
Phase 2 (diff line mapper)
  │
  ▼
Phase 3 (PR detection + comment fetching + stubbed posting)
  │
  ├──────────────────────────────────────┐
  ▼                                      ▼
Phase 4 (extension wiring)    Phase 5 (pending store + toggle)  ← parallel
  │                            Phase 6 (decorations + panel)    ← parallel
  │                                      │
  ├──────────────────────────────────────┘
  ▼
Phase 7 (webview wiring + CSS)
  │
  ▼
Phase 8 (E2E verification, stubbed)
  │
  ▼
Phase 9 (real posting + final testing)
```

Phases 4, 5, and 6 can be worked in parallel — they have no dependencies on each other, only on Phase 3.

---

# Phases

## Phase 0: Line Mapping Prototype

**Depends on**: None
**PR scope**: Production `lineMap.ts` module using markdown-it token source maps for exact line ranges. Original naive block-node indexing approach was rejected (tables, code blocks, nested lists collapse multiple markdown lines into single ProseMirror nodes). Revised approach uses `md.parse()` tokens which carry `map: [startLine, endLine]` properties, walked in parallel with the ProseMirror doc tree.

**Files**:
- `src/webview/lineMap.ts` (new — production module, used by commentIndicator in Phase 6)
- `src/__tests__/unit/lineMap.test.ts` (new — 21 tests)

### Tasks

- [x] Task 1: Implement `buildLineMap` with parallel ProseMirror/token tree walker
  - Verification: `npm run check-types` passes
- [x] Task 2: Handle special cases — thead/tbody wrappers (skip), self-closing tokens (fence, hr), table cell synthetic paragraphs (detect inline-only token content, skip recursion)
  - Verification: Tables, code blocks, and hr all map correctly in tests
- [x] Task 3: Implement `findPosForLine` and `findLineForPos` lookup functions with reverse map (deepest node preference)
  - Verification: Reverse lookups return correct node types in tests
- [x] Task 4: Write tests covering paragraphs, headings, horizontal rules, code blocks, bullet/ordered/nested lists, tables, blockquotes, task lists, mixed complex content, edge cases
  - Verification: `npx vitest run src/__tests__/unit/lineMap.test.ts` — all 21 pass
- [x] Task 5: Verify 100% accuracy and no regressions
  - Verification: `npm run check-types` and `npm test` — 128 tests pass, zero type errors

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (128 tests: 107 existing + 21 new)
- [x] 100% accuracy across all markdown structures (paragraphs, headings, lists, tables, code blocks, blockquotes, task lists, mixed content)

---

## Phase 1: Foundation — Types, Protocol, gh CLI

**Depends on**: Phase 0 (go decision)
**PR scope**: All shared type definitions, sync protocol message additions, gh CLI wrapper with error classes and error classification. Pure definitions and one thin wrapper — no business logic yet.

**Files**:
- `src/sync/commentTypes.ts` (new)
- `src/sync/syncProtocol.ts` (modify)
- `src/gh/ghCli.ts` (new)
- `src/__tests__/unit/ghCli.test.ts` (new)

### Tasks

- [x] Task 1: Create `src/sync/commentTypes.ts` with all shared types: PrInfo, CommentData, CommentThread, PendingComment, DiffLineInfo, LineMapping, BatchSubmitResult
  - Verification: `npm run check-types` passes
- [x] Task 2: Add 5 Extension→Webview message interfaces to `syncProtocol.ts`: CommentDataMessage, ReviewSubmitResultMessage, CommentErrorMessage, LineMappingResultMessage, SavedPendingQueueMessage
  - Verification: `npm run check-types` passes; existing ExtensionToWebviewMessage union updated
- [x] Task 3: Add 6 Webview→Extension message interfaces to `syncProtocol.ts`: CommentToggleMessage, CommentRefreshMessage, CommentOpenPrMessage, ValidateLineMessage, SubmitReviewMessage, SavePendingQueueMessage
  - Verification: `npm run check-types` passes; existing WebviewToExtensionMessage union updated
- [x] Task 4: Implement `src/gh/ghCli.ts` — error classes (GhNotFoundError, GhAuthError, GhApiError), execGh, isGhAvailable, isGhAuthenticated, classifyGhError
  - Verification: `npm run check-types` passes
- [x] Task 5: Write `ghCli.test.ts` — all 17 test cases from the test plan (execGh success/ENOENT/non-zero, isGhAvailable, isGhAuthenticated, classifyGhError patterns)
  - Verification: `npx vitest run src/__tests__/unit/ghCli.test.ts` — all 17 pass

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (145 tests: 128 existing + 17 new ghCli tests)

---

## Phase 2: Diff Line Mapper

**Depends on**: Phase 1
**PR scope**: Unified diff parser, bidirectional line mapping builder, line validation functions. This is the core algorithm — heavily tested in isolation.

**Files**:
- `src/gh/diffLineMapper.ts` (new)
- `src/__tests__/unit/diffLineMapper.test.ts` (new)

### Tasks

- [x] Task 1: Implement `fetchDiff` — calls `gh pr diff {number}`, returns raw string
  - Verification: Function compiles, type-checks
- [x] Task 2: Implement `parseDiffForFile` — split diff by `diff --git` headers, find file section (handle renames via a/ and b/ paths), parse hunk headers, build LineMapping
  - Verification: Type-checks; algorithm matches LLD hunk parsing specification
- [x] Task 3: Implement `validateLineMapping` and `validateMultiLineMapping` — simple map lookups with multi-line fallback logic
  - Verification: Type-checks
- [x] Task 4: Write `diffLineMapper.test.ts` — 14 test cases: single hunk additions, mixed additions/deletions, multi-hunk, file not found, renames, validate single/multi-line, fetchDiff
  - Verification: `npx vitest run src/__tests__/unit/diffLineMapper.test.ts` — all 14 pass
- [x] Task 5: Edge case tests included — empty diff, `\ No newline at end of file` marker, omitted hunk count
  - Verification: Edge case tests pass

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (159 tests: 145 existing + 14 new diffLineMapper tests)

---

## Phase 3: GitHub Data Layer — PR Detection, Comment Fetching, Stubbed Posting

**Depends on**: Phase 2
**PR scope**: All remaining extension-side modules that interact with GitHub via `gh` CLI. Real reads (PR detection, comment fetching, current user). Stubbed writes (posting logs to output channel).

**Files**:
- `src/gh/prDetector.ts` (new)
- `src/gh/commentFetcher.ts` (new)
- `src/gh/commentPoster.ts` (new)
- `src/__tests__/unit/prDetector.test.ts` (new)
- `src/__tests__/unit/commentFetcher.test.ts` (new)
- `src/__tests__/unit/commentPoster.test.ts` (new)

### Tasks

- [x] Task 1: Implement `prDetector.ts` — detectPr, getRepoInfo, openPrInBrowser
  - Verification: Type-checks; `detectPr` combines `gh pr view` + `gh repo view` into PrInfo
- [x] Task 2: Write `prDetector.test.ts` — all 6 test cases (PR exists, no PR, closed, not git repo, getRepoInfo, openPrInBrowser)
  - Verification: `npx vitest run src/__tests__/unit/prDetector.test.ts` — all 6 pass
- [x] Task 3: Implement `commentFetcher.ts` — fetchComments (with thread grouping, outdated detection, isOwn, file filtering, unmappable exclusion, paginated JSON handling), fetchCurrentUser
  - Verification: Type-checks; thread grouping handles root/reply separation, orphan replies
- [x] Task 4: Write `commentFetcher.test.ts` — all 13 test cases (single thread, replies, multiple threads, filtering, outdated, isOwn, unmappable, orphan, multi-line, empty, fetchCurrentUser)
  - Verification: `npx vitest run src/__tests__/unit/commentFetcher.test.ts` — all 13 pass
- [x] Task 5: Implement `commentPoster.ts` — stubbed `submitReviewBatch` (logs to console in git-style format), real `getLatestCommitSha`
  - Verification: Stubbed poster logs formatted output; `getLatestCommitSha` calls correct gh command
- [x] Task 6: Write `commentPoster.test.ts` — all 10 test cases (batch new, multi-line, replies, mixed, empty, format verification, getLatestCommitSha, body truncation, always-success)
  - Verification: `npx vitest run src/__tests__/unit/commentPoster.test.ts` — all 10 pass

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (188 tests: 159 existing + 6 prDetector + 13 commentFetcher + 10 commentPoster)

---

## Phase 4: Extension-Side Wiring

**Depends on**: Phase 3
**PR scope**: Wire all extension-side modules into `markdownEditorProvider.ts`. Handle all 6 new message types. Implement dirty-file check, session caching, parallel fetch orchestration, error routing, workspace state persistence.

**Files**:
- `src/markdownEditorProvider.ts` (modify)
- `src/__tests__/unit/commentMessageHandler.test.ts` (new)

### Tasks

- [x] Task 1: Create `CommentHandler` class in `src/gh/commentHandler.ts` with cached state fields (prInfo, currentUser, lineMapping, reviewModeActive)
  - Verification: Type-checks
- [x] Task 2: Implement `handleCommentToggle(enabled: true)` — sequential dirty check → gh available → gh authenticated → detectPr → parallel fetchDiff+fetchCurrentUser → fetchComments → send commentData + savedPendingQueue
  - Verification: Type-checks; handler follows the LLD ordering
- [x] Task 3: Implement remaining handlers: toggle OFF, commentRefresh, commentOpenPr, validateLine, submitReview, savePendingQueue
  - Verification: Type-checks; each handler matches LLD spec
- [x] Task 4: Wire CommentHandler into markdownEditorProvider.ts — route 6 comment message types to handler
  - Verification: Type-checks; existing message handling untouched
- [x] Task 5: Implement error handling — catch GhNotFoundError/GhAuthError/GhApiError, classify errors, send correct message type
  - Verification: Type-checks
- [x] Task 6: Write `commentHandler.test.ts` — 21 test cases (happy toggle, dirty uncommitted/unpushed, gh missing/not authed/no PR/file not in diff, saved pending queue, toggle off, refresh, validate mappable/unmappable, submit success/failure, save pending, git log error graceful skip)
  - Verification: `npx vitest run src/__tests__/unit/commentHandler.test.ts` — all 21 pass

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (237 tests)

---

## Phase 5: Webview State — Pending Store + Comment Toggle

**Depends on**: Phase 3 (for types only; no runtime dependency on Phase 4)
**PR scope**: Pending comment store with persistence bridge, toolbar buttons (review toggle, refresh, submit review, staleness indicator). Can be built in parallel with Phase 4.

**Files**:
- `src/webview/pendingCommentStore.ts` (new)
- `src/webview/commentToggle.ts` (new)
- `src/__tests__/unit/pendingCommentStore.test.ts` (new)
- `src/__tests__/unit/commentToggle.test.ts` (new)

### Tasks

- [x] Task 1: Implement `pendingCommentStore.ts` — add, remove, get, getAll, getCount, clear, clearSuccessful, hydrate, onChange, private persist() bridge
  - Verification: Type-checks
- [x] Task 2: Write `pendingCommentStore.test.ts` — all 13 test cases (add, remove, remove non-existent, clear, clearSuccessful variants, hydrate, hydrate-then-add, unsubscribe, getAll copy, get found/not-found)
  - Verification: `npx vitest run src/__tests__/unit/pendingCommentStore.test.ts` — all 13 pass
- [x] Task 3: Implement `commentToggle.ts` — Review toggle (OFF/ON/loading/error), Refresh, Submit Review (count, confirmation, double-submit prevention, success/error), staleness indicator (60s interval, 1h TTL)
  - Verification: Type-checks; DOM elements created with correct classes
- [x] Task 4: Write `commentToggle.test.ts` — 15 test cases: DOM creation, toggle on/off, commentData handling, editor read-only, refresh, submit flow, success/error, staleness, dispose
  - Verification: `npx vitest run src/__tests__/unit/commentToggle.test.ts` — all 15 pass

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (237 tests)

---

## Phase 6: Webview Decorations + Comment Panel

**Depends on**: Phase 3 (for types only; no runtime dependency on Phase 4)
**PR scope**: ProseMirror plugin for diff highlights, comment badges, "+" hover button, text selection button. Floating comment panel with thread display, reply input, queue button. Can be built in parallel with Phases 4 and 5.

**Files**:
- `src/webview/commentIndicator.ts` (new)
- `src/webview/commentPanel.ts` (new)
- `src/__tests__/unit/commentIndicator.test.ts` (new)
- `src/__tests__/unit/commentPanel.test.ts` (new)

### Tasks

- [x] Task 1: Implement comment indicator ProseMirror plugin — plugin state (reviewMode, diffHighlightLines, threads, pendingComments, lineMap), custom transaction metadata key for state updates
  - Verification: Type-checks; plugin creates DecorationSet.empty when reviewMode is false
- [x] Task 2: Implement diff highlight decorations — node decorations with `.diff-highlight` class using lineMap for position lookup (1-indexed → 0-indexed conversion)
  - Verification: Type-checks; decoration count matches mapped diffHighlightLines
- [x] Task 3: Implement comment highlight decorations + badge widget decorations — `.comment-highlight` / `.comment-highlight-pending` classes, badge with combined count (e.g. "2+1"), `comment-badge-click` event
  - Verification: Type-checks; badge shows correct count; click emits event
- [x] Task 4: "+" hover button deferred to Phase 7 CSS (pseudo-element on `.diff-highlight`)
- [x] Task 5: Text selection comment button deferred to Phase 7 wiring (needs editor integration)
- [x] Task 6: Write `commentIndicator.test.ts` — 10 test cases: empty when OFF/null lineMap, diff highlights, comment highlights, badge counts, combined counts, pending-only, badge click event, unmapped lines
  - Verification: `npx vitest run src/__tests__/unit/commentIndicator.test.ts` — all 10 pass
- [x] Task 7: Implement `commentPanel.ts` — openThread, openNew, close, refresh, positioning, queue button (validateLine + add to store), discard button, Escape/click-outside close, relative time formatting
  - Verification: Type-checks; panel DOM matches LLD layout
- [x] Task 8: Write `commentPanel.test.ts` — 18 test cases: open/close lifecycle, one-at-a-time, queue adds pending, discard removes, Escape close with textarea guard, refresh preserves text, relative time formatting
  - Verification: `npx vitest run src/__tests__/unit/commentPanel.test.ts` — all 18 pass

### Phase verification

- [x] All tasks above complete
- [x] `npm run check-types` passes
- [x] `npm test` passes (265 tests)

---

## Phase 7: Webview Integration + CSS

**Depends on**: Phase 4, Phase 5, Phase 6
**PR scope**: Wire all webview components together in `index.ts`. Add all CSS styles. This is where the feature becomes functional in the webview — every component is connected and messages flow end-to-end.

**Files**:
- `src/webview/index.ts` (modify)
- `src/webview/styles.css` (modify)

### Tasks

- [ ] Task 1: Initialise comment components in `index.ts` — create PendingCommentStore, CommentToggle, CommentPanel instances; register commentIndicator plugin on the editor
  - Verification: Type-checks; no runtime errors on webview load (F5 smoke test)
- [ ] Task 2: Add message routing in the `window.addEventListener('message', ...)` callback — route commentData, reviewSubmitResult, commentError, lineMappingResult, savedPendingQueue to the correct components
  - Verification: Each message type reaches the correct handler (verify with console.log during F5 test)
- [ ] Task 3: Wire DOM events — `comment-badge-click` opens comment panel for that thread; `comment-new-click` opens new-comment panel for that line
  - Verification: Clicking a badge opens the panel (F5 test)
- [ ] Task 4: Add all CSS styles using `--vscode-*` design tokens — diff-highlight, comment-highlight, comment-highlight-pending, comment-badge, comment-panel (all sub-elements), review-toggle, review-submit, review-refresh, review-staleness, loading/success/error states, "+" hover button pseudo-element
  - Verification: `npm run build` succeeds; styles present in `dist/webview.css`
- [ ] Task 5: Verify theme integration — test with VS Code light, dark, and high-contrast themes
  - Verification: F5 test in all three themes; all elements legible and correctly themed

### Phase verification

- [ ] All tasks above complete
- [ ] `npm run build` succeeds
- [ ] `npm run check-types` passes
- [ ] `npm test` passes (all tests)
- [ ] F5 smoke test: webview loads without errors, Review button visible

---

## Phase 8: End-to-End Verification (Stubbed Posting)

**Depends on**: Phase 7
**PR scope**: No new code. Full end-to-end testing in the Extension Development Host against a real GitHub PR. Stubbed posting logs to the output channel. This phase validates that all reads work with real data and the UI renders correctly.

**Files**: None (testing only)

### Tasks

- [ ] Task 1: Test toggle ON against a real PR — verify: button updates to "Review: ON PR #N", diff highlights appear on correct lines, real comments load, editor becomes read-only, staleness shows "just now"
  - Verification: Visual confirmation in Extension Development Host
- [ ] Task 2: Test comment creation — "+" hover button on highlighted lines, text selection floating button, panel opens anchored correctly, Queue adds to pending, badge updates
  - Verification: Pending comment visible in panel with dashed border
- [ ] Task 3: Test multi-line comment — select across multiple highlighted lines, floating button appears, panel header shows "lines N-M"
  - Verification: Multi-line header correct
- [ ] Task 4: Test Submit Review (stubbed) — queue 2 new + 1 reply, submit, confirm, check output channel log format matches spec
  - Verification: Output channel shows correct git-style format; pending cleared; auto-refresh
- [ ] Task 5: Test error states — dirty file, no PR, gh missing/not authed, file not in diff
  - Verification: Each error shows correct message; toggle stays OFF
- [ ] Task 6: Test pending queue persistence — queue comments, reload VS Code window, toggle ON, verify pending restored
  - Verification: Submit Review count matches pre-reload count
- [ ] Task 7: Test toggle OFF — all highlights removed, panel closed, editor editable, toolbar reverted, pending preserved in workspaceState
  - Verification: Editor fully functional after toggle OFF
- [ ] Task 8: Test refresh — wait 2 min, check staleness indicator, click Refresh, verify data updates
  - Verification: Staleness resets; new comments appear if added on GitHub
- [ ] Task 9: Visual polish — spacing, transitions, theme integration (light/dark/high-contrast)
  - Verification: No visual regressions; all themes look correct
- [ ] Task 10: Run full test suite
  - Verification: `npm test` passes with zero failures

### Phase verification

- [ ] All tasks above complete
- [ ] Full test suite passes: `npm test`
- [ ] Feature works end-to-end with real PR data (stubbed posting only)

---

## Phase 9: Real Posting + Final Integration

**Depends on**: Phase 8
**PR scope**: Swap the stubbed poster for real GitHub API calls. Final end-to-end testing with real comment posting to GitHub.

**Files**:
- `src/gh/commentPoster.ts` (modify — replace stubbed logic with real API calls)
- `src/__tests__/unit/commentPoster.test.ts` (modify — add real-mode test cases)

### Tasks

- [ ] Task 1: Implement real `submitReviewBatch` — build Review API request body (event: COMMENT, body: "", commit_id, comments array with path/line/side/body/start_line/start_side), pipe JSON to `gh api --input -`; post replies individually with in_reply_to
  - Verification: Type-checks; request body matches GitHub API specification
- [ ] Task 2: Implement partial failure handling — if batch succeeds but some replies fail, return failedReplyIds with the failed tempIds
  - Verification: Unit test with mock where first reply succeeds, second fails
- [ ] Task 3: Update `commentPoster.test.ts` — add test cases for real posting mode (verify request body shape, verify reply API call shape, verify partial failure returns correct IDs)
  - Verification: `npx vitest run src/__tests__/unit/commentPoster.test.ts` — all pass
- [ ] Task 4: E2E test: queue 1 new comment, submit, verify it appears on GitHub PR page
  - Verification: Comment visible on GitHub at the correct diff line
- [ ] Task 5: E2E test: queue 1 new + 1 reply, submit, verify both appear on GitHub
  - Verification: New comment at correct line; reply in correct thread
- [ ] Task 6: E2E test: queue multi-line comment, submit, verify line range on GitHub
  - Verification: GitHub shows the comment spanning the correct line range
- [ ] Task 7: E2E test: partial failure — reply to a deleted thread, verify failed reply stays pending
  - Verification: ReviewSubmitResult has failedReplyIds; failed reply still in pending queue
- [ ] Task 8: E2E test: stale SHA — push a commit without refreshing, submit, verify auto-refresh and retry
  - Verification: Comment posted after automatic re-validation
- [ ] Task 9: Run full test suite one final time
  - Verification: `npm test` passes with zero failures
- [ ] Task 10: Clean up any remaining TODO comments or debug logging
  - Verification: `grep -r "TODO\|console.log\|FIXME" src/gh/ src/webview/commentPanel.ts src/webview/commentIndicator.ts src/webview/commentToggle.ts src/webview/pendingCommentStore.ts` returns nothing unexpected

### Phase verification

- [ ] All tasks above complete
- [ ] `npm test` passes
- [ ] `npm run build` succeeds
- [ ] Real comments posted to GitHub via the extension
- [ ] Batch + replies verified on GitHub
- [ ] Multi-line comment range verified on GitHub
- [ ] No regressions in existing functionality

---

# Progress Tracker

## Summary

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Line Mapping Prototype | [x] | Done — 100% accuracy via markdown-it token source maps |
| Phase 1: Foundation (types + protocol + ghCli) | [x] | 145 tests passing |
| Phase 2: Diff Line Mapper | [x] | 159 tests passing |
| Phase 3: GitHub Data Layer (PR + comments + stubbed poster) | [x] | 188 tests passing |
| Phase 4: Extension Wiring | [x] | 237 tests passing |
| Phase 5: Webview State (pending store + toggle) | [x] | 237 tests passing |
| Phase 6: Webview Decorations + Panel | [x] | 265 tests passing |
| Phase 7: Webview Integration + CSS | [ ] | Needs 4, 5, 6 |
| Phase 8: E2E Verification (stubbed) | [ ] | Testing only |
| Phase 9: Real Posting + Final Integration | [ ] | Ship it |

## Parallel Work Windows

- **After Phase 3 completes**: Phases 4, 5, and 6 can all be worked in parallel
- **Phase 7** is the merge point — requires all three parallel phases

## Completion Criteria

- [ ] All 10 phases marked complete
- [ ] All phase verifications pass
- [ ] `npm test` passes with all existing + new tests
- [ ] `npm run build` succeeds
- [ ] End-to-end: toggle ON → view comments → create comment → queue → submit → verify on GitHub
- [ ] Error handling: all 6 categories verified in Extension Development Host
- [ ] Theme integration: light, dark, high-contrast all render correctly
- [ ] Pending queue persistence: survives VS Code reload

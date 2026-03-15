Agent Team Consolidated Summary - PR Comments Feature

# Team Consensus (Pre-Discussion)

Four analysts (UX, GitHub Parity, Error & Recovery, Devil's Advocate) independently reviewed the PR comments spec across three rounds (draft, debate, refine). The debate produced significant convergence. This summary captures agreed simplifications, unresolved tensions, and blind spots.

# Agreed Simplifications (All 4 Analysts)

## 1. Cut the batch/immediate toggle - pick one mode for v1

The toggle doubles the UI surface, testing matrix, and error surface. Three analysts recommend **immediate-only** (no pending queue, no Submit Review button, no `pendingCommentStore.ts`). One analyst (github-parity) prefers keeping both modes but agrees the toggle must go.

**Impact**: Eliminates `pendingCommentStore.ts`, batch toggle logic, sections 4.1-4.6 of ERROR-HANDLING.md, partial failure handling, and the "Queue" vs "Post" button distinction.

## 2. Cut conflict detection entirely

GitHub does not do client-side conflict detection. The current copy-discard-refresh-re-add flow has data loss risk (clipboard fragility) and is more disruptive than the problem it solves. All analysts agree: just post the comment. Chronological ordering handles the rest.

**Impact**: Eliminates conflict detection in `commentFetcher.ts` and `commentPoster.ts`, the `CommentConflict` message type, and the Copy+Discard UI.

## 3. Cut multi-line comment ranges for v1

Multi-line ranges require mapping both start and end lines through the diff, validating both, and handling partial mapping failures. Single-line anchoring covers the vast majority of review comments.

**Impact**: Simplifies `diffLineMapper.ts`, removes `start_line`/`start_side` API parameters, removes multi-line panel headers.

## 4. Cut pending comment editing for v1

Discard and re-add is sufficient for unposted text. Removes a UI state for trivial benefit.

## 5. Add a staleness indicator

All four analysts independently converged on this. Show "Last refreshed N minutes ago" near the Review toggle. Check age on user actions (open panel, start typing). Low cost, high value.

## 6. Collapse error handling from 20+ cases to 6 categories

Organised by the recoverable/terminal distinction:

| Category | Type | User action |
|----------|------|-------------|
| gh not available | Terminal | Install gh, retry toggle |
| Not authenticated / token expired | Terminal | Run `gh auth login`, retry |
| No PR / PR closed | Terminal | Nothing to do |
| Line unmappable | Terminal (this comment) | Try a different line |
| Post failed, recoverable | Recoverable | Retry (with re-validation) |
| Post failed, terminal | Terminal | Copy text, go to GitHub |

## 7. Keep outdated detection (near-zero cost)

The REST API's `line` field being null already indicates outdated status - no extra call needed. Use `line === null && original_line !== null` as the heuristic.

# Unresolved Tensions (Project Owner Decision Required)

## 1. Resolved thread indicators

- **For** (ux-analyst, github-parity): Prevents wasted replies to settled threads. One GraphQL query is cheap.
- **Against** (devil-advocate): GraphQL adds a dependency, error handling complexity, and the cost of an accidental reply to a resolved thread is low.
- **Middle ground** (error-analyst): Keep, but fall back to "all unresolved" if GraphQL fails.

**Decision needed**: Is one extra network round-trip per fetch worth preventing occasional replies to resolved threads?

## 2. Comment creation affordance

- **ux-analyst**: Strongly advocates a "+" gutter button (most discoverable).
- **devil-advocate**: Adds implementation complexity; context menu + tooltip may suffice for v1.
- **github-parity**: Selection-only diverges from GitHub's line-click model.

**Decision needed**: Build a "+" gutter button (higher effort, better UX) or keep selection-only with prominent context menu entry (lower effort, less discoverable)?

## 3. Immediate-only vs batch-only

Both are valid single-mode choices:
- **Immediate-only**: Simplest (no pending state, no Submit Review). Best for "read comments, leave a quick reply" workflow. Downside: N comments = N notifications.
- **Batch-only**: Safer (review all before submit, one notification). Best for thorough reviews. Downside: single reply requires 4 actions.

Three analysts lean immediate-only for v1 (matching markdown review usage patterns). The choice depends on expected usage.

# Blind Spots (Investigate Before Building)

## 1. WYSIWYG-to-markdown line mapping accuracy

The mapping from TipTap block nodes to markdown lines is described as "approximate" in the spec. Tables, nested lists, and code blocks can span many markdown lines while appearing as a single block node. This mapping is the foundation of the entire feature.

**Action**: Prototype the line mapping with representative markdown files and validate accuracy before building. If below ~90% accurate, the feature may not be viable.

## 2. Performance - cumulative gh CLI latency

Toggle-on requires ~5 sequential CLI calls (auth, PR detection, comments, diff, user). At 1-2 seconds each, that's 5-10 seconds. Parallelise independent calls and set explicit performance targets.

## 3. File editing while Review mode is on

When the user edits the file, lines shift. Comment indicators anchored to block nodes stay in place, but the underlying markdown line numbers change. The spec accepts this drift silently. Either disable editing in Review mode, rebuild mappings on change, or document as a known limitation.

# Additional Recommendations from Debate

- **Add token expiry detection mid-session** - Map 401/403 to specific re-auth message (error-analyst)
- **Add GraphQL error handling** - Graceful degradation if resolved-thread query fails (error-analyst, github-parity)
- **Remove `subject_type` mention** from resolved-thread detection - it indicates line vs file, not resolution (github-parity)
- **Define retry semantics** - Retry must re-validate commit SHA and line mapping, not just resend (error-analyst)
- **Add double-submit prevention** - Disable Post button on click until result arrives (error-analyst)
- **Rename "Retry" to "Retry (may duplicate)"** on network errors - Honest labelling (error-analyst)
- **File-not-in-diff**: Show notification with link to PR page if comments exist, rather than blocking entirely (github-parity)
- **Fetch diff fresh** on every toggle-on and Refresh, no caching (devil-advocate)
- **Empty review body**: Add a summary text input before Submit Review if batch mode is retained (github-parity)
- **Parallelise gh CLI calls** on toggle-on to reduce load time (devil-advocate)

# Updated MVP (Post-Debate Consensus)

1. Toggle on/off - detect PR via gh CLI
2. View comments - fetch, display in right-margin panels, one at a time, with outdated label
3. Reply to threads - text input, post immediately with confirmation
4. Create new comments - select text (or "+" button TBD), post immediately, single-line anchoring
5. Manual refresh with staleness indicator
6. 6 error categories with recoverable/terminal distinction

**Estimated scope reduction**: ~50% fewer files, ~60% fewer error cases, ~70% fewer UI states compared to the original spec.

# Individual Analyses

- [UX Analysis](ux-analysis.md)
- [GitHub Parity Analysis](github-parity-analysis.md)
- [Error & Recovery Analysis](error-recovery-analysis.md)
- [Devil's Advocate Analysis](devils-advocate-analysis.md)

# Final Decisions (Post-Discussion)

These are the authoritative decisions made after reviewing the team's analysis with the project owner. Where they conflict with the pre-discussion consensus above, these take precedence.

## Posting Mode

- **Batch-only**. No toggle, no immediate mode. All comments are staged in a pending queue and posted together via Submit Review.
- The pre-discussion team lean toward immediate-only is overruled.

## Conflict Detection

- **Cut entirely**. Confirmed - not built.

## Multi-Line Comments

- **Kept in v1**. Diff highlighting guarantees a valid line mapping for both start and end, so the implementation risk identified in the pre-discussion analysis does not apply. The `start_line`/`start_side` API parameters are included.

## Pending Comment Editing

- **Cut**. Discard and re-add is the only supported workflow for unposted comments.

## Staleness Indicator

- **Added**. Show "Last refreshed N min ago" near the Review toggle. Confirmed as agreed.

## Error Handling

- **Collapsed to 6 categories** (recoverable/terminal) as specified in the pre-discussion consensus. Confirmed.

## Outdated Detection

- **Kept**. Near-zero cost via `line === null && original_line !== null`. Confirmed.

## Resolved Thread Indicators

- **Cut for v1**. The GraphQL dependency is not worth it at this stage.

## Comment Creation Affordance

- **Both** "+" hover button on highlighted lines AND text selection. No keyboard shortcut for comment creation at all.

## Diff Line Highlighting

- Green background on added/modified lines when Review mode is ON.
- Added lines only - context lines are not commentable, deleted lines are skipped.

## Review Mode is Read-Only

- File editing is **disabled** while the Review toggle is ON. This resolves the line-drift blind spot without rebuilding mappings on change.

## Dirty Files Block Review Mode

- Uncommitted or unpushed changes **block** the toggle with an error. The user must commit/push before entering Review mode.

## Line Mapping

- **Prototype accuracy first** before building the full feature. Validate against representative markdown files (tables, nested lists, code blocks). Proceed only if accuracy is satisfactory.

## Parallelising gh CLI Calls

- `gh auth` and PR detection run **sequentially** (each depends on the previous).
- Once PR is confirmed: comments, diff, and user info are fetched **in parallel**.

## Cache Strategy

- PR info and user info: **cached per session**.
- Comments and diff: **fetched fresh** on every Refresh action.
- All PR comments are fetched but **filtered to the current file** in-memory.
- Cache **persists across tab switches**.
- Cache is cleared on: toggle OFF, file close, window close, 1-hour TTL.

## Token Expiry Detection

- **Map 401/403 mid-session** to a specific re-auth message (not a generic network error).

## Retry Semantics

- Retry **re-validates everything**: commit SHA and line mapping are re-checked before resending. Not a blind resend.

## Double-Submit Prevention

- Post/Submit button is **disabled on click** until a result (success or error) is returned.

## Retry Label

- Label stays as **"Retry"** (not "Retry (may duplicate)"). The duplicate risk is documented in `limitations.md` rather than surfaced in the UI.

## File Not in Diff

- Toggle stays **OFF with an error**. No partial fallback or link to PR page.

## Review Body

- **No summary text input**. The review is submitted with an empty body - pure inline comments only.

## Decisions Superseding Pre-Discussion Recommendations

| Topic | Pre-Discussion | Final Decision |
|-------|---------------|----------------|
| Posting mode | Immediate-only (3 of 4 analysts) | Batch-only |
| Multi-line comments | Cut for v1 | Kept in v1 |
| Retry label | "Retry (may duplicate)" | "Retry" |
| File-not-in-diff | Show notification with link | Toggle stays OFF with error |
| Empty review body | Add summary text input | Empty body, no summary |
| Resolved thread indicators | Keep with GraphQL fallback | Cut for v1 |

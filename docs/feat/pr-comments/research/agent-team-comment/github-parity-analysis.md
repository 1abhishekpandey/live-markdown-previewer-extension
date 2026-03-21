GitHub Parity Analysis - PR Comments Feature

# Executive Summary

The spec achieves strong parity with GitHub's PR review model for a V1 scope. The batch/immediate split correctly mirrors GitHub's "Start a review" vs "Add single comment" distinction. However, there are several behavioural divergences and expectation gaps that users familiar with GitHub will notice.

This analysis is framed around user mental models, not feature checklists. The goal is not to replicate GitHub's UI — LiveMarkdown is a WYSIWYG editor, a fundamentally different context from GitHub's diff-based review view. Instead, this analysis identifies where the spec creates expectations (through terminology, UI patterns, or workflows) that it then violates relative to GitHub's behaviour. Where the spec diverges from GitHub, the divergence should be intentional and visible, not accidental.

# Feature Parity Assessment

## Well-Matched Features

**1. Batch vs Immediate Review Model**
GitHub has two posting modes: "Start a review" (pending comments batched, single notification) and "Add single comment" (posted immediately). The spec's Batch ON/OFF toggle maps directly to this. The use of `event: "COMMENT"` for batch submission is correct — this is how GitHub creates a non-approving review. The single-notification benefit is accurately described.

**2. Thread Structure**
GitHub groups review comments via `in_reply_to_id`. The spec correctly uses this for thread grouping and correctly identifies that the Reviews API `comments` array does not support `in_reply_to` — replies must be posted individually. This is a real GitHub API limitation that the spec handles correctly.

**3. Multi-line Comments**
GitHub supports multi-line review comments via `start_line` + `line` (and `start_side` + `side`). The spec accounts for this with `diffStartLine` / `diffLine` mapping. One note: the spec mentions `side: "RIGHT"` but does not mention `start_side`. For multi-line comments, GitHub requires both `side` and `start_side` to be set.

**4. Outdated Comments**
GitHub marks comments as "outdated" when the code they reference has been modified by a subsequent push. The spec's detection heuristic (`position` is null or `original_line !== line`) is a reasonable approximation, though not perfectly accurate (see divergences below).

**5. Resolved Threads**
GitHub allows marking review threads as "resolved". The spec correctly identifies that this requires the GraphQL API (`reviewThreads.isResolved`) since the REST API does not expose resolution status directly on individual comments. Good technical choice.

**6. Commit SHA Requirement**
The Reviews API requires `commit_id`. The spec correctly fetches the latest commit SHA before submission and handles the stale-SHA error case (422).

## Behavioural Divergences

**1. Outdated Detection is Approximate**
On GitHub, "outdated" means the diff position where the comment was placed no longer exists in the latest diff — typically because a new commit changed the lines the comment references. GitHub tracks this internally through diff positions across commits. The spec's heuristic (`position` is null or `original_line !== line`) is a simplification:
- `position` being null means the comment can no longer be mapped to the current diff at all — this is more like "can't display" than "outdated"
- `original_line !== line` can happen for reasons other than the code changing (e.g., lines shifted due to changes elsewhere in the file)
- The REST API actually has a `line` field (current diff line) and `original_line` (line when comment was created). If `line` is null but `original_line` is set, the comment is outdated. If both are set and differ, the comment was repositioned but not necessarily outdated.

**Recommendation**: Use `line` being null (while `original_line` is set) as the primary outdated indicator. When `line` is set, the comment is still current, even if the line number shifted.

**2. Conflict Detection Model Differs from GitHub**
GitHub does not do client-side conflict detection for comments. You can always post a reply to a thread regardless of whether new comments appeared. The spec introduces a "conflict detection" mechanism (re-fetch thread, compare counts, force discard) that has no GitHub equivalent. This is a custom safeguard.

While arguably useful, the UX is aggressive: forcing users to copy their text, discard, refresh, and re-add manually is more friction than GitHub itself imposes. GitHub simply appends your reply to the thread — even if new comments appeared while you were typing.

**Recommendation**: Replace the forced-discard flow with an in-context preview. On detecting new replies, inject them into the thread panel with a "New since your last refresh" divider, keeping the user's draft in the reply box. The user can read the new comments and make an informed decision: post if their comment is still relevant, or cancel if it's redundant. This avoids both the social problem of posting nonsensical replies and the UX friction of copy-discard-refresh-re-add. If conflict detection is kept, use ID-based watermarking (last known comment ID per thread) rather than the spec's count-based comparison, which misses delete+add scenarios.

**3. "File Not in PR Diff" Blocks the Entire Feature**
On GitHub, you can view comments on any file in a PR — including files that were part of an earlier revision but are no longer in the current diff. The spec blocks Review mode entirely for files not in the current diff (error 1.6). This means comments that exist on GitHub for this file would be invisible in the extension.

**Recommendation**: If the file is not in the diff but has existing comments on GitHub, show a VS Code notification: "This file has N comments on PR #123 — view them on the PR page" with a clickable link. Do not attempt to render comments inline without a line mapping, as there is no diff to anchor them to and approximate positioning would be misleading. If no existing comments are found, keep the current behaviour (toggle stays OFF with tooltip). This is simpler than building a separate non-inline comment list UI for V1.

**4. Single Panel Open at a Time**
GitHub allows multiple comment threads to be expanded simultaneously. The spec restricts to one panel at a time. This is a deliberate UX simplification but diverges from GitHub's behaviour. Users reviewing a file with many comments may find this limiting.

**5. No "Add single comment" vs "Start a review" Semantic Distinction**
On GitHub, when you add a single comment (not as part of a review), it is immediately visible to all participants. When you start a review, pending comments are only visible to you until you submit. The spec's Batch OFF mode posts immediately (matching "add single comment"), and Batch ON queues locally (matching "start a review"). However, on GitHub, once you start a review, ALL subsequent comments are part of that review until you submit — there's no per-comment choice. The spec allows mixing pending and immediate by toggling Batch on/off mid-session, which is not how GitHub works.

**Recommendation**: Document this divergence. It's arguably an improvement, but users may be confused if they expect GitHub's "once you start a review, you're in review mode" behaviour.

## Terminology Parity

| GitHub Term | Spec Term | Match? | Notes |
|---|---|---|---|
| Start a review | Batch: ON | Partial | GitHub doesn't call it "batch" — it's "pending review" |
| Add single comment | Batch: OFF / Post | Partial | GitHub calls this "Add single comment" |
| Pending | Pending | Yes | Correct term |
| Outdated | Outdated | Yes | Correct term |
| Resolved | Resolved | Yes | Correct term |
| Submit review | Submit Review | Yes | Correct term |
| Review comment | Comment | Yes | Acceptable |
| COMMENT event | COMMENT event | Yes | Correct API value |
| Approve / Request changes | N/A (out of scope) | N/A | Documented as future scope |

**Notable terminology gap**: GitHub's UI uses "Start a review" as a clear call-to-action. The spec's "Batch: ON/OFF" toggle is more abstract and doesn't convey the review semantics as clearly. A user familiar with GitHub might not immediately understand that "Batch: ON" means "I'm starting a review".

## Expectation Gaps

These are places where the spec creates expectations it does not fulfil, or where GitHub users will encounter surprising behaviour. They are grouped by impact type, not by a feature-completeness checklist.

### Gaps that affect the in-extension experience

**1. Suggestion Blocks Display as Raw Text**
GitHub supports ` ```suggestion ` syntax that renders as an applicable diff. The spec preserves suggestion syntax as-is (text preservation), but the panel renders plain text. Users who write or encounter suggestion blocks will see raw triple-backtick fences. This is a readability problem, not just a missing feature. Even minimal visual treatment (monospace block with a "Suggestion" label) would help.
Severity: Medium-high — plan for early follow-up.

**2. Markdown Rendering in Comments**
PR comments routinely contain inline code, bold, links, and code blocks. Plain text display makes these harder to read than they need to be. This is correctly scoped out for V1 (implementing a second markdown renderer in the panel is non-trivial), but should be on the roadmap.
Severity: Medium — V2 priority.

**3. Edit/Delete Posted Comments**
The spec creates comments but does not allow managing them. Users will expect symmetry. Consider showing an "Edit on GitHub" link on the user's own posted comments that opens the specific comment URL.
Severity: Medium — acceptable for V1 with clear communication.

**4. No Staleness Indicator**
GitHub's UI is perceived as real-time (periodic polling + WebSocket push). The spec's manual-only refresh means the user's view can become arbitrarily stale with no visible signal. A "Last refreshed: 5 min ago" timestamp near the Review toggle would nudge manual refresh without adding background polling.
Severity: Medium — low-effort, high-value addition.

### Gaps that affect how the extension's output appears on GitHub

**5. Review Summary Comment**
The spec sets `body: ""` in the Reviews API call. This creates a review on GitHub with no summary — just orphaned inline comments. Users who look at their review on GitHub will see an empty review body, which looks unfinished. Even a simple text input before "Submit Review" would address this.
Severity: Low-medium — affects GitHub-side perception of the review.

### Features that belong in GitHub's UI (not expectation gaps)

The following GitHub features are correctly excluded from V1 scope. They are not expectation gaps because the extension does not create an expectation of having them:

- **Approve / Request changes** — the spec calls the feature "PR Comments", not "PR Reviews". Comment-only is correctly scoped.
- **Comment reactions (emoji)** — decorative, not workflow-critical.
- **Resolve/unresolve threads** — the spec displays resolved status (read-only), which is sufficient for V1.
- **Review status indicators** — belongs in a PR overview, not a per-file editor.
- **Diff context in comments** — the WYSIWYG editor already shows the content; diff context would be redundant.
- **Filter/sort comments** — useful at scale, but V1 targets single-file review with manageable comment counts.

## GitHub API Considerations

**1. Pagination**
The spec uses `--paginate` for comment fetching, which is correct. GitHub's REST API returns max 100 items per page. The `--paginate` flag in `gh` handles this automatically.

**2. GraphQL for Resolved Status**
The spec correctly identifies that resolved thread status requires GraphQL. The query structure shown fetches `reviewThreads` with `isResolved` — this is the correct approach. However, the query only fetches the first 100 threads (`first:100`). PRs with more than 100 threads would miss some.

**3. Reviews API Comment Limit**
GitHub's Reviews API has an undocumented soft limit on the number of comments in a single review (historically around 50-60). Very large batch submissions may fail. The spec doesn't address this.

**4. `side` Parameter**
The spec mentions `side: "RIGHT"` for new comments, which is correct for comments on added/modified lines. However, for comments on context lines (unchanged lines visible in the diff), GitHub accepts `side: "RIGHT"`. For comments on deleted lines (left side only), you'd need `side: "LEFT"` — but the spec correctly excludes deleted-line comments.

**5. `subject_type` Field**
The spec mentions using `subject_type` from REST to detect resolved threads. The `subject_type` field indicates whether a comment is on a `line` or `file`, not whether it's resolved. Resolution status is only available via GraphQL. The spec's primary approach (GraphQL) is correct, but the REST fallback mention is misleading and should be removed from the spec to avoid confusion.

**6. GraphQL Error Handling**
The resolved-threads GraphQL query returns HTTP 200 with an `errors` array on failure — a completely different shape from REST errors. The error handling spec does not mention GraphQL error parsing at all. If this query fails, the extension should fall back to treating all threads as unresolved (graceful degradation) rather than failing the entire fetch. Resolved status is informational, not critical.

**7. Token Expiry Mid-Session**
The spec checks auth on toggle-on but not during the session. A user could work for 30 minutes, then hit a 401 on their next post or refresh. This would surface as a generic API failure rather than a specific "re-authenticate" message. The spec should map 401/403 responses with "Bad credentials" or "token expired" to: "Your GitHub authentication has expired. Run `gh auth login` to re-authenticate, then Refresh."

## Unnecessary Divergences

**1. Forced Discard on Conflict**
As noted above, GitHub simply lets you post regardless of new comments. Forcing copy-then-discard is unnecessarily restrictive and adds friction that GitHub users won't expect.

**2. "File Not in Diff" Blocks Everything**
GitHub shows comments on files not in the current diff. Blocking the entire feature is overly conservative.

**3. No Direct Comments (Selection Required)**
On GitHub, you can click the "+" button next to any line to comment. You don't need to select text. The spec requires text selection before commenting (Cmd+Shift+C). While this may be a technical limitation of the WYSIWYG editor (no line gutters), it diverges from GitHub's line-click model. Users will look for a way to comment on a line without selecting.

**4. Batch Toggle Default**
The spec defaults Batch to ON. On GitHub, the default first action is "Add single comment" (immediate). Users only enter review mode by explicitly clicking "Start a review". Defaulting to batch may confuse users who expect immediate posting.

# Risk Summary

| Risk | Severity | Notes |
|---|---|---|
| Conflict detection forces discard | Medium | More friction than GitHub; replace with in-context preview |
| Suggestion blocks display as raw text | Medium-high | Readability problem; plan for early follow-up |
| Selection required for new comments | Medium | Diverges from GitHub's line-click model; low discoverability |
| No staleness indicator | Medium | Users don't know their view is stale |
| File-not-in-diff blocks all comments | Medium | Hides existing comments; use notification+link instead |
| No markdown rendering in comments | Medium | V2 priority; plain text is readable but not ideal |
| Batch default ON | Low-medium | Opposite of GitHub's default; may confuse first-time users |
| Empty review body on GitHub | Low-medium | Extension's output looks unfinished on GitHub |
| Outdated detection heuristic | Low | May produce false positives; use `line` being null as indicator |
| GraphQL errors unhandled | Low | Could fail resolved-thread detection silently |

# Recommendations

1. **Replace conflict detection with in-context preview** - On detecting new replies, show them in the panel with a divider and keep the user's draft. Let the user decide whether to post. Use ID-based watermarking, not count-based.
2. **File-not-in-diff: notification + link** - If the file has existing comments but is not in the diff, show a notification with a link to the PR page rather than blocking or attempting inline display without a mapping.
3. **Rename "Batch" toggle** - Use "Review mode" or "Pending review" to match GitHub's terminology and communicate intent.
4. **Default Batch to OFF** - Match GitHub's default of immediate posting; let users opt into review mode.
5. **Add staleness indicator** - Show "Last refreshed: N min ago" near the Review toggle to nudge manual refresh.
6. **Document `start_side` requirement** for multi-line comments in the technical design.
7. **Add review body field** - A text input before "Submit Review" to avoid empty review bodies on GitHub.
8. **Handle GraphQL errors gracefully** - Fall back to "all unresolved" if the resolved-threads query fails.
9. **Handle >100 review threads** in the GraphQL query with pagination.
10. **Remove `subject_type` mention** from resolved-thread detection — it does not indicate resolution status.
11. **Add token expiry detection** - Map 401/403 with "Bad credentials" to a specific re-auth message.

# Changes After Debate

## Reframed analysis from "feature parity" to "expectation gaps" (devil-advocate)
The devil's advocate challenged the premise that GitHub parity is the right benchmark, arguing that LiveMarkdown is a different context (WYSIWYG editor vs diff-based review UI). Valid critique. The analysis now focuses on user mental models — where the spec creates expectations through terminology and UI patterns that it then violates — rather than cataloguing every GitHub feature as "missing". The executive summary was rewritten to reflect this framing.

## Restructured "Missing Features" into three buckets (devil-advocate)
The original "Missing GitHub Features Users Will Expect" section listed 10 features, which the devil's advocate correctly identified as "scope creep dressed as analysis". Restructured into: (a) gaps that affect the in-extension experience, (b) gaps that affect how the extension's output appears on GitHub, and (c) features that belong in GitHub's UI only. Most items moved to bucket (c) with explicit acknowledgement that they should not be built.

## Downgraded markdown rendering from high to medium severity (ux-analyst)
The UX analyst argued that plain text comments are readable and implementing a second renderer is non-trivial engineering. Conceded. Split the recommendation: general markdown rendering = medium (V2), suggestion block visual treatment = medium-high (early follow-up) since suggestion blocks are a workflow gap, not just a polish gap.

## Added staleness indicator as a new gap (ux-analyst)
The UX analyst highlighted that GitHub's perceived real-time updates make the spec's manual-only refresh a significant departure. Added a "Last refreshed" timestamp recommendation as a low-effort, high-value addition that addresses the parity gap without background polling.

## Refined conflict detection to "in-context preview" (error-analyst)
The original recommendation was "make it informational with option to post anyway". The error analyst proposed a better middle ground: show new replies inline in the panel with a divider, keeping the user's draft. This lets the user make an informed decision (post if relevant, cancel if redundant) without the forced discard or the risk of posting nonsensical replies. Also adopted the error analyst's recommendation to use ID-based watermarking instead of count-based detection.

## Revised file-not-in-diff to notification + link (error-analyst, ux-analyst)
The original recommendation was "allow Review mode with existing comments, disable new ones". The error analyst pointed out that without a diff, there is no line mapping, so inline comment anchoring is impossible. The UX analyst noted that a read-only mode without clear explanation would confuse users. Revised to: show a VS Code notification with comment count and a link to the PR page. Simpler, no new UI components, no approximate positioning.

## Added GraphQL error handling, token expiry, and `subject_type` correction (error-analyst)
Three API-level gaps identified during debate: (1) GraphQL errors have a different response shape than REST and need separate handling with graceful degradation, (2) token expiry mid-session surfaces as a generic error instead of a specific re-auth message, (3) the spec's mention of `subject_type` for resolved-thread detection is incorrect — it indicates line vs file, not resolution status.

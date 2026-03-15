Error & Recovery Analysis - PR Comments Feature

# Executive Summary

The error handling spec is thorough but over-specified for V1. It covers 20+ distinct error cases across preconditions, fetching, posting, and batch submission. After debate with the team, the consensus is that the error surface should be reduced by: (1) removing or making conflict detection informational, (2) choosing a single posting mode (immediate-only recommended for V1), and (3) collapsing error cases into 6 categories organised by the recoverable/terminal distinction. This analysis identifies gaps that remain after those simplifications.

# 1. Recommended Error Category Framework

The current spec lists 20+ distinct error cases. Many are variations of "gh CLI call failed" with different wrappers. After debate, the team converged on 6 categories organised by the key UX question — should we show a Retry button?

| Category | Type | Example | User action |
|----------|------|---------|-------------|
| gh not available | Terminal | Not installed, ENOENT | Install gh, retry toggle |
| Not authenticated / token expired | Terminal | 401, "Bad credentials", `gh auth status` fails | Run `gh auth login`, retry toggle |
| No PR / PR closed | Terminal | `gh pr view` fails, state = CLOSED/MERGED | Create PR or accept; nothing to do |
| Line unmappable | Terminal (for this comment) | `validateLineMapping` returns null | Try a different line |
| Post failed, recoverable | Recoverable | Stale SHA (422), network timeout, rate limit | Retry (with re-validation) |
| Post failed, terminal | Terminal | Permission denied (403), PR closed mid-post | No retry; copy text, go to GitHub |

Everything outside these 6 categories should fall through to a generic handler that shows the sanitised gh stderr and logs full details to the output channel.

# 2. Gaps in the Current Spec

## Gap 1: Token expiry mid-session

The spec checks auth on toggle-on (1.2) and handles 403 on fetch (2.3), but there is no handling for token expiry *during* a session. A user could toggle on successfully, work for 30 minutes, and then have their token expire. The next post or refresh would fail with a generic API error (3.2) rather than a specific auth-related message.

**Recommendation**: When any gh API call returns 401 or 403 with "Bad credentials" or "token expired", surface a specific message: "Your GitHub authentication has expired. Run `gh auth login` to re-authenticate, then Refresh." This maps to the "Not authenticated / token expired" category above.

## Gap 2: GraphQL errors for resolved thread detection

The comment fetcher uses a GraphQL query for resolved thread detection (TECHNICAL-DESIGN.md, commentFetcher.ts). GraphQL errors return HTTP 200 with an `errors` array — a completely different shape from REST errors. The error handling spec does not mention GraphQL error parsing at all.

**Critically**, the TECHNICAL-DESIGN.md mentions using `subject_type` from the REST API as a fallback for resolved status. As github-parity identified, `subject_type` indicates whether a comment is on a `line` or `file`, NOT whether it is resolved. The GraphQL query is the sole mechanism for resolved status.

**Recommendation**: If the resolved-threads GraphQL query fails, fall back to treating all threads as unresolved. Show a subtle indicator that resolution status is unavailable. This is graceful degradation — resolved status is informational, not critical.

## Gap 3: Reviews API comment limit

GitHub has an undocumented soft limit of approximately 50-60 comments per single review submission (identified by github-parity). Very large batches may fail with an opaque error.

**Recommendation** (if batch mode is retained): Detect this 422 and show "Your review has too many comments. Try submitting in smaller batches." Alternatively, automatically split large batches into multiple review submissions.

## Gap 4: Double-submit prevention

Nothing prevents the user from clicking "Post" (or "Submit Review") twice quickly. If the first request is in-flight and the second fires, both could succeed, creating duplicate comments.

**Recommendation**: Disable the Post/Submit button immediately on click and keep it disabled until the result arrives. The spec mentions a "loading spinner replacing the button" but this should be explicitly called out as a guard against double-submission.

## Gap 5: gh CLI output parsing failures

Older versions of `gh` may not support `--json` flags, `--paginate`, or specific API endpoints. The error would surface as a confusing JSON parse error.

**Recommendation**: Do not proactively check gh version on toggle-on (this adds onboarding friction, as ux-analyst noted). Instead, if gh output fails to parse (malformed JSON, unexpected format), surface a version-specific hint: "This may be caused by an older gh CLI version. Check with `gh --version` and update if needed."

# 3. Conflict Detection Assessment

**Team consensus: remove or make informational.** Three of four reviewers (error-analyst, github-parity, devil-advocate) agree that the current conflict detection flow — copy text to clipboard, discard comment, refresh, re-add manually — is the biggest UX/error-handling problem in the spec.

Arguments for removal or simplification:

- **GitHub does not do conflict detection.** You can always post a reply regardless of whether new comments appeared. The chronological ordering handles it correctly.
- **The recovery flow risks data loss.** Clipboard-based recovery is fragile: copying something else before pasting loses the text. With multiple conflicts in batch mode, the clipboard gets overwritten between copies.
- **Disproportionate to the risk.** The spec accepts a worse data integrity risk (duplicate comments on network failure, section 3.7) with a shrug. Conflict detection guards against a much less harmful scenario (posting after someone else replied).
- **Count-based detection is technically fragile.** If a comment is deleted and another added, the count stays the same but content has changed. No conflict would be detected.

**Recommendation**: If conflict detection is retained at all, make it informational: show "2 new replies appeared since your last refresh" in the panel and let the user choose to post anyway or refresh first. Never force discard. Never require clipboard-based recovery.

# 4. Duplicate Comment Risk

Section 3.7 acknowledges that network errors mid-post can cause duplicates and offers: "If you see a duplicate comment on GitHub, you can delete it there."

The team debated idempotency checks (fetch thread before retry, check for matching body text). github-parity identified a concrete problem: body-text matching fails for common replies like "+1", and there is a TOCTOU gap between the check and the retry POST.

**Recommendation**: Accept duplicate risk with transparency. Rename "Retry" to "Retry (may duplicate)" with a clear explanation. After a successful retry, auto-trigger a refresh so the user can see if a duplicate appeared. This is honest and avoids unreliable deduplication logic.

# 5. Stale State Analysis

With no background polling, the user's view can become arbitrarily stale. Scenarios:

1. **Colleague resolves a thread**: User still sees it as active and may reply to it.
2. **Colleague deletes a comment**: User still sees it. Confusing after refresh.
3. **New commits pushed to PR**: Line mappings become invalid. User gets stale SHA error (3.4) only when they try to post.
4. **PR closed while user is typing**: User clicks Post, gets "PR has been closed" error (3.3).

**Recommendation**: Show a staleness indicator. On each user action (open panel, start typing), check the age of the last fetch. If older than 5 minutes, show a subtle "Last refreshed 12 minutes ago" label. This nudges the user to refresh without adding automatic polling. All four team members converged on this recommendation independently.

# 6. Retry Semantics

The spec is unclear on what "Retry" does. Does it re-validate line mapping? Re-fetch commit SHA? Or just re-send the same request?

**Recommendation**: Document retry semantics explicitly:
- **Retry after post failure**: Re-fetches commit SHA, re-validates line mapping, then posts. This prevents stale retries.
- If retry is "just resend the same request," it will fail again with the same stale data. Full re-validation is the correct approach.

This is a documentation requirement, not additional code — the retry handler should call the same code path as a fresh post.

# 7. Degraded Mode (Diff Fetch Failure)

When the diff fetch fails (ERROR-HANDLING.md, section 2.4):
- New comments are disabled (correct — can't validate line mapping)
- Existing comments shown at "approximate positions" using `original_line`

But the spec does not define:
- How approximate is "approximate"? If the file has been heavily modified, `original_line` could point to completely wrong content.
- Is there a visual indicator that positions are approximate?
- Can the user reply to existing comments in this mode?

**Recommendation**: In degraded mode:
1. Show a persistent banner: "Diff unavailable — comment positions may be inaccurate. New comments disabled."
2. Allow replies to existing threads (replies use `in_reply_to` and do not need line mapping).
3. Mark approximate positions visually (e.g., "~Line 42" instead of "Line 42").

# 8. Error Message Quality

## Strengths
- Messages generally follow "what happened + what to do" format
- PR numbers are included where relevant
- gh CLI stderr is sanitised (paths/tokens stripped)
- Raw stack traces are never shown to users

## Improvements needed
- 2.1 "Try again in a few minutes" — rate limit headers include a reset timestamp. Show: "Rate limit resets at HH:MM" or "Try again after N minutes."
- 3.1 "The file may have changed significantly" — too vague. Better: "This line is not part of the PR diff. Only lines added or modified in the PR can receive comments."
- 5.3 "Try again or check gh version" — show the actual version requirement if known.

# 9. gh CLI Edge Cases

- **Timeout handling**: Default 30s, large diffs 60s. No user-facing message explaining why the operation is slow during the wait.
- **Output encoding**: If gh CLI outputs non-UTF-8 characters (emoji in comment bodies), JSON parsing could fail silently. Handle JSON parse errors gracefully with a version hint (see Gap 5).
- **gh not on PATH**: Section 1.1 detects ENOENT, but on some systems gh is in non-standard paths. Error message should suggest checking PATH.

# 10. Impact of Posting Mode Choice on Error Surface

If the spec adopts immediate-only posting (as devil-advocate recommends and the team leans towards):

**Eliminated entirely:**
- Sections 4.1-4.6 of ERROR-HANDLING.md (all batch submit errors)
- Partial failure handling (Reviews API + individual replies split)
- pendingCommentStore and all its edge cases (webview reload, mode switching with pending comments)
- Batch-level conflict detection
- Gap 3 above (Reviews API comment limit)

**Remaining error surface** maps cleanly to the 6-category framework in section 1 — a dramatic simplification.

If batch mode is retained, sections 4.1-4.6 and Gap 3 remain relevant but should be specified with the same recoverable/terminal distinction.

# Summary of Recommendations (Revised Priority Order)

1. **High — Remove or simplify conflict detection**: Make informational ("N new replies appeared"), never force discard. Or remove entirely — GitHub does not do this.
2. **High — Add token expiry detection**: Surface specific re-auth messages on 401/expired token mid-session. Low implementation cost, high user value.
3. **High — Add GraphQL error handling**: Graceful degradation for resolved-thread query failure (sole mechanism for resolved status).
4. **Medium — Define retry semantics explicitly**: Document that retry performs full re-validation (SHA, line mapping). This is documentation, not code.
5. **Medium — Improve degraded mode (diff failure)**: Allow replies, mark approximate positions visually, show persistent banner.
6. **Medium — Add staleness indicator**: Show "last refreshed N minutes ago" on user actions. Trivial to implement, all team members agree.
7. **Low — Add double-submit prevention**: Disable Post/Submit button on click until result arrives.
8. **Low — Handle gh output parse failures reactively**: Show version hint on malformed JSON rather than proactive version gating.

# Changes After Debate

This section documents revisions made after Round 2 debate with ux-analyst, github-parity, and devil-advocate.

## Removed recommendations

- **Idempotency check before retry** (was #2): Removed after github-parity demonstrated a race condition and false-positive risk ("+1" comments would match incorrectly). Replaced with transparent "Retry (may duplicate)" labelling.
- **ID-based conflict detection watermarking** (was #5): Removed because the team consensus is to remove or simplify conflict detection entirely, making the detection mechanism moot.
- **Stashed state for conflicted comments** (was #1): Removed as part of the broader consensus to eliminate the forced-discard conflict flow. If conflict detection becomes informational, there is nothing to "stash."
- **Batch partial submission on conflict** (was #3): Removed — depends on conflict detection being a blocking mechanism.
- **Error codes** (was #10): Removed after ux-analyst and github-parity both noted this is disproportionate for a personal project. Descriptive messages with output channel logging are sufficient.

## Revised recommendations

- **gh version check** (was #8, proactive gating): Revised to reactive approach after ux-analyst pointed out that proactive version checking adds onboarding friction. Now: surface a version hint only when gh output fails to parse.

## Added recommendations

- **Reviews API comment limit** (~50-60 comments per review): Added after github-parity identified this undocumented GitHub limitation. Relevant only if batch mode is retained.
- **GraphQL error handling elevated to High priority**: After github-parity confirmed that `subject_type` does NOT indicate resolved status, the GraphQL query is the sole mechanism. Its failure mode must be specified.
- **Double-submit prevention**: Extracted from the original Gap 4 as a standalone recommendation, applicable to both immediate and batch modes.

## Structural changes

- **Added section 1 (Error Category Framework)**: Adopted devil-advocate's proposal to collapse 20+ error cases into 6 categories with a recoverable/terminal distinction. This is the organising principle for the entire error handling spec.
- **Added section 10 (Impact of Posting Mode Choice)**: Documents how choosing immediate-only eliminates approximately half the error handling spec, supporting the team's lean towards a single posting mode for V1.
- **Reordered summary recommendations**: Reflects revised priorities after debate. The list went from 10 items to 8, with clearer justification for each.

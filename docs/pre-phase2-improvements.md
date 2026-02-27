Pre-Phase 2 Improvements

Suggested enhancements to md-editor before starting Phase 2 (Copy Toolbar).
These address spec gaps, UX discoverability, and real-world markdown compatibility.

Each feature is grouped into a phase for incremental delivery.
Mark `[x]` on the phase heading after all its items are complete.

---

# - [ ] Phase A — Quick Wins

## A2: Read-Only Mode ✅

**Effort:** Low — **Completed**

Detects read-only documents (e.g. git base versions from Source Control) using a URI scheme whitelist (`file` and `untitled` are writable; all other schemes default to read-only). Disables editing in TipTap, shows a centred "Read-only" banner, and skips the edit pipeline entirely.

### Scope
- [x] Detect read-only state via `document.uri.scheme` whitelist (`file`, `untitled` = writable)
- [x] Call `editor.setEditable(false)` on TipTap when the document is read-only
- [x] Visual indicator: fixed "Read-only" banner centred at top of viewport
- [x] Skip `onDidChangeTextDocument` listener for read-only documents
- [x] Guard edit/save/undo/redo handlers on both extension and webview sides
- [x] Keyboard shortcuts (Cmd+Z, Cmd+Shift+Z, Cmd+S) still `preventDefault` but skip message posting

### Acceptance Criteria
- [x] Opening a file from Source Control "Changes" shows it as non-editable
- [x] Typing in a read-only view does nothing (no silent failures)
- [x] Visual cue distinguishes read-only from editable mode
- [x] Files opened normally remain fully editable

---

## A3: Raw Markdown Toggle

**Effort:** Low

Users sometimes need to see or edit the raw markdown source — to fix syntax issues, inspect frontmatter, or copy exact markup. Currently there is no way to switch between WYSIWYG and raw views.

### Scope
- Toggle button in the editor title bar (e.g., `</>` icon) to switch between WYSIWYG and raw markdown view
- Raw view: display the plain markdown text in a monospace, syntax-highlighted editor (read-write)
- Edits in raw view sync back to the document (same sync pipeline as WYSIWYG)
- Switching back to WYSIWYG re-parses the markdown into TipTap
- Toggle state does not persist across tab reopens (defaults to WYSIWYG)

### Acceptance Criteria
- [ ] Title bar shows a toggle button to switch views
- [ ] Raw view displays the exact markdown source with monospace font
- [ ] Edits in raw view are saved to disk like normal edits
- [ ] Switching WYSIWYG → Raw → WYSIWYG preserves content without data loss
- [ ] Keyboard shortcut (e.g., `Cmd+Shift+M`) toggles between views

---

# - [ ] Phase B — UX & Discoverability

## B1: Formatting Toolbar on Selection

**Effort:** Medium

All formatting is keyboard-shortcut-only (`Cmd+B`, `Cmd+I`, `Cmd+K`). Users who don't know shortcuts have no way to discover formatting options. This is separate from Phase 2's copy toolbar — this is about text formatting actions.

### Scope
- Floating toolbar appears near the text selection (above or below, depending on viewport)
- Buttons: **Bold**, *Italic*, ~~Strikethrough~~, `Code`, Link, Heading dropdown
- Each button toggles the corresponding TipTap command on the selection
- Toolbar dismisses on: click outside, selection collapse, `Escape`
- Active state shown on buttons when selection already has that formatting

### Acceptance Criteria
- [ ] Selecting text shows a floating toolbar within ~200ms
- [ ] Clicking Bold/Italic/etc. applies formatting and keeps selection
- [ ] Toolbar shows active state for already-formatted text (e.g., bold button highlighted if selection is bold)
- [ ] Toolbar positions correctly near selection, stays within viewport
- [ ] Toolbar dismisses cleanly without interfering with editing

---

# - [ ] Phase C — Markdown Compatibility

## C1: YAML Frontmatter Handling

**Effort:** Low

YAML frontmatter (`---` delimited block at file start) is standard in Hugo, Jekyll, Docusaurus, Obsidian, and many other tools. Currently it renders as visible text, which is noisy and editable in ways that can break the frontmatter structure.

### Scope
- Detect frontmatter: block between `---` markers at the very start of the file
- Display option A: Collapse into a single clickable "Frontmatter" bar (click to expand/edit raw YAML)
- Display option B: Render as a styled metadata block with key-value pairs
- Frontmatter must round-trip perfectly (no data loss on save)

### Acceptance Criteria
- [ ] Files with YAML frontmatter display it distinctly from body content
- [ ] Frontmatter content is preserved exactly on save (no reordering, no stripping)
- [ ] Files without frontmatter are unaffected
- [ ] Editing frontmatter values works without breaking the `---` delimiters

---

## C2: GFM Alerts / Admonitions

**Effort:** Medium

The spec lists "alerts/admonitions" under GFM support. GitHub renders `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, and `> [!CAUTION]` as styled callout blocks. These are increasingly common in README and documentation files.

### Scope
- Parse the five GitHub alert types from blockquote syntax
- Render with distinct styling: icon + coloured left border + background tint (matching GitHub's rendering)
- Colours should adapt to VS Code theme (use `--vscode-*` variables where possible, fallback to accessible defaults)
- Typing `> [!NOTE]` followed by Enter should activate the alert style
- Alerts must serialise back to standard GFM blockquote syntax on save

### Acceptance Criteria
- [ ] All five alert types render with distinct icon and colour
- [ ] Alerts display correctly in both light and dark themes
- [ ] Typing the alert syntax inline triggers the styled rendering
- [ ] Alerts round-trip to valid GFM markdown (no custom syntax in saved file)

---

# - [ ] Phase D — Test Suite

## D1: Unit & Integration Tests

**Effort:** Medium–High

The extension has zero tests. The sync logic is the most critical and fragile layer — regressions here cause data loss or corruption. Adding tests now protects against breakage as Phase 2 modifies the webview.

### Scope

#### Unit Tests
- **DocumentSyncManager**: echo prevention, version counter logic, `trimEnd` normalisation, debounce behaviour
- **SyncClient**: external update handling, edit batching, cursor preservation
- **syncProtocol types**: message construction and discrimination

#### Integration Tests
- Webview ↔ Extension round-trip: edit in webview → verify TextDocument content
- External edit → verify webview receives update
- Undo/redo forwarding
- Search bar: find matches, navigation, highlight state

#### Test Tooling
- Framework: Vitest or Jest (pick one, keep it simple)
- VS Code extension testing: `@vscode/test-electron` for integration tests
- Mock `vscode` API for unit tests

### Acceptance Criteria
- [ ] Unit tests cover sync echo prevention (both directions)
- [ ] Unit tests cover version counter staleness rejection
- [ ] Integration test: edit → save → file content matches
- [ ] Tests run in CI (or at minimum via `npm test`)
- [ ] Coverage for search bar match counting and navigation

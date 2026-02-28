<!--
  LLM IMPLEMENTATION NOTE:
  When implementing this specification, update the Progress Tracker section
  after completing each task. Change [ ] to [x] for completed items.
-->

VS Code Extensions — Markdown Editor & Smart Diff

## Overview

Two VS Code extensions that address daily friction with markdown editing and source control diffs. The goal is to bring Android Studio's reliable diff experience and Notion's inline editing to VS Code — without forking VS Code.

**Extension 1 (MVP):** `md-editor` — Notion-like inline markdown editor with copy toolbar
**Extension 2 (v2):** `smart-diff` — Custom diff viewer with single-tab reuse and reliable collapse toggle

## Extension 1: Markdown Editor + Copy Toolbar

### Functional Requirements

#### Core: Inline WYSIWYG Editing
- `.md` files open in **preview/rendered mode by default**
- Users edit directly in the rendered view — no toggling between raw and preview
- Typing markdown syntax triggers inline formatting:
  - `**text**` renders as **bold** as you type
  - `*text*` renders as *italic*
  - `` ``` `` creates a code block
  - `# ` creates a heading
  - `- ` creates a bullet list
  - `[ ]` creates a task checkbox
  - `> ` creates a blockquote
  - `---` creates a horizontal rule
  - `[text](url)` creates a link
  - `|col|col|` creates a table
- Standard editor shortcuts:
  - `Cmd+B` — bold
  - `Cmd+I` — italic
  - `Cmd+K` — insert link
- Supports **GitHub Flavoured Markdown (GFM)**: tables, task lists, strikethrough, autolinks, alerts/admonitions
- File scope: `.md` files only

#### Core: Copy Toolbar
- **Floating toolbar** appears when text is selected in the editor
- Default behaviour: copies **rendered content** (rich text / HTML) — same as VS Code's current preview copy
- **Persistent toggle button** in the editor toolbar header (similar to Claude's layout toggle icons):
  - Toggle OFF (default): copy = rendered/rich text
  - Toggle ON: copy = raw markdown
- Toggle state persists within the session

#### Images
- v1: No special image handling (no drag/drop paste)
- Users manage image paths manually
- Existing image references (`![alt](path)`) render inline as images

#### What This Extension Does NOT Do
- Does not handle `.mdx`, `.txt`, `.rst` or any non-`.md` files
- Does not provide image paste/upload/management
- Does not replace VS Code's diff editor
- Does not modify Source Control behaviour

### Technical Specification

#### Architecture
- Built using VS Code **Custom Editor API** (`CustomTextEditorProvider`)
- Registers as the default editor for `*.md` files
- Renders a **webview** containing:
  - A WYSIWYG editor (candidate libraries: **ProseMirror**, **TipTap**, or **Milkdown**)
  - A toolbar with the raw/rendered copy toggle
- Syncs edits bidirectionally with VS Code's `TextDocument` model:
  - User edits in webview → updates the underlying `.md` file
  - External changes to `.md` file → reflected in webview
- Supports VS Code's undo/redo, save, search (Cmd+F) natively

#### Editor Library Evaluation

| Library | Pros | Cons |
|---------|------|------|
| **TipTap** (ProseMirror-based) | Rich extension ecosystem, Notion-like UX, active community | Heavier bundle size |
| **Milkdown** (ProseMirror-based) | Built specifically for markdown, plugin system | Smaller community |
| **ProseMirror** (raw) | Maximum control, battle-tested | More boilerplate to set up |

**Recommendation:** TipTap — closest to Notion's editing experience out of the box, with GFM extensions available.

#### Copy Mechanism
- Floating toolbar: appears on `mouseup` when selection exists
- Uses the **Clipboard API** (`navigator.clipboard.write()`) inside the webview
- Rendered mode: writes `text/html` + `text/plain` (rendered) to clipboard
- Raw mode: writes `text/plain` (raw markdown) to clipboard
- Toggle state stored in webview memory (resets on tab close)

#### Data Flow
```
┌──────────────────────────────────────────────┐
│  VS Code                                     │
│  ┌─────────────────────────────────────────┐  │
│  │  Custom Editor (Webview)                │  │
│  │  ┌──────────────────────────────────┐   │  │
│  │  │  TipTap Editor                   │   │  │
│  │  │  (GFM rendering + inline edit)   │   │  │
│  │  └──────────┬───────────────────────┘   │  │
│  │             │ edits                     │  │
│  │             ▼                           │  │
│  │  ┌──────────────────────────────────┐   │  │
│  │  │  Document Sync Layer             │   │  │
│  │  │  (webview ↔ TextDocument)        │   │  │
│  │  └──────────────────────────────────┘   │  │
│  │                                         │  │
│  │  [Toggle: Raw ◯ ● Rendered] [Copy ▢]   │  │
│  └─────────────────────────────────────────┘  │
│                    │                          │
│                    ▼                          │
│  TextDocument (.md file on disk)              │
└──────────────────────────────────────────────┘
```

### UI/UX Specification

#### Editor View
- Opens as a single tab — replaces VS Code's default text editor for `.md` files
- Rendered markdown fills the editor area (like reading a Notion page)
- Click anywhere to place cursor and start editing
- Formatting toolbar appears on text selection (floating, near selection)

#### States
- **Loading**: Spinner while TipTap initialises and parses the markdown
- **Editing**: Cursor active, formatting applied inline as user types
- **Read-only**: For files opened with read-only flag (e.g., from Source Control index)

#### Toolbar Toggle
- Positioned in the editor title bar area (right side)
- Icon: two-state toggle (e.g., `{ }` icon for raw mode, rendered icon for default)
- Tooltip: "Copy mode: Rendered" / "Copy mode: Raw Markdown"

---

## Extension 2: Smart Diff (v2 — Future)

### Functional Requirements

#### Core: Single Tab Reuse
- All diffs opened from the **Source Control panel** reuse a single tab
- Clicking a different file in Staged Changes or Working Tree replaces the current diff **immediately** (no confirmation dialog)
- Applies to both Staged Changes and Changes (Working Tree) sections
- Normal file opens (from Explorer, Cmd+P, etc.) continue opening in new tabs as usual

#### Core: Binary Diff Toggle
- Only **two modes** — no intermediate states:
  - **Collapsed**: Shows only changed fragments with collapsed unchanged regions (like Android Studio)
  - **Full File**: Shows the complete file with changes highlighted
- Toggle is a single button in the diff viewer toolbar
- Behaviour is **predictable and reliable** — always toggles between exactly these two states
- Default: Collapsed

#### What This Extension Does NOT Do
- No inline commenting or code review features
- No 3-way merge view (staged + working tree remain separate views in the same tab)
- No modifications to VS Code's Source Control panel layout

### Technical Specification

#### Architecture
- Built using VS Code **Custom Editor API** with a **webview-based diff viewer**
- Replaces VS Code's native diff editor for Source Control operations
- Uses a diff library (e.g., **diff-match-patch** or **jsdiff**) to compute diffs
- Renders side-by-side diff with syntax highlighting (via **Shiki** or **Prism**)

#### Tab Management
- Registers a `WebviewPanel` with a fixed `viewColumn` and `viewType`
- On Source Control file click:
  1. Check if a smart-diff tab already exists
  2. If yes: replace content with new file's diff
  3. If no: create a new smart-diff tab
- Uses VS Code's `onDidChangeActiveTextEditor` and SCM API to intercept file opens

#### Collapse Toggle
- **Collapsed mode**: Groups consecutive unchanged lines into a clickable "N lines hidden" region
- **Full mode**: Renders all lines with change highlighting
- Toggle state persists within the session

#### Data Flow
```
┌──────────────────────────────────────────────┐
│  Source Control Panel                        │
│  ├── Staged Changes                          │
│  │   ├── file1.ts  ──┐                      │
│  │   └── file2.ts  ──┤  click               │
│  ├── Changes          │                      │
│  │   ├── file1.ts  ──┤                      │
│  │   └── file3.ts  ──┘                      │
│  └────────────────────┼──────────────────────┘
│                       ▼                      │
│  ┌─────────────────────────────────────────┐ │
│  │  Smart Diff Tab (single, reused)        │ │
│  │  ┌────────────────┬────────────────┐    │ │
│  │  │  Original      │  Modified      │    │ │
│  │  │  (base/HEAD)   │  (staged/WT)   │    │ │
│  │  │                │                │    │ │
│  │  │  ≫ 14 lines ≪ │  ≫ 14 lines ≪ │    │ │
│  │  │  - old line    │  + new line    │    │ │
│  │  │  ≫ 8 lines ≪  │  ≫ 8 lines ≪  │    │ │
│  │  └────────────────┴────────────────┘    │ │
│  │  [Collapsed ● ◯ Full]                  │ │
│  └─────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Markdown Editor MVP
1. Scaffold VS Code extension with Custom Editor provider
2. Integrate TipTap editor in webview with GFM support
3. Implement bidirectional sync (TipTap ↔ TextDocument)
4. Wire up keyboard shortcuts (Cmd+B, Cmd+I, Cmd+K)
5. Test: open .md file → renders in preview, editable inline

### Phase 2: Copy Toolbar
1. Add floating toolbar on text selection
2. Implement rendered copy (HTML + plain text to clipboard)
3. Add raw/rendered toggle button in editor title bar
4. Implement raw copy (markdown text to clipboard)
5. Test: select text → copy → paste in Slack (rich) and editor (raw)

### Phase 3: Polish & Edge Cases
1. Handle large files (virtualised rendering if needed)
2. Support VS Code themes (light/dark/high contrast)
3. Handle concurrent external edits (file watcher)
4. Undo/redo integration with VS Code
5. Search (Cmd+F) support within the webview

### Phase 4: Smart Diff Extension (v2)
1. Scaffold second extension with Custom Editor provider
2. Build diff computation layer (jsdiff)
3. Build side-by-side webview renderer with syntax highlighting
4. Implement collapse/expand toggle for unchanged regions
5. Implement single-tab reuse via SCM API interception
6. Test: click files in Source Control → same tab, reliable toggle

## Progress Tracker

> **Note for LLM/Developer:** Update this section as you complete each task.
> Change `- [ ]` to `- [x]` when a task is done.

### Phase 1: Markdown Editor MVP
- [x] Scaffold VS Code extension project (package.json, tsconfig, esbuild)
- [x] Register CustomTextEditorProvider for `*.md` files
- [x] Set up webview with TipTap + StarterKit + GFM extensions
- [x] Implement markdown → TipTap document parsing
- [x] Implement TipTap document → markdown serialisation
- [x] Bidirectional sync: webview edits → TextDocument updates
- [x] Bidirectional sync: external TextDocument changes → webview updates
- [x] Keyboard shortcuts: Cmd+B (bold), Cmd+I (italic), Cmd+K (link)
- [x] Verify: open .md, edit inline, save, content persists

### Phase 2: Copy Toolbar
- [ ] Floating toolbar component (appears on text selection)
- [ ] Copy as rendered (HTML to clipboard)
- [ ] Toggle button in editor title bar (raw/rendered)
- [ ] Copy as raw markdown when toggle is ON
- [ ] Verify: copy → paste in Slack (rich text) and code editor (raw)

### Phase 3: Polish & Edge Cases
- [x] VS Code theme integration (light/dark/high contrast)
- [x] File watcher for external edits
- [x] Undo/redo working correctly
- [x] Cmd+F search within webview
- [x] Large file handling

### Phase 4: Smart Diff (v2)
- [ ] Scaffold smart-diff extension
- [ ] Diff computation layer
- [ ] Side-by-side webview renderer with syntax highlighting
- [ ] Collapse/expand toggle
- [ ] Single-tab reuse via SCM API
- [ ] Verify: Source Control click → same tab, binary toggle works

### Final Verification
- [ ] Run extension in VS Code Extension Development Host
- [ ] Test on real .md files (GFM tables, code blocks, task lists)
- [ ] Test copy toolbar with multiple paste targets
- [ ] Bundle size check
- [ ] Publish-ready packaging (vsix)

## Decisions Made

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Extension packaging | Two extensions (md-editor + smart-diff) | Independent concerns, independent release cycles |
| Diff implementation | Custom webview | Full control over UX, reliable collapse toggle |
| Editor library | TipTap (recommended) | Closest to Notion UX, GFM extensions available |
| Copy default | Rendered (rich text) | Matches existing VS Code preview copy behaviour |
| Copy toggle | Persistent toolbar button | Inspired by Claude's UI layout toggles |
| Diff tab behaviour | Replace immediately | No confirmation — fast switching like Android Studio |
| Diff modes | Binary only (collapsed/full) | Predictable, no intermediate states |
| Image handling | Manual (v1) | Keep scope tight for MVP |
| File types | .md only | Focused scope, avoids edge cases with other formats |
| MVP scope | Markdown editor first | More frequent daily use case |
| Shortcuts | Standard editor (Cmd+B, etc.) | Familiar from Notion/Google Docs |

## Open Questions

- ~~TipTap vs Milkdown: final decision after prototyping both in a webview~~ **Resolved: TipTap chosen**
- Performance characteristics of TipTap in a VS Code webview for files > 1000 lines
- VS Code SCM API limitations for intercepting diff opens (research needed for Phase 4)

## Delivery Plan

> **Implementation Strategy**: This work is broken into sequential phases across two extensions.
> Complete each phase and get approval before starting the next.
> Update checkboxes as phases are completed.

---

### Phase 1: Core WYSIWYG Editor
**PR Title:** `feat: scaffold md-editor extension with TipTap WYSIWYG editing`
**Extension:** md-editor
**Status:** [x] Completed

**Scope:**
- Extension scaffold (package.json, tsconfig, esbuild)
- `CustomTextEditorProvider` registration for `*.md` files
- TipTap editor + StarterKit + GFM extensions in webview
- Markdown → TipTap document parsing (via tiptap-markdown)
- TipTap document → markdown serialisation (via tiptap-markdown)
- Bidirectional sync: webview edits ↔ VS Code TextDocument
- Keyboard shortcuts: Cmd+B (bold), Cmd+I (italic), Cmd+K (link)

**Acceptance Criteria:**
- [x] Opening a `.md` file shows rendered content in a single tab
- [x] Clicking in the rendered view places cursor and allows editing
- [x] Typing `**text**` renders bold inline; same for other GFM syntax
- [x] Cmd+B/I/K work as expected
- [x] Saving persists changes to the `.md` file on disk
- [x] GFM features work: tables, task lists, strikethrough, code blocks

**Dependencies:** None

---

### Phase 2: Copy Toolbar
**PR Title:** `feat: add floating copy toolbar with raw/rendered toggle`
**Extension:** md-editor
**Status:** [ ] Not Started | [ ] In Progress | [ ] In Review | [ ] Merged

**Scope:**
- Floating toolbar component (appears on text selection)
- Copy as rendered (HTML + plain text to clipboard)
- Copy as raw markdown to clipboard
- Persistent toggle button in editor title bar (raw/rendered mode)

**Acceptance Criteria:**
- [ ] Selecting text shows a floating toolbar near the selection
- [ ] Default copy puts rendered HTML on clipboard (pastes rich in Slack)
- [ ] Toggle ON → copy puts raw markdown on clipboard
- [ ] Toggle button visible in editor title bar with tooltip
- [ ] Toggle state persists within the session

**Dependencies:** Phase 1 must be merged

---

### Phase 3: Polish & Hardening
**PR Title:** `feat: add theme support, undo/redo, search, and large file handling`
**Extension:** md-editor
**Status:** In Progress (theme + external edits + undo/redo done)

**Scope:**
- VS Code theme integration (light/dark/high contrast)
- File watcher for external edits (reload webview on external change)
- Undo/redo integration with VS Code
- Cmd+F search within webview
- Large file handling (virtualised rendering if needed)

**Acceptance Criteria:**
- [x] Editor respects VS Code theme (light/dark/high contrast)
- [x] External file changes reflected in editor without data loss
- [x] Cmd+Z / Cmd+Shift+Z work correctly
- [x] Cmd+F opens search within the editor
- [x] Files > 1000 lines open without noticeable lag

**Dependencies:** Phase 2 must be merged

---

### Phase 4: Smart Diff Extension (v2)
**PR Title:** `feat: smart-diff extension with single-tab reuse and collapse toggle`
**Extension:** smart-diff (separate extension)
**Status:** [ ] Not Started | [ ] In Progress | [ ] In Review | [ ] Merged

**Scope:**
- Extension scaffold with Custom Editor / WebviewPanel
- Diff computation layer (jsdiff)
- Side-by-side webview renderer with syntax highlighting (Shiki/Prism)
- Collapse/expand toggle (binary: collapsed ↔ full file)
- Single-tab reuse for all Source Control diff opens
- Immediate file switching (no confirmation)

**Acceptance Criteria:**
- [ ] Clicking a file in Source Control opens diff in a dedicated tab
- [ ] Clicking another file replaces the diff in the same tab
- [ ] Collapsed mode shows only changed fragments with "N lines hidden" regions
- [ ] Full mode shows complete file with changes highlighted
- [ ] Toggle reliably switches between exactly two states
- [ ] Normal file opens (Explorer, Cmd+P) still use new tabs

**Dependencies:** Independent of md-editor. Can start anytime after Phase 1 for learnings.

---

### Implementation Notes

- **Total Phases:** 4 (3 for md-editor, 1 for smart-diff)
- **Estimated Review Complexity:** Phase 1 High, Phase 2 Low, Phase 3 Medium, Phase 4 High
- **Critical Path:** Phase 1 → Phase 2 → Phase 3 (sequential). Phase 4 is independent.

## Pending Discussion

*No pending items — all questions resolved during interview.*

## References

- [VS Code Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [TipTap Editor](https://tiptap.dev/)
- [Milkdown Editor](https://milkdown.dev/)
- [VS Code SCM API](https://code.visualstudio.com/api/extension-guides/scm-provider)
- [ProseMirror](https://prosemirror.net/)

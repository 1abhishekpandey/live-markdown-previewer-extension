// @vitest-environment happy-dom

import type { CommentThread, PendingComment } from '../../sync/commentTypes';
import type { LineMap } from '../../webview/lineMap';

// --- Mocks ---------------------------------------------------------------

// Accumulate decorations created via Decoration.node / Decoration.widget
// so tests can inspect them without a real ProseMirror runtime.
const createdDecorations: Array<{ type: string; from: number; to: number; spec?: object; widgetFn?: () => HTMLElement }> = [];

vi.mock('@tiptap/pm/state', () => {
  // Minimal PluginKey that stores state on an EditorState-like object.
  class MockPluginKey {
    private name: string;
    constructor(name: string) { this.name = name; }
    getState(state: any) { return state?.__pluginState?.[this.name] ?? undefined; }
  }

  class MockPlugin {
    key: MockPluginKey;
    spec: any;
    constructor(spec: any) {
      this.spec = spec;
      this.key = spec.key;
    }
  }

  return { Plugin: MockPlugin, PluginKey: MockPluginKey };
});

vi.mock('@tiptap/pm/view', () => ({
  Decoration: {
    node(from: number, to: number, attrs: object) {
      const d = { type: 'node', from, to, spec: attrs };
      createdDecorations.push(d);
      return d;
    },
    widget(pos: number, toDOM: () => HTMLElement, spec?: object) {
      const d = { type: 'widget', from: pos, to: pos, spec, widgetFn: toDOM };
      createdDecorations.push(d);
      return d;
    },
  },
  DecorationSet: {
    empty: { __empty: true },
    create(_doc: unknown, decorations: unknown[]) {
      return { decorations };
    },
  },
}));

// We mock findPosForLine instead of building a real LineMap, so we can
// control exactly which lines map to which positions.
vi.mock('../../webview/lineMap', () => ({
  findPosForLine(_map: unknown, line: number) {
    // Look up from the active lineMap mock set by the test
    return activePosLookup.get(line) ?? null;
  },
}));

// Tests set this before exercising the plugin.
let activePosLookup = new Map<number, number>();

// --- Helpers -------------------------------------------------------------

function makeLineMap(): LineMap {
  // The actual content doesn't matter — findPosForLine is mocked.
  return { posToLineRange: new Map(), lineToPos: new Map() } as LineMap;
}

interface FakeNode {
  nodeSize: number;
}

function makeDoc(nodesByPos: Map<number, FakeNode>) {
  return {
    nodeAt(pos: number): FakeNode | null {
      return nodesByPos.get(pos) ?? null;
    },
  };
}

function makeEditorState(
  pluginKeyName: string,
  pluginState: unknown,
  doc: unknown,
) {
  return {
    doc,
    __pluginState: { [pluginKeyName]: pluginState },
  };
}

function makeThread(overrides: Partial<CommentThread> & { id: number; workingCopyLine: number }): CommentThread {
  return {
    path: 'README.md',
    diffLine: overrides.workingCopyLine,
    diffStartLine: null,
    workingCopyStartLine: null,
    comments: [{ id: 1, author: 'alice', body: 'comment', createdAt: '2026-01-01', isOwn: false, isOutdated: false }],
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingComment> & { workingCopyLine: number }): PendingComment {
  return {
    tempId: 'temp-1',
    threadId: null,
    body: 'pending comment',
    workingCopyStartLine: null,
    diffLine: null,
    diffStartLine: null,
    ...overrides,
  };
}

// --- Import under test (after mocks) ------------------------------------

import {
  createCommentIndicatorPlugin,
  type CommentIndicatorState,
} from '../../webview/commentIndicator';

// Helper: invoke the plugin's decorations prop the same way ProseMirror would.
function getDecorations(pluginState: CommentIndicatorState, doc: unknown) {
  const plugin = createCommentIndicatorPlugin();
  const state = makeEditorState('commentIndicator', pluginState, doc);
  // decorations prop is a function on Plugin.spec.props
  const decorationsFn = (plugin as any).spec.props.decorations;
  return decorationsFn(state);
}

// --- Tests ---------------------------------------------------------------

beforeEach(() => {
  createdDecorations.length = 0;
  activePosLookup = new Map();
});

describe('commentIndicator plugin', () => {
  describe('empty / disabled states', () => {
    it('returns DecorationSet.empty when reviewMode is false', () => {
      const doc = makeDoc(new Map());
      const result = getDecorations(
        { reviewMode: false, diffHighlightLines: [1], threads: [], pendingComments: [], lineMap: makeLineMap() },
        doc,
      );
      expect(result).toHaveProperty('__empty', true);
    });

    it('returns DecorationSet.empty when lineMap is null', () => {
      const doc = makeDoc(new Map());
      const result = getDecorations(
        { reviewMode: true, diffHighlightLines: [1], threads: [], pendingComments: [], lineMap: null },
        doc,
      );
      expect(result).toHaveProperty('__empty', true);
    });
  });

  describe('diff highlight decorations', () => {
    it('creates diff-highlight decoration for each mapped diffHighlightLine', () => {
      // diffHighlightLines are 1-indexed. lineMap expects 0-indexed.
      // Line 3 (1-indexed) → line 2 (0-indexed) → pos 10 in our mock.
      // Line 7 (1-indexed) → line 6 (0-indexed) → pos 30 in our mock.
      activePosLookup.set(2, 10);
      activePosLookup.set(6, 30);

      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(10, { nodeSize: 8 });
      nodesByPos.set(30, { nodeSize: 12 });

      const doc = makeDoc(nodesByPos);
      const result = getDecorations(
        { reviewMode: true, diffHighlightLines: [3, 7], threads: [], pendingComments: [], lineMap: makeLineMap() },
        doc,
      );

      const nodeDecos = createdDecorations.filter(d => d.type === 'node' && d.spec && (d.spec as any).class === 'diff-highlight');
      expect(nodeDecos).toHaveLength(2);
      expect(nodeDecos[0]).toEqual(expect.objectContaining({ from: 10, to: 18 }));
      expect(nodeDecos[1]).toEqual(expect.objectContaining({ from: 30, to: 42 }));
    });

    it('handles unmapped lines gracefully (no decoration, no error)', () => {
      // No entries in activePosLookup → findPosForLine returns null
      const doc = makeDoc(new Map());
      const result = getDecorations(
        { reviewMode: true, diffHighlightLines: [99], threads: [], pendingComments: [], lineMap: makeLineMap() },
        doc,
      );

      // DecorationSet.create is called with empty array
      expect(result).toHaveProperty('decorations');
      expect((result as any).decorations).toHaveLength(0);
    });
  });

  describe('comment thread decorations', () => {
    it('creates comment-highlight decoration for a thread line', () => {
      // workingCopyLine 5 (1-indexed) → 0-indexed 4 → pos 20
      activePosLookup.set(4, 20);
      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(20, { nodeSize: 10 });

      const thread = makeThread({ id: 100, workingCopyLine: 5 });
      const doc = makeDoc(nodesByPos);
      const result = getDecorations(
        { reviewMode: true, diffHighlightLines: [], threads: [thread], pendingComments: [], lineMap: makeLineMap() },
        doc,
      );

      const highlights = createdDecorations.filter(d => d.type === 'node' && (d.spec as any)?.class === 'comment-highlight');
      expect(highlights).toHaveLength(1);
      expect(highlights[0]).toEqual(expect.objectContaining({ from: 20, to: 30 }));
    });

    it('stores comment count in data-comment-count attribute', () => {
      activePosLookup.set(4, 20);
      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(20, { nodeSize: 10 });

      const thread = makeThread({
        id: 100,
        workingCopyLine: 5,
        comments: [
          { id: 1, author: 'alice', body: 'first', createdAt: '2026-01-01', isOwn: false, isOutdated: false },
          { id: 2, author: 'bob', body: 'second', createdAt: '2026-01-02', isOwn: false, isOutdated: false },
        ],
      });

      const doc = makeDoc(nodesByPos);
      getDecorations(
        { reviewMode: true, diffHighlightLines: [], threads: [thread], pendingComments: [], lineMap: makeLineMap() },
        doc,
      );

      const highlights = createdDecorations.filter(d => d.type === 'node' && (d.spec as any)?.class === 'comment-highlight');
      expect(highlights).toHaveLength(1);
      expect((highlights[0].spec as any)['data-comment-count']).toBe('2');
      expect((highlights[0].spec as any)['data-thread-id']).toBe('100');
    });

    it('shows combined count when thread has pending comments', () => {
      activePosLookup.set(4, 20);
      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(20, { nodeSize: 10 });

      const thread = makeThread({ id: 100, workingCopyLine: 5 });
      const pending = makePending({ workingCopyLine: 5, threadId: 100 });

      const doc = makeDoc(nodesByPos);
      getDecorations(
        { reviewMode: true, diffHighlightLines: [], threads: [thread], pendingComments: [pending], lineMap: makeLineMap() },
        doc,
      );

      const highlights = createdDecorations.filter(d => d.type === 'node' && (d.spec as any)?.class === 'comment-highlight');
      expect(highlights).toHaveLength(1);
      // 1 existing comment + 1 pending = "1+1"
      expect((highlights[0].spec as any)['data-comment-count']).toBe('1+1');
    });
  });

  describe('pending-only comment decorations', () => {
    it('creates comment-highlight-pending for pending-only lines with data attributes', () => {
      // workingCopyLine 8 (1-indexed) → 0-indexed 7 → pos 40
      activePosLookup.set(7, 40);
      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(40, { nodeSize: 6 });

      const pending = makePending({ workingCopyLine: 8 });
      const doc = makeDoc(nodesByPos);
      getDecorations(
        { reviewMode: true, diffHighlightLines: [], threads: [], pendingComments: [pending], lineMap: makeLineMap() },
        doc,
      );

      const pendingHighlights = createdDecorations.filter(
        d => d.type === 'node' && (d.spec as any)?.class === 'comment-highlight-pending',
      );
      expect(pendingHighlights).toHaveLength(1);
      expect(pendingHighlights[0]).toEqual(expect.objectContaining({ from: 40, to: 46 }));
      expect((pendingHighlights[0].spec as any)['data-pending-count']).toBe('1');
      expect((pendingHighlights[0].spec as any)['data-pending-line']).toBe('8');
    });

    it('skips pending decoration when thread already exists on same line', () => {
      activePosLookup.set(4, 20);
      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(20, { nodeSize: 10 });

      const thread = makeThread({ id: 100, workingCopyLine: 5 });
      const pending = makePending({ workingCopyLine: 5, threadId: 100 });

      const doc = makeDoc(nodesByPos);
      getDecorations(
        { reviewMode: true, diffHighlightLines: [], threads: [thread], pendingComments: [pending], lineMap: makeLineMap() },
        doc,
      );

      // Should NOT have any comment-highlight-pending decorations
      const pendingHighlights = createdDecorations.filter(
        d => d.type === 'node' && (d.spec as any)?.class === 'comment-highlight-pending',
      );
      expect(pendingHighlights).toHaveLength(0);
    });
  });

  describe('thread data attributes for click handling', () => {
    it('stores thread-id and thread-line in node decoration for click handling', () => {
      activePosLookup.set(4, 20);
      const nodesByPos = new Map<number, FakeNode>();
      nodesByPos.set(20, { nodeSize: 10 });

      const thread = makeThread({ id: 42, workingCopyLine: 5 });
      const doc = makeDoc(nodesByPos);
      getDecorations(
        { reviewMode: true, diffHighlightLines: [], threads: [thread], pendingComments: [], lineMap: makeLineMap() },
        doc,
      );

      const highlights = createdDecorations.filter(d => d.type === 'node' && (d.spec as any)?.class === 'comment-highlight');
      expect(highlights).toHaveLength(1);
      expect((highlights[0].spec as any)['data-thread-id']).toBe('42');
      expect((highlights[0].spec as any)['data-thread-line']).toBe('5');
    });
  });
});

// @vitest-environment happy-dom

import type { LlmComment } from '../../webview/llmCommentStore';
import type { LineMap, LineRange } from '../../webview/lineMap';

// --- Mocks ---------------------------------------------------------------

// Accumulate decorations created via Decoration.node so tests can inspect
// them without a real ProseMirror runtime.
const createdDecorations: Array<{ type: string; from: number; to: number; spec?: object }> = [];

vi.mock('@tiptap/pm/state', () => {
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

// Mock findPosForLine for the review-mode regression test (G3) so we can
// drive the diff-highlight branch from a controlled lookup table.
vi.mock('../../webview/lineMap', () => ({
  findPosForLine(_map: unknown, line: number) {
    return activePosLookup.get(line) ?? null;
  },
}));

let activePosLookup = new Map<number, number>();

// --- Helpers -------------------------------------------------------------

interface FakeNode {
  pos: number;
  type: string;
  size: number;
}

function makeFakeDoc(nodes: FakeNode[]) {
  return {
    nodeAt(pos: number): { type: { name: string }; nodeSize: number } | null {
      const n = nodes.find((x) => x.pos === pos);
      if (!n) return null;
      return { type: { name: n.type }, nodeSize: n.size };
    },
  };
}

function makeFakeLineMap(
  entries: Array<{ pos: number; startLine: number; endLine?: number }>,
): LineMap {
  const posToLineRange = new Map<number, LineRange>();
  for (const e of entries) {
    posToLineRange.set(e.pos, {
      startLine: e.startLine,
      endLine: e.endLine ?? e.startLine + 1,
    });
  }
  return {
    posToLineRange,
    lineToPos: new Map<number, number>(),
  };
}

function makeEditorState(pluginState: unknown, doc: unknown) {
  return {
    doc,
    __pluginState: { commentIndicator: pluginState },
  };
}

function makeLlmComment(overrides: Partial<LlmComment> & { startLine: number; endLine: number }): LlmComment {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    kind: 'line',
    body: 'comment body',
    createdAt: Date.now(),
    ...overrides,
  };
}

// --- Import under test (after mocks) ------------------------------------

import {
  createCommentIndicatorPlugin,
  type CommentIndicatorState,
} from '../../webview/commentIndicator';

function getDecorations(pluginState: CommentIndicatorState, doc: unknown) {
  const plugin = createCommentIndicatorPlugin();
  const state = makeEditorState(pluginState, doc);
  const decorationsFn = (plugin as any).spec.props.decorations;
  return decorationsFn(state);
}

// --- Tests ---------------------------------------------------------------

beforeEach(() => {
  createdDecorations.length = 0;
  activePosLookup = new Map();
});

describe('llm gutter plugin (LLM-Assist branch in commentIndicator)', () => {
  it('G1: returns empty decoration set when both reviewMode and llmAssistActive are false', () => {
    const doc = makeFakeDoc([{ pos: 0, type: 'paragraph', size: 5 }]);
    const result = getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([{ pos: 0, startLine: 0 }]),
        llmAssistActive: false,
        llmComments: [],
      },
      doc,
    );
    expect(result).toHaveProperty('__empty', true);
    expect(createdDecorations).toHaveLength(0);
  });

  it('G2: emits a single llm-line-commentable decoration for a paragraph with no comments', () => {
    const doc = makeFakeDoc([{ pos: 0, type: 'paragraph', size: 5 }]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([{ pos: 0, startLine: 0 }]),
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => d.type === 'node' && (d.spec as any)?.class === 'llm-line-commentable',
    );
    expect(llmDecos).toHaveLength(1);
    expect(llmDecos[0]).toEqual(expect.objectContaining({ from: 0, to: 5 }));
    const spec = llmDecos[0].spec as any;
    expect(spec['data-llm-count']).toBeUndefined();
    expect(spec['data-llm-line']).toBeUndefined();
  });

  it('G3: review mode active + llm-assist also active → only review-mode decorations are emitted (no llm-line-* classes)', () => {
    // Review mode wins. Set up the diff-highlight path by mocking findPosForLine.
    activePosLookup.set(0, 10); // 1-indexed line 1 → 0-indexed 0 → pos 10
    const doc = {
      nodeAt(pos: number) {
        if (pos === 10) return { type: { name: 'paragraph' }, nodeSize: 4 };
        return null;
      },
    };

    getDecorations(
      {
        reviewMode: true,
        diffHighlightLines: [1],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([{ pos: 0, startLine: 0 }]),
        llmAssistActive: false,
        llmComments: [],
      },
      doc,
    );

    const diffDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'diff-highlight',
    );
    const llmDecos = createdDecorations.filter(
      (d) => {
        const cls = (d.spec as any)?.class as string | undefined;
        return cls === 'llm-line-commentable' || cls === 'llm-line-commented';
      },
    );
    expect(diffDecos).toHaveLength(1);
    expect(llmDecos).toHaveLength(0);
  });

  it('G4: heading and paragraph both decorated as commentable', () => {
    const doc = makeFakeDoc([
      { pos: 0, type: 'heading', size: 5 },
      { pos: 5, type: 'paragraph', size: 10 },
    ]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([
          { pos: 0, startLine: 0 },
          { pos: 5, startLine: 1 },
        ]),
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commentable',
    );
    expect(llmDecos).toHaveLength(2);
    expect(llmDecos.map((d) => ({ from: d.from, to: d.to }))).toEqual([
      { from: 0, to: 5 },
      { from: 5, to: 15 },
    ]);
  });

  it('G5: listItem is decorated, bulletList container is not', () => {
    const doc = makeFakeDoc([
      { pos: 0, type: 'bulletList', size: 20 },
      { pos: 1, type: 'listItem', size: 18 },
    ]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([
          { pos: 0, startLine: 0 },
          { pos: 1, startLine: 0 },
        ]),
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commentable',
    );
    expect(llmDecos).toHaveLength(1);
    expect(llmDecos[0]).toEqual(expect.objectContaining({ from: 1, to: 19 }));
  });

  it('G6: table is decorated whole, tableRow and tableCell are not', () => {
    const doc = makeFakeDoc([
      { pos: 0, type: 'table', size: 50 },
      { pos: 1, type: 'tableRow', size: 48 },
      { pos: 2, type: 'tableCell', size: 46 },
    ]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([
          { pos: 0, startLine: 0 },
          { pos: 1, startLine: 0 },
          { pos: 2, startLine: 0 },
        ]),
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commentable',
    );
    expect(llmDecos).toHaveLength(1);
    expect(llmDecos[0]).toEqual(expect.objectContaining({ from: 0, to: 50 }));
  });

  it('G7: blockquote container is skipped, inner paragraph is decorated', () => {
    const doc = makeFakeDoc([
      { pos: 0, type: 'blockquote', size: 15 },
      { pos: 1, type: 'paragraph', size: 13 },
    ]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([
          { pos: 0, startLine: 0 },
          { pos: 1, startLine: 0 },
        ]),
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commentable',
    );
    expect(llmDecos).toHaveLength(1);
    expect(llmDecos[0]).toEqual(expect.objectContaining({ from: 1, to: 14 }));
  });

  it('G8: horizontalRule produces zero decorations', () => {
    const doc = makeFakeDoc([{ pos: 0, type: 'horizontalRule', size: 1 }]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([{ pos: 0, startLine: 0 }]),
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class?.startsWith?.('llm-line-'),
    );
    expect(llmDecos).toHaveLength(0);
  });

  it('G9: line at L2 with one line-comment + two text-comments → llm-line-commented with count=3', () => {
    const doc = makeFakeDoc([{ pos: 0, type: 'paragraph', size: 8 }]);
    const lineComment = makeLlmComment({ kind: 'line', startLine: 2, endLine: 2, body: 'line note' });
    const textComment1 = makeLlmComment({ kind: 'text', startLine: 2, endLine: 2, body: 'span 1' });
    const textComment2 = makeLlmComment({ kind: 'text', startLine: 1, endLine: 3, body: 'span 2 covering L2' });

    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([{ pos: 0, startLine: 1 }]), // 0-indexed 1 → 1-indexed 2
        llmAssistActive: true,
        llmComments: [lineComment, textComment1, textComment2],
      },
      doc,
    );

    const llmDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commented',
    );
    expect(llmDecos).toHaveLength(1);
    const spec = llmDecos[0].spec as any;
    expect(spec['data-llm-count']).toBe('3');
    expect(spec['data-llm-line']).toBe('2');
  });

  it('G10: decoration class flips from commentable → commented when a comment is added on a re-build', () => {
    const doc = makeFakeDoc([{ pos: 0, type: 'paragraph', size: 5 }]);
    const lineMap = makeFakeLineMap([{ pos: 0, startLine: 0 }]); // 1-indexed L1

    // First call — empty comments → commentable.
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap,
        llmAssistActive: true,
        llmComments: [],
      },
      doc,
    );

    let commentableDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commentable',
    );
    let commentedDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commented',
    );
    expect(commentableDecos).toHaveLength(1);
    expect(commentedDecos).toHaveLength(0);

    // Reset and re-build with one comment on L1.
    createdDecorations.length = 0;
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap,
        llmAssistActive: true,
        llmComments: [makeLlmComment({ kind: 'line', startLine: 1, endLine: 1, body: 'note' })],
      },
      doc,
    );

    commentableDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commentable',
    );
    commentedDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commented',
    );
    expect(commentableDecos).toHaveLength(0);
    expect(commentedDecos).toHaveLength(1);
    expect((commentedDecos[0].spec as any)['data-llm-count']).toBe('1');
    expect((commentedDecos[0].spec as any)['data-llm-line']).toBe('1');
  });

  it('G11: 0-indexed startLine=4 produces data-llm-line="5" (1-indexed at the boundary)', () => {
    const doc = makeFakeDoc([{ pos: 0, type: 'paragraph', size: 6 }]);
    getDecorations(
      {
        reviewMode: false,
        diffHighlightLines: [],
        threads: [],
        pendingComments: [],
        lineMap: makeFakeLineMap([{ pos: 0, startLine: 4, endLine: 5 }]),
        llmAssistActive: true,
        llmComments: [makeLlmComment({ kind: 'line', startLine: 5, endLine: 5, body: 'x' })],
      },
      doc,
    );

    const commentedDecos = createdDecorations.filter(
      (d) => (d.spec as any)?.class === 'llm-line-commented',
    );
    expect(commentedDecos).toHaveLength(1);
    expect((commentedDecos[0].spec as any)['data-llm-line']).toBe('5');
    expect((commentedDecos[0].spec as any)['data-llm-count']).toBe('1');
  });
});

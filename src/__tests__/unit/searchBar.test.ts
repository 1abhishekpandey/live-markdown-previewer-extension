// @vitest-environment happy-dom

vi.mock('@tiptap/pm/state', () => ({
  Plugin: class {},
  PluginKey: class {
    getState() { return undefined; }
  },
  TextSelection: { create: vi.fn() },
}));

vi.mock('@tiptap/pm/view', () => ({
  Decoration: { inline: vi.fn((from: number, to: number, spec: object) => ({ from, to, spec })) },
  DecorationSet: { empty: {}, create: vi.fn() },
}));

vi.mock('@tiptap/core', () => ({
  Editor: class {},
  Extension: { create: vi.fn((config: unknown) => config) },
}));

import { findMatches, updateCountLabel } from '../../webview/searchBar';

interface TextNode { text: string; pos: number; }

function makeDoc(textNodes: TextNode[]) {
  return {
    descendants(fn: (node: { isText: boolean; text: string }, pos: number) => void) {
      for (const n of textNodes) {
        fn({ isText: true, text: n.text }, n.pos);
      }
    },
  };
}

function makeState(query: string, matches: Array<{from: number; to: number}>, activeIndex: number) {
  return { query, matches, activeIndex, decorations: {} as any };
}

describe('findMatches', () => {
  it('returns empty array for empty query', () => {
    const doc = makeDoc([{ text: 'hello world', pos: 0 }]);
    expect(findMatches(doc as any, '')).toEqual([]);
  });

  it('returns empty array when no match found', () => {
    const doc = makeDoc([{ text: 'hello world', pos: 0 }]);
    expect(findMatches(doc as any, 'xyz')).toEqual([]);
  });

  it('returns single match at correct position', () => {
    const doc = makeDoc([{ text: 'hello world', pos: 0 }]);
    const result = findMatches(doc as any, 'hello');
    expect(result).toEqual([{ from: 0, to: 5 }]);
  });

  it('returns multiple matches in same node', () => {
    const doc = makeDoc([{ text: 'hello hello', pos: 0 }]);
    const result = findMatches(doc as any, 'hello');
    expect(result).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
    ]);
  });

  it('returns matches across multiple nodes with correct offsets', () => {
    // Node 1: text "hello" at pos 0 → match from 0 to 5
    // Node 2: text "hello" at pos 10 → match from 10 to 15
    const doc = makeDoc([
      { text: 'hello', pos: 0 },
      { text: 'hello', pos: 10 },
    ]);
    const result = findMatches(doc as any, 'hello');
    expect(result).toEqual([
      { from: 0, to: 5 },
      { from: 10, to: 15 },
    ]);
  });

  it('is case-insensitive: matches lowercase query against uppercase text', () => {
    const doc = makeDoc([{ text: 'HELLO WORLD', pos: 0 }]);
    const result = findMatches(doc as any, 'hello');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 0, to: 5 });
  });

  it('is case-insensitive: matches uppercase query against lowercase text', () => {
    const doc = makeDoc([{ text: 'hello world', pos: 0 }]);
    const result = findMatches(doc as any, 'HELLO');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 0, to: 5 });
  });

  it('accounts for pos offset: node at pos 10 returns match starting at 10', () => {
    const doc = makeDoc([{ text: 'hello', pos: 10 }]);
    const result = findMatches(doc as any, 'hello');
    expect(result).toEqual([{ from: 10, to: 15 }]);
  });

  it('accounts for pos offset: mid-node match uses correct absolute position', () => {
    // text "world hello" at pos 5 → "hello" starts at index 6 in text → absolute: 5 + 6 = 11
    const doc = makeDoc([{ text: 'world hello', pos: 5 }]);
    const result = findMatches(doc as any, 'hello');
    expect(result).toEqual([{ from: 11, to: 16 }]);
  });
});

describe('updateCountLabel', () => {
  it('clears label when state is undefined', () => {
    const countEl = document.createElement('span');
    updateCountLabel(countEl, undefined);
    expect(countEl.textContent).toBe('');
  });

  it('clears label when matches is empty and query is empty', () => {
    const countEl = document.createElement('span');
    updateCountLabel(countEl, makeState('', [], -1));
    expect(countEl.textContent).toBe('');
  });

  it('shows "No results" when matches is empty but query is non-empty', () => {
    const countEl = document.createElement('span');
    updateCountLabel(countEl, makeState('foo', [], -1));
    expect(countEl.textContent).toBe('No results');
  });

  it('shows "1/3" when 3 matches and activeIndex is 0', () => {
    const countEl = document.createElement('span');
    const matches = [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }];
    updateCountLabel(countEl, makeState('hello', matches, 0));
    expect(countEl.textContent).toBe('1/3');
  });

  it('shows "3/3" when 3 matches and activeIndex is 2', () => {
    const countEl = document.createElement('span');
    const matches = [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }];
    updateCountLabel(countEl, makeState('hello', matches, 2));
    expect(countEl.textContent).toBe('3/3');
  });

  it('shows "2/3" when 3 matches and activeIndex is 1', () => {
    const countEl = document.createElement('span');
    const matches = [{ from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 }];
    updateCountLabel(countEl, makeState('hello', matches, 1));
    expect(countEl.textContent).toBe('2/3');
  });
});

describe('navigation index wrapping (pure math)', () => {
  it('next from last index wraps to 0', () => {
    const current = 2;
    const total = 3;
    const next = (current + 1) % total;
    expect(next).toBe(0);
  });

  it('prev from index 0 wraps to last', () => {
    const current = 0;
    const total = 3;
    const prev = (current - 1 + total) % total;
    expect(prev).toBe(2);
  });

  it('next from middle increments normally', () => {
    expect((1 + 1) % 3).toBe(2);
  });

  it('prev from middle decrements normally', () => {
    expect((1 - 1 + 3) % 3).toBe(0);
  });
});

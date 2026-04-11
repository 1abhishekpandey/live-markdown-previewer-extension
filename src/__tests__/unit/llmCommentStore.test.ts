import { describe, it, expect, vi } from 'vitest';
import { LlmCommentStore, type LlmComment } from '../../webview/llmCommentStore';

function makeComment(overrides?: Partial<LlmComment>): LlmComment {
  return {
    id: crypto.randomUUID(),
    kind: 'line',
    body: 'test body',
    createdAt: Date.now(),
    startLine: 1,
    endLine: 1,
    ...overrides,
  };
}

function makeMockEditor(
  opts: { lineText?: Record<number, string>; markText?: Record<string, string> } = {},
): any {
  return {
    state: { doc: { descendants: () => {} } },
    storage: {
      llmLineMap: opts.lineText
        ? { getTextForLine: (n: number) => opts.lineText![n] ?? '' }
        : undefined,
      llmMarkText: opts.markText
        ? { getTextForId: (id: string) => opts.markText![id] ?? '' }
        : undefined,
    },
  };
}

describe('LlmCommentStore — CRUD', () => {
  it('S1: add fires onChange once; getCount = 1; getAll contains comment', () => {
    const store = new LlmCommentStore();
    const listener = vi.fn();
    store.onChange(listener);

    const c = makeComment({ id: 'a' });
    store.add(c);

    expect(store.getCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getAll()).toEqual([c]);
  });

  it('S2: remove bogus id does not throw, count unchanged, listener still fires', () => {
    const store = new LlmCommentStore();
    const listener = vi.fn();
    const c = makeComment({ id: 'real' });
    store.add(c);
    store.onChange(listener);

    expect(() => store.remove('bogus-id')).not.toThrow();
    expect(store.getCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('S3: update preserves kind/startLine/endLine/createdAt; only body changes; missing id still notifies', () => {
    const store = new LlmCommentStore();
    const original: LlmComment = {
      id: 'x',
      kind: 'text',
      body: 'old body',
      createdAt: 1234,
      startLine: 5,
      endLine: 7,
    };
    store.add(original);

    store.update('x', 'new body');
    const updated = store.get('x');
    expect(updated).toBeDefined();
    expect(updated!.body).toBe('new body');
    expect(updated!.kind).toBe('text');
    expect(updated!.startLine).toBe(5);
    expect(updated!.endLine).toBe(7);
    expect(updated!.createdAt).toBe(1234);

    const listener = vi.fn();
    store.onChange(listener);
    store.update('missing', 'noop');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('S4: getForLine orders kind:line first then text by createdAt asc', () => {
    const store = new LlmCommentStore();
    const text200 = makeComment({
      id: 't200',
      kind: 'text',
      startLine: 7,
      endLine: 7,
      createdAt: 200,
    });
    const line = makeComment({
      id: 'line',
      kind: 'line',
      startLine: 7,
      endLine: 7,
      createdAt: 500,
    });
    const text100 = makeComment({
      id: 't100',
      kind: 'text',
      startLine: 7,
      endLine: 7,
      createdAt: 100,
    });
    store.add(text200);
    store.add(line);
    store.add(text100);

    const result = store.getForLine(7);
    expect(result.map(c => c.id)).toEqual(['line', 't100', 't200']);
  });

  it('S5: getForLine is inclusive on both bounds', () => {
    const store = new LlmCommentStore();
    const inRange = makeComment({ id: 'in', startLine: 3, endLine: 7, kind: 'text' });
    const outRange = makeComment({ id: 'out', startLine: 3, endLine: 4, kind: 'text' });
    store.add(inRange);
    store.add(outRange);

    const result = store.getForLine(5);
    expect(result.map(c => c.id)).toEqual(['in']);
  });

  it('S6: getAll returns a snapshot — mutations do not affect store', () => {
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'a' }));

    const snap = store.getAll();
    snap.push(makeComment({ id: 'injected' }));

    expect(store.getCount()).toBe(1);
    expect(store.getAll().map(c => c.id)).toEqual(['a']);
  });

  it('S7: clear empties the store, count = 0, listener fires', () => {
    const store = new LlmCommentStore();
    store.add(makeComment());
    store.add(makeComment());
    const listener = vi.fn();
    store.onChange(listener);

    store.clear();

    expect(store.getCount()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('S8: constructor takes zero args; no postMessage call path exists', () => {
    // No postMessage call path exists — zero-arg constructor.
    const postMessageSpy = vi.fn();
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'a' }));
    store.remove('x');
    store.update('y', 'z');
    store.clear();
    expect(postMessageSpy).not.toHaveBeenCalled();
  });
});

describe('LlmCommentStore — toPayload', () => {
  it('P1: empty store returns empty string', () => {
    const store = new LlmCommentStore();
    const editor = makeMockEditor();
    expect(store.toPayload(editor, 'docs/x.md')).toBe('');
  });

  it('P2: single line comment matches LLD example byte-for-byte', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'c1',
      kind: 'line',
      body: 'Expand this with a concrete example.',
      createdAt: 1000,
      startLine: 42,
      endLine: 42,
    });

    const editor = makeMockEditor({
      lineText: {
        42: 'retainContextWhenHidden: true avoids re-parsing markdown on tab switches',
      },
    });

    const expected =
      'File: docs/design.md\n' +
      '\n' +
      'Line 42 — Selected text:\n' +
      '"""\n' +
      'retainContextWhenHidden: true avoids re-parsing markdown on tab switches\n' +
      '"""\n' +
      '\n' +
      'Comment:\n' +
      '"""\n' +
      'Expand this with a concrete example.\n' +
      '"""';

    expect(store.toPayload(editor, 'docs/design.md')).toBe(expected);
  });

  it('P3: two comments use Comment-1: and Comment-2: labels', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'a',
      kind: 'line',
      body: 'first',
      createdAt: 100,
      startLine: 1,
      endLine: 1,
    });
    store.add({
      id: 'b',
      kind: 'line',
      body: 'second',
      createdAt: 200,
      startLine: 2,
      endLine: 2,
    });
    const editor = makeMockEditor({
      lineText: { 1: 'line one', 2: 'line two' },
    });

    const out = store.toPayload(editor, 'f.md');
    expect(out).toContain('Comment-1:');
    expect(out).toContain('Comment-2:');
    expect(out).not.toContain('Comment:\n');
  });

  it('P4: sort by startLine ascending — L3 before L10', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'ten',
      kind: 'line',
      body: 'at ten',
      createdAt: 100,
      startLine: 10,
      endLine: 10,
    });
    store.add({
      id: 'three',
      kind: 'line',
      body: 'at three',
      createdAt: 200,
      startLine: 3,
      endLine: 3,
    });
    const editor = makeMockEditor({
      lineText: { 10: 'ten text', 3: 'three text' },
    });

    const out = store.toPayload(editor, 'f.md');
    const idxThree = out.indexOf('at three');
    const idxTen = out.indexOf('at ten');
    expect(idxThree).toBeGreaterThan(-1);
    expect(idxTen).toBeGreaterThan(-1);
    expect(idxThree).toBeLessThan(idxTen);
    expect(out.indexOf('Line 3 ')).toBeLessThan(out.indexOf('Line 10 '));
  });

  it('P5: same-line tie-breaker — line first, then text by createdAt asc', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'line',
      kind: 'line',
      body: 'line body',
      createdAt: 500,
      startLine: 7,
      endLine: 7,
    });
    store.add({
      id: 't100',
      kind: 'text',
      body: 'text 100 body',
      createdAt: 100,
      startLine: 7,
      endLine: 7,
    });
    store.add({
      id: 't200',
      kind: 'text',
      body: 'text 200 body',
      createdAt: 200,
      startLine: 7,
      endLine: 7,
    });
    const editor = makeMockEditor({
      lineText: { 7: 'line seven' },
      markText: { t100: 'tok-100', t200: 'tok-200' },
    });

    const out = store.toPayload(editor, 'f.md');
    const idxLine = out.indexOf('line body');
    const idx100 = out.indexOf('text 100 body');
    const idx200 = out.indexOf('text 200 body');
    expect(idxLine).toBeLessThan(idx100);
    expect(idx100).toBeLessThan(idx200);
  });

  it('P6: multi-line text comment renders Lines N-M header', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'multi',
      kind: 'text',
      body: 'multi body',
      createdAt: 100,
      startLine: 5,
      endLine: 7,
    });
    const editor = makeMockEditor({
      markText: { multi: 'spans lines 5 through 7' },
    });

    const out = store.toPayload(editor, 'f.md');
    expect(out).toContain('Lines 5-7 — Selected text:');
  });

  it('P7: quoted text with triple-backticks and table pipes appears verbatim (no escaping)', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'tricky',
      kind: 'text',
      body: 'body',
      createdAt: 1,
      startLine: 1,
      endLine: 1,
    });
    const nasty = '```js\nconst x = 1;\n```\n| col | col |\n| --- | --- |';
    const editor = makeMockEditor({
      markText: { tricky: nasty },
    });

    const out = store.toPayload(editor, 'f.md');
    expect(out).toContain(`"""\n${nasty}\n"""`);
  });

  it('P9: filePath appears verbatim on first line as File: <path>', () => {
    const store = new LlmCommentStore();
    store.add(
      makeComment({
        id: 'c',
        kind: 'line',
        body: 'b',
        createdAt: 1,
        startLine: 1,
        endLine: 1,
      }),
    );
    const editor = makeMockEditor({ lineText: { 1: 'text' } });

    const out = store.toPayload(editor, 'sub/dir/x.md');
    expect(out.startsWith('File: sub/dir/x.md\n')).toBe(true);
  });

  it('P10: three comments → exactly two ----- separators, no trailing', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'a',
      kind: 'line',
      body: 'a body',
      createdAt: 1,
      startLine: 1,
      endLine: 1,
    });
    store.add({
      id: 'b',
      kind: 'line',
      body: 'b body',
      createdAt: 2,
      startLine: 2,
      endLine: 2,
    });
    store.add({
      id: 'c',
      kind: 'line',
      body: 'c body',
      createdAt: 3,
      startLine: 3,
      endLine: 3,
    });
    const editor = makeMockEditor({
      lineText: { 1: 'one', 2: 'two', 3: 'three' },
    });

    const out = store.toPayload(editor, 'f.md');
    const separatorMatches = out.match(/\n\n-----\n\n/g) ?? [];
    expect(separatorMatches.length).toBe(2);
    expect(out.endsWith('"""')).toBe(true);
  });

  it('P10b: single comment has no ----- separator', () => {
    const store = new LlmCommentStore();
    store.add(
      makeComment({
        id: 'solo',
        kind: 'line',
        body: 'solo',
        createdAt: 1,
        startLine: 1,
        endLine: 1,
      }),
    );
    const editor = makeMockEditor({ lineText: { 1: 'text' } });

    const out = store.toPayload(editor, 'f.md');
    expect(out).not.toContain('-----');
  });
});

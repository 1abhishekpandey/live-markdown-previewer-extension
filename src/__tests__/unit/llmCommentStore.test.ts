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
      'File: `docs/design.md`\n' +
      '\n' +
      'Comment — Line 42:\n' +
      'Selected text:\n' +
      '"""\n' +
      'retainContextWhenHidden: true avoids re-parsing markdown on tab switches\n' +
      '"""\n' +
      '\n' +
      'Feedback:\n' +
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
    expect(out).toContain('Comment 1 — ');
    expect(out).toContain('Comment 2 — ');
    expect(out).toContain('Feedback-1:');
    expect(out).toContain('Feedback-2:');
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
    expect(out.indexOf('Line 3:')).toBeLessThan(out.indexOf('Line 10:'));
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
    expect(out).toContain('Comment — Lines 5-7:');
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
    expect(out.startsWith('File: `sub/dir/x.md`\n')).toBe(true);
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
    const separatorMatches = out.match(/\n\n---\n\n/g) ?? [];
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
    expect(out).not.toContain('\n\n---\n\n');
  });
});

describe('LlmCommentStore — toLinePayload', () => {
  it('returns empty string when no comments on line', () => {
    const store = new LlmCommentStore();
    const editor = makeMockEditor();
    const payload = store.toLinePayload(5, editor, 'test.md');
    expect(payload).toBe('');
  });

  it('produces structured format for single comment', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'c1',
      kind: 'line',
      body: 'a note',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    const editor = makeMockEditor({ lineText: { 5: 'some line text' } });
    const payload = store.toLinePayload(5, editor, 'test.md');
    expect(payload).toContain('File: `test.md`');
    expect(payload).toContain('Comment — Line 5:');
    expect(payload).toContain('Feedback:');
    expect(payload).toContain('a note');
    // Single comment: no numbering
    expect(payload).not.toContain('Comment 1');
    expect(payload).not.toContain('Feedback-1');
  });

  it('produces numbered blocks for multiple comments on same line', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'c1',
      kind: 'line',
      body: 'first note',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'c2',
      kind: 'line',
      body: 'second note',
      createdAt: 200,
      startLine: 5,
      endLine: 5,
    });
    const editor = makeMockEditor({ lineText: { 5: 'some line text' } });
    const payload = store.toLinePayload(5, editor, 'test.md');
    expect(payload).toContain('File: `test.md`');
    expect(payload).toContain('Comment 1 — Line 5:');
    expect(payload).toContain('Feedback-1:');
    expect(payload).toContain('first note');
    expect(payload).toContain('Comment 2 — Line 5:');
    expect(payload).toContain('Feedback-2:');
    expect(payload).toContain('second note');
    expect(payload).toContain('---');
  });

  it('filters to the requested line only — ignores comments on other lines', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'on-5',
      kind: 'line',
      body: 'on line 5',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'on-9',
      kind: 'line',
      body: 'on line 9',
      createdAt: 200,
      startLine: 9,
      endLine: 9,
    });
    const editor = makeMockEditor({ lineText: { 5: 'text five', 9: 'text nine' } });
    const payload = store.toLinePayload(5, editor, 'test.md');
    expect(payload).toContain('on line 5');
    expect(payload).not.toContain('on line 9');
  });
});

describe('LlmCommentStore — threading', () => {
  it('T1: getForLine excludes replies (returns only roots)', () => {
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'root', startLine: 5, endLine: 5 }));
    store.add(makeComment({ id: 'reply-1', startLine: 5, endLine: 5, parentId: 'root' }));
    store.add(makeComment({ id: 'reply-2', startLine: 5, endLine: 5, parentId: 'root' }));

    const roots = store.getForLine(5);
    expect(roots.map(c => c.id)).toEqual(['root']);
  });

  it('T2: getReplies returns replies sorted by createdAt', () => {
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'root', startLine: 5, endLine: 5, createdAt: 100 }));
    store.add(makeComment({ id: 'r2', startLine: 5, endLine: 5, parentId: 'root', createdAt: 300 }));
    store.add(makeComment({ id: 'r1', startLine: 5, endLine: 5, parentId: 'root', createdAt: 200 }));

    const replies = store.getReplies('root');
    expect(replies.map(c => c.id)).toEqual(['r1', 'r2']);
  });

  it('T3: getReplies returns empty array for root with no replies', () => {
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'root', startLine: 5, endLine: 5 }));

    expect(store.getReplies('root')).toEqual([]);
  });

  it('T4: removing a root cascade-deletes its replies', () => {
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'root', startLine: 5, endLine: 5 }));
    store.add(makeComment({ id: 'r1', startLine: 5, endLine: 5, parentId: 'root' }));
    store.add(makeComment({ id: 'r2', startLine: 5, endLine: 5, parentId: 'root' }));
    store.add(makeComment({ id: 'other', startLine: 9, endLine: 9 }));

    store.remove('root');

    expect(store.getCount()).toBe(1);
    expect(store.get('root')).toBeUndefined();
    expect(store.get('r1')).toBeUndefined();
    expect(store.get('r2')).toBeUndefined();
    expect(store.get('other')).toBeDefined();
  });

  it('T5: removing a reply only removes that reply, not the root', () => {
    const store = new LlmCommentStore();
    store.add(makeComment({ id: 'root', startLine: 5, endLine: 5 }));
    store.add(makeComment({ id: 'r1', startLine: 5, endLine: 5, parentId: 'root' }));
    store.add(makeComment({ id: 'r2', startLine: 5, endLine: 5, parentId: 'root' }));

    store.remove('r1');

    expect(store.getCount()).toBe(2);
    expect(store.get('root')).toBeDefined();
    expect(store.get('r1')).toBeUndefined();
    expect(store.get('r2')).toBeDefined();
  });

  it('T6: toPayload combines thread feedback bodies with double newline', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'root',
      kind: 'line',
      body: 'root feedback',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'r1',
      kind: 'line',
      body: 'reply one',
      createdAt: 200,
      startLine: 5,
      endLine: 5,
      parentId: 'root',
    });
    store.add({
      id: 'r2',
      kind: 'line',
      body: 'reply two',
      createdAt: 300,
      startLine: 5,
      endLine: 5,
      parentId: 'root',
    });

    const editor = makeMockEditor({ lineText: { 5: 'some text' } });
    const out = store.toPayload(editor, 'f.md');

    // Single block (one root with replies = one Comment block)
    expect(out).toContain('Comment — Line 5:');
    expect(out).not.toContain('Comment 1');

    // Combined feedback
    expect(out).toContain('root feedback\n\nreply one\n\nreply two');

    // No --- separator (single thread = single block)
    expect(out).not.toContain('\n\n---\n\n');
  });

  it('T7: toPayload with multiple threads uses numbered blocks with --- separators', () => {
    const store = new LlmCommentStore();
    // Thread 1 on line 5
    store.add({
      id: 'root-a',
      kind: 'line',
      body: 'first thread root',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'reply-a',
      kind: 'line',
      body: 'first thread reply',
      createdAt: 150,
      startLine: 5,
      endLine: 5,
      parentId: 'root-a',
    });
    // Thread 2 on line 10
    store.add({
      id: 'root-b',
      kind: 'line',
      body: 'second thread root',
      createdAt: 200,
      startLine: 10,
      endLine: 10,
    });

    const editor = makeMockEditor({ lineText: { 5: 'five', 10: 'ten' } });
    const out = store.toPayload(editor, 'f.md');

    expect(out).toContain('Comment 1 — Line 5:');
    expect(out).toContain('Feedback-1:');
    expect(out).toContain('first thread root\n\nfirst thread reply');
    expect(out).toContain('Comment 2 — Line 10:');
    expect(out).toContain('Feedback-2:');
    expect(out).toContain('second thread root');
    expect(out).toContain('\n\n---\n\n');
  });

  it('T8: toLinePayload combines thread feedback for a single line', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'root',
      kind: 'line',
      body: 'root body',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'r1',
      kind: 'line',
      body: 'reply body',
      createdAt: 200,
      startLine: 5,
      endLine: 5,
      parentId: 'root',
    });

    const editor = makeMockEditor({ lineText: { 5: 'line text' } });
    const payload = store.toLinePayload(5, editor, 'test.md');
    expect(payload).toContain('root body\n\nreply body');
    expect(payload).toContain('File: `test.md`');
    expect(payload).toContain('Comment — Line 5:');
  });

  it('T9: toThreadPayload copies only the specified thread', () => {
    const store = new LlmCommentStore();
    // Thread A on line 5
    store.add({
      id: 'root-a',
      kind: 'line',
      body: 'thread A root',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'reply-a',
      kind: 'line',
      body: 'thread A reply',
      createdAt: 150,
      startLine: 5,
      endLine: 5,
      parentId: 'root-a',
    });
    // Thread B on same line
    store.add({
      id: 'root-b',
      kind: 'line',
      body: 'thread B root',
      createdAt: 200,
      startLine: 5,
      endLine: 5,
    });

    const editor = makeMockEditor({ lineText: { 5: 'line five' } });

    const payloadA = store.toThreadPayload('root-a', editor, 'f.md');
    expect(payloadA).toContain('thread A root\n\nthread A reply');
    expect(payloadA).not.toContain('thread B');
    // Single thread — un-numbered
    expect(payloadA).toContain('Comment — Line 5:');
    expect(payloadA).not.toContain('Comment 1');

    const payloadB = store.toThreadPayload('root-b', editor, 'f.md');
    expect(payloadB).toContain('thread B root');
    expect(payloadB).not.toContain('thread A');
  });

  it('T10: toThreadPayload returns empty for unknown or reply id', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'root',
      kind: 'line',
      body: 'root',
      createdAt: 100,
      startLine: 5,
      endLine: 5,
    });
    store.add({
      id: 'reply',
      kind: 'line',
      body: 'reply',
      createdAt: 200,
      startLine: 5,
      endLine: 5,
      parentId: 'root',
    });

    const editor = makeMockEditor({ lineText: { 5: 'text' } });

    expect(store.toThreadPayload('nonexistent', editor, 'f.md')).toBe('');
    // reply id is not a root, so should return empty
    expect(store.toThreadPayload('reply', editor, 'f.md')).toBe('');
  });

  it('T11: text comment extracts only marked text, not full line', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'txt-1',
      kind: 'text',
      body: 'fix this wording',
      createdAt: 100,
      startLine: 3,
      endLine: 3,
    });

    // markText mock returns only the selected portion; lineText has the full line
    const editor = makeMockEditor({
      lineText: { 3: 'The quick brown fox jumps over the lazy dog' },
      markText: { 'txt-1': 'brown fox' },
    });

    // Even with rawMarkdown available, text comments should use mark text
    const rawMarkdown = 'line one\nline two\nThe quick brown fox jumps over the lazy dog\nline four';
    const out = store.toPayload(editor, 'f.md', null, rawMarkdown);

    // Should contain only the selected text, not the full line
    expect(out).toContain('"""\nbrown fox\n"""');
    expect(out).not.toContain('The quick brown fox');
  });

  it('T12: line comment still extracts full line from rawMarkdown', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'line-1',
      kind: 'line',
      body: 'expand this',
      createdAt: 100,
      startLine: 3,
      endLine: 3,
    });

    const editor = makeMockEditor({ lineText: { 3: 'The quick brown fox' } });
    const rawMarkdown = 'line one\nline two\nThe quick brown fox\nline four';
    const out = store.toPayload(editor, 'f.md', null, rawMarkdown);

    // Line comment uses full line from rawMarkdown
    expect(out).toContain('"""\nThe quick brown fox\n"""');
  });

  it('T13: text comment with no mark text but with selectedText uses selectedText in payload', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'txt-code',
      kind: 'text',
      body: 'fix naming',
      createdAt: 100,
      startLine: 3,
      endLine: 3,
      selectedText: 'FLAG_STOPPED',
    });

    const editor = makeMockEditor({
      lineText: { 3: 'package into the FLAG_STOPPED state' },
      // No markText for 'txt-code'
    });

    const out = store.toPayload(editor, 'f.md');
    expect(out).toContain('"""\nFLAG_STOPPED\n"""');
    expect(out).not.toContain('package into');
  });

  it('T14: text comment with both mark text and selectedText prefers mark text', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'txt-both',
      kind: 'text',
      body: 'note',
      createdAt: 100,
      startLine: 3,
      endLine: 3,
      selectedText: 'stored selection',
    });

    const editor = makeMockEditor({
      markText: { 'txt-both': 'mark text wins' },
      lineText: { 3: 'full line' },
    });

    const out = store.toPayload(editor, 'f.md');
    expect(out).toContain('"""\nmark text wins\n"""');
    expect(out).not.toContain('stored selection');
  });

  it('T15: text comment with neither mark text nor selectedText falls through to line extraction', () => {
    const store = new LlmCommentStore();
    store.add({
      id: 'txt-none',
      kind: 'text',
      body: 'note',
      createdAt: 100,
      startLine: 3,
      endLine: 3,
      // no selectedText
    });

    const editor = makeMockEditor({
      // No markText for 'txt-none'
      lineText: { 3: 'full line text' },
    });

    const rawMarkdown = 'line one\nline two\nfull line text\nline four';
    const out = store.toPayload(editor, 'f.md', null, rawMarkdown);
    expect(out).toContain('"""\nfull line text\n"""');
  });
});

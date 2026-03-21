import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import {
  fetchDiff,
  parseDiffForFile,
  validateLineMapping,
  validateMultiLineMapping,
} from '../../gh/diffLineMapper';
import type { PrInfo, LineMapping } from '../../sync/commentTypes';

beforeEach(() => {
  mockExecFile.mockReset();
});

const makePr = (number: number): PrInfo => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  headRefName: 'feat/branch',
  baseRefName: 'main',
  owner: 'owner',
  repo: 'repo',
});

describe('fetchDiff', () => {
  it('calls execGh with correct args and returns stdout', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, 'diff --git a/file.md b/file.md\n@@ -1,3 +1,4 @@\n context\n+added\n', '');
      },
    );

    const result = await fetchDiff(makePr(42), '/repo');
    expect(result).toContain('diff --git');
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['pr', 'diff', '42'],
      { cwd: '/repo' },
      expect.any(Function),
    );
  });
});

describe('parseDiffForFile', () => {
  it('single hunk — additions only', () => {
    const diff = [
      'diff --git a/readme.md b/readme.md',
      '--- a/readme.md',
      '+++ b/readme.md',
      '@@ -1,3 +1,6 @@',
      ' line 1',
      ' line 2',
      ' line 3',
      '+added 4',
      '+added 5',
      '+added 6',
    ].join('\n');

    const mapping = parseDiffForFile(diff, 'readme.md');

    expect(mapping.addedLines).toHaveLength(3);
    expect(mapping.addedLines.map((l) => l.lineNumber)).toEqual([4, 5, 6]);
    expect(mapping.addedLines.every((l) => l.type === 'added')).toBe(true);

    // Context lines mapped (first @@ not counted, positions start at 1)
    expect(mapping.workingCopyToDiffLine.get(1)).toBe(1);
    expect(mapping.workingCopyToDiffLine.get(2)).toBe(2);
    expect(mapping.workingCopyToDiffLine.get(3)).toBe(3);

    // Added lines mapped
    expect(mapping.workingCopyToDiffLine.get(4)).toBe(4);
    expect(mapping.workingCopyToDiffLine.get(5)).toBe(5);
    expect(mapping.workingCopyToDiffLine.get(6)).toBe(6);

    // Reverse mapping
    expect(mapping.diffLineToWorkingCopy.get(1)).toBe(1);
    expect(mapping.diffLineToWorkingCopy.get(4)).toBe(4);
  });

  it('mixed additions and deletions', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -5,7 +5,6 @@',
      ' context 5',
      ' context 6',
      '-deleted 7',
      '-deleted 8',
      '+replaced 7',
      ' context 8',
      ' context 9',
    ].join('\n');

    const mapping = parseDiffForFile(diff, 'file.ts');

    // Context lines mapped (not in addedLines)
    expect(mapping.workingCopyToDiffLine.get(5)).toBe(1);
    expect(mapping.workingCopyToDiffLine.get(6)).toBe(2);

    // Deleted lines: diffPositions 3 and 4 are deletions, not in either map
    expect(mapping.diffLineToWorkingCopy.has(3)).toBe(false);
    expect(mapping.diffLineToWorkingCopy.has(4)).toBe(false);

    // Added line mapped and in addedLines
    expect(mapping.workingCopyToDiffLine.get(7)).toBe(5);
    expect(mapping.addedLines).toContainEqual({ lineNumber: 7, type: 'added' });

    // Remaining context
    expect(mapping.workingCopyToDiffLine.get(8)).toBe(6);
    expect(mapping.workingCopyToDiffLine.get(9)).toBe(7);

    // addedLines should only have the replaced line
    expect(mapping.addedLines).toHaveLength(1);
  });

  it('multiple hunks with cumulative diffPosition', () => {
    const diff = [
      'diff --git a/multi.ts b/multi.ts',
      '--- a/multi.ts',
      '+++ b/multi.ts',
      '@@ -1,3 +1,4 @@',
      ' line 1',
      '+inserted 2',
      ' line 2',
      ' line 3',
      '@@ -10,3 +11,4 @@',
      ' line 11',
      ' line 12',
      '+inserted 13',
      ' line 13',
    ].join('\n');

    const mapping = parseDiffForFile(diff, 'multi.ts');

    // First hunk: first @@ not counted, lines are 1-4
    expect(mapping.workingCopyToDiffLine.get(1)).toBe(1); // context
    expect(mapping.workingCopyToDiffLine.get(2)).toBe(2); // added
    expect(mapping.workingCopyToDiffLine.get(3)).toBe(3); // context
    expect(mapping.workingCopyToDiffLine.get(4)).toBe(4); // context

    // Second hunk: @@ header IS counted as pos 5, lines are 6-9
    expect(mapping.workingCopyToDiffLine.get(11)).toBe(6); // context
    expect(mapping.workingCopyToDiffLine.get(12)).toBe(7); // context
    expect(mapping.workingCopyToDiffLine.get(13)).toBe(8); // added
    expect(mapping.workingCopyToDiffLine.get(14)).toBe(9); // context

    // addedLines from both hunks
    expect(mapping.addedLines).toHaveLength(2);
    expect(mapping.addedLines.map((l) => l.lineNumber)).toEqual([2, 13]);
  });

  it('file not in diff returns empty LineMapping', () => {
    const diff = [
      'diff --git a/other.ts b/other.ts',
      '--- a/other.ts',
      '+++ b/other.ts',
      '@@ -1,2 +1,3 @@',
      ' line 1',
      '+added',
      ' line 2',
    ].join('\n');

    const mapping = parseDiffForFile(diff, 'missing.ts');
    expect(mapping.diffLineToWorkingCopy.size).toBe(0);
    expect(mapping.workingCopyToDiffLine.size).toBe(0);
    expect(mapping.addedLines).toHaveLength(0);
  });

  it('renamed file matches by b/ path', () => {
    const diff = [
      'diff --git a/old-name.md b/new-name.md',
      'similarity index 90%',
      'rename from old-name.md',
      'rename to new-name.md',
      '--- a/old-name.md',
      '+++ b/new-name.md',
      '@@ -1,2 +1,3 @@',
      ' line 1',
      '+added',
      ' line 2',
    ].join('\n');

    const mapping = parseDiffForFile(diff, 'new-name.md');
    expect(mapping.addedLines).toHaveLength(1);
    expect(mapping.addedLines[0].lineNumber).toBe(2);
    expect(mapping.workingCopyToDiffLine.get(1)).toBe(1);
    expect(mapping.workingCopyToDiffLine.get(2)).toBe(2);
    expect(mapping.workingCopyToDiffLine.get(3)).toBe(3);
  });

  it('empty diff returns empty LineMapping', () => {
    const mapping = parseDiffForFile('', 'any.ts');
    expect(mapping.diffLineToWorkingCopy.size).toBe(0);
    expect(mapping.workingCopyToDiffLine.size).toBe(0);
    expect(mapping.addedLines).toHaveLength(0);
  });

  it('skips "no newline at end of file" marker', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' line 1',
      '-old line 2',
      '+new line 2',
      '\\ No newline at end of file',
      ' line 3',
    ].join('\n');

    const mapping = parseDiffForFile(diff, 'file.ts');

    // The backslash line should not affect positions
    expect(mapping.workingCopyToDiffLine.get(1)).toBe(1); // context
    expect(mapping.workingCopyToDiffLine.get(2)).toBe(3); // added (pos 2 is deletion)
    expect(mapping.workingCopyToDiffLine.get(3)).toBe(4); // context

    expect(mapping.addedLines).toHaveLength(1);
    expect(mapping.addedLines[0].lineNumber).toBe(2);
  });
});

describe('validateLineMapping', () => {
  const mapping: LineMapping = {
    diffLineToWorkingCopy: new Map([
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    workingCopyToDiffLine: new Map([
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    addedLines: [],
  };

  it('returns diff line when workingCopyLine exists in mapping', () => {
    expect(validateLineMapping(1, mapping)).toBe(1);
    expect(validateLineMapping(2, mapping)).toBe(2);
    expect(validateLineMapping(3, mapping)).toBe(3);
  });

  it('returns null when workingCopyLine not in mapping', () => {
    expect(validateLineMapping(99, mapping)).toBeNull();
    expect(validateLineMapping(0, mapping)).toBeNull();
  });
});

describe('validateMultiLineMapping', () => {
  const mapping: LineMapping = {
    diffLineToWorkingCopy: new Map([
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 8],
    ]),
    workingCopyToDiffLine: new Map([
      [5, 1],
      [6, 2],
      [7, 3],
      [8, 4],
    ]),
    addedLines: [],
  };

  it('both end and start valid', () => {
    const result = validateMultiLineMapping(8, 5, mapping);
    expect(result).toEqual({ diffLine: 4, diffStartLine: 1 });
  });

  it('start unmappable falls back to single-line', () => {
    const result = validateMultiLineMapping(7, 99, mapping);
    expect(result).toEqual({ diffLine: 3, diffStartLine: null });
  });

  it('end unmappable returns both null', () => {
    const result = validateMultiLineMapping(99, 5, mapping);
    expect(result).toEqual({ diffLine: null, diffStartLine: null });
  });

  it('single line (startLine null)', () => {
    const result = validateMultiLineMapping(6, null, mapping);
    expect(result).toEqual({ diffLine: 2, diffStartLine: null });
  });
});

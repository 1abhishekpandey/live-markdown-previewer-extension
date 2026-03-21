import { execGh } from './ghCli';
import type { PrInfo, DiffLineInfo, LineMapping } from '../sync/commentTypes';

export async function fetchDiff(pr: PrInfo, cwd: string): Promise<string> {
  const { stdout } = await execGh(['pr', 'diff', String(pr.number)], cwd);
  return stdout;
}

export function parseDiffForFile(diffOutput: string, filePath: string): LineMapping {
  const emptyMapping: LineMapping = {
    diffLineToWorkingCopy: new Map(),
    workingCopyToDiffLine: new Map(),
    addedLines: [],
  };

  if (!diffOutput) {
    return emptyMapping;
  }

  const fileSection = findFileSection(diffOutput, filePath);
  if (!fileSection) {
    return emptyMapping;
  }

  return parseHunks(fileSection);
}

export function validateLineMapping(
  workingCopyLine: number,
  mapping: LineMapping,
): number | null {
  return mapping.workingCopyToDiffLine.get(workingCopyLine) ?? null;
}

export function validateMultiLineMapping(
  workingCopyLine: number,
  workingCopyStartLine: number | null,
  mapping: LineMapping,
): { diffLine: number | null; diffStartLine: number | null } {
  const diffLine = mapping.workingCopyToDiffLine.get(workingCopyLine) ?? null;

  if (diffLine === null) {
    return { diffLine: null, diffStartLine: null };
  }

  if (workingCopyStartLine === null) {
    return { diffLine, diffStartLine: null };
  }

  const diffStartLine = mapping.workingCopyToDiffLine.get(workingCopyStartLine) ?? null;

  if (diffStartLine === null) {
    return { diffLine, diffStartLine: null };
  }

  return { diffLine, diffStartLine };
}

function findFileSection(diffOutput: string, filePath: string): string | null {
  const sections = diffOutput.split(/^diff --git /m);

  for (const section of sections) {
    if (!section.trim()) continue;

    const headerEnd = section.indexOf('\n');
    if (headerEnd === -1) continue;

    const header = section.substring(0, headerEnd);
    const bPathMatch = header.match(/\bb\/(.+)$/);
    const aPathMatch = header.match(/^a\/(\S+)/);

    if (
      (bPathMatch && bPathMatch[1] === filePath) ||
      (aPathMatch && aPathMatch[1] === filePath)
    ) {
      return section;
    }
  }

  return null;
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;

  return {
    oldStart: parseInt(match[1], 10),
    newStart: parseInt(match[2], 10),
  };
}

function parseHunks(section: string): LineMapping {
  const diffLineToWorkingCopy = new Map<number, number>();
  const workingCopyToDiffLine = new Map<number, number>();
  const addedLines: DiffLineInfo[] = [];

  const lines = section.split('\n');
  let diffPosition = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      oldLine = hunkHeader.oldStart;
      newLine = hunkHeader.newStart;
      diffPosition++;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+')) {
      diffPosition++;
      diffLineToWorkingCopy.set(diffPosition, newLine);
      workingCopyToDiffLine.set(newLine, diffPosition);
      addedLines.push({ lineNumber: newLine, type: 'added' });
      newLine++;
    } else if (line.startsWith('-')) {
      diffPosition++;
      oldLine++;
    } else if (line.startsWith(' ')) {
      diffPosition++;
      diffLineToWorkingCopy.set(diffPosition, newLine);
      workingCopyToDiffLine.set(newLine, diffPosition);
      oldLine++;
      newLine++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — skip
    }
    // Empty/other lines: skip
  }

  return { diffLineToWorkingCopy, workingCopyToDiffLine, addedLines };
}

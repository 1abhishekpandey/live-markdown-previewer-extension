import { execFile } from 'child_process';

export class GhNotFoundError extends Error {
  constructor() {
    super('GitHub CLI (gh) not found');
    this.name = 'GhNotFoundError';
  }
}

export class GhAuthError extends Error {
  constructor() {
    super('GitHub CLI not authenticated');
    this.name = 'GhAuthError';
  }
}

export class GhApiError extends Error {
  readonly stderr: string;
  readonly exitCode: number;
  constructor(message: string, stderr: string, exitCode: number) {
    super(message);
    this.name = 'GhApiError';
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export type GhErrorCategory =
  | 'token-expired'
  | 'permission-denied'
  | 'pr-closed'
  | 'stale-sha'
  | 'rate-limited'
  | 'unknown';

export async function execGh(
  args: string[],
  cwd: string,
  stdinData?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new GhNotFoundError());
          return;
        }
        const exitCode = typeof (error as any).code === 'number' ? (error as any).code : 1;
        reject(new GhApiError(error.message, stderr, exitCode));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (stdinData && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

export async function isGhAvailable(cwd: string): Promise<boolean> {
  try {
    await execGh(['--version'], cwd);
    return true;
  } catch (err) {
    if (err instanceof GhNotFoundError) return false;
    throw err;
  }
}

export async function isGhAuthenticated(cwd: string): Promise<boolean> {
  try {
    await execGh(['auth', 'status'], cwd);
    return true;
  } catch (err) {
    if (err instanceof GhNotFoundError) throw err;
    if (err instanceof GhApiError) return false;
    throw err;
  }
}

export function classifyGhError(error: GhApiError): GhErrorCategory {
  const s = error.stderr.toLowerCase();
  if (s.includes('bad credentials') || s.includes('token expired')) return 'token-expired';
  if (s.includes('resource not accessible') || s.includes('must have write access'))
    return 'permission-denied';
  if (s.includes('pull request is closed')) return 'pr-closed';
  if (s.includes('commit_id is not part of the pull request')) return 'stale-sha';
  if (s.includes('rate limit')) return 'rate-limited';
  return 'unknown';
}

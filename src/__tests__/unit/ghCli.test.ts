import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import {
  execGh,
  isGhAvailable,
  isGhAuthenticated,
  classifyGhError,
  GhNotFoundError,
  GhApiError,
} from '../../gh/ghCli';

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('execGh', () => {
  it('returns stdout and stderr on success', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, 'hello output', 'some warning');
      },
    );

    const result = await execGh(['api', '/repos'], '/tmp');
    expect(result).toEqual({ stdout: 'hello output', stderr: 'some warning' });
    expect(mockExecFile).toHaveBeenCalledWith('gh', ['api', '/repos'], { cwd: '/tmp' }, expect.any(Function));
  });

  it('throws GhNotFoundError on ENOENT', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('spawn gh ENOENT') as any;
        err.code = 'ENOENT';
        cb(err, '', '');
      },
    );

    await expect(execGh(['--version'], '/tmp')).rejects.toThrow(GhNotFoundError);
  });

  it('throws GhApiError with stderr and exitCode on non-zero exit', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('Command failed') as any;
        err.code = 1;
        cb(err, '', 'not found');
      },
    );

    await expect(execGh(['pr', 'view'], '/tmp')).rejects.toSatisfy((err: GhApiError) => {
      expect(err).toBeInstanceOf(GhApiError);
      expect(err.stderr).toBe('not found');
      expect(err.exitCode).toBe(1);
      return true;
    });
  });
});

describe('isGhAvailable', () => {
  it('returns true when gh is found', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, 'gh version 2.40.0', '');
      },
    );

    expect(await isGhAvailable('/tmp')).toBe(true);
  });

  it('returns false when gh is not found (ENOENT)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('spawn gh ENOENT') as any;
        err.code = 'ENOENT';
        cb(err, '', '');
      },
    );

    expect(await isGhAvailable('/tmp')).toBe(false);
  });
});

describe('isGhAuthenticated', () => {
  it('returns true when authenticated', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, 'Logged in to github.com', '');
      },
    );

    expect(await isGhAuthenticated('/tmp')).toBe(true);
  });

  it('returns false when not authenticated (non-zero exit)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('auth failed') as any;
        err.code = 1;
        cb(err, '', 'You are not logged in');
      },
    );

    expect(await isGhAuthenticated('/tmp')).toBe(false);
  });

  it('re-throws GhNotFoundError', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('spawn gh ENOENT') as any;
        err.code = 'ENOENT';
        cb(err, '', '');
      },
    );

    await expect(isGhAuthenticated('/tmp')).rejects.toThrow(GhNotFoundError);
  });
});

describe('classifyGhError', () => {
  function makeGhApiError(stderr: string): GhApiError {
    return new GhApiError('gh failed', stderr, 1);
  }

  it('classifies "Bad credentials" as token-expired', () => {
    expect(classifyGhError(makeGhApiError('Bad credentials'))).toBe('token-expired');
  });

  it('classifies "token expired" as token-expired', () => {
    expect(classifyGhError(makeGhApiError('token expired'))).toBe('token-expired');
  });

  it('classifies "Resource not accessible by integration" as permission-denied', () => {
    expect(classifyGhError(makeGhApiError('Resource not accessible by integration'))).toBe(
      'permission-denied',
    );
  });

  it('classifies "Must have write access" as permission-denied', () => {
    expect(classifyGhError(makeGhApiError('Must have write access'))).toBe('permission-denied');
  });

  it('classifies "pull request is closed" as pr-closed', () => {
    expect(classifyGhError(makeGhApiError('pull request is closed'))).toBe('pr-closed');
  });

  it('classifies "commit_id is not part of the pull request" as stale-sha', () => {
    expect(classifyGhError(makeGhApiError('commit_id is not part of the pull request'))).toBe(
      'stale-sha',
    );
  });

  it('classifies "API rate limit exceeded" as rate-limited', () => {
    expect(classifyGhError(makeGhApiError('API rate limit exceeded'))).toBe('rate-limited');
  });

  it('classifies unknown error as unknown', () => {
    expect(classifyGhError(makeGhApiError('something unexpected'))).toBe('unknown');
  });

  it('is case-insensitive: "BAD CREDENTIALS" → token-expired', () => {
    expect(classifyGhError(makeGhApiError('BAD CREDENTIALS'))).toBe('token-expired');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import { detectPr, getRepoInfo, openPrInBrowser } from '../../gh/prDetector';

beforeEach(() => {
  mockExecFile.mockReset();
});

const prJson = JSON.stringify({
  number: 42,
  url: 'https://github.com/user/repo/pull/42',
  headRefName: 'feat',
  baseRefName: 'main',
});

const repoJson = JSON.stringify({
  owner: { login: 'user' },
  name: 'repo',
});

describe('detectPr', () => {
  it('returns PrInfo when a PR exists', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: object, cb: Function) => {
        if (args[0] === 'pr') {
          cb(null, prJson, '');
        } else if (args[0] === 'repo') {
          cb(null, repoJson, '');
        } else {
          cb(new Error('unexpected'), '', '');
        }
      },
    );

    const result = await detectPr('/tmp');
    expect(result).toEqual({
      number: 42,
      url: 'https://github.com/user/repo/pull/42',
      headRefName: 'feat',
      baseRefName: 'main',
      owner: 'user',
      repo: 'repo',
    });
  });

  it('returns null when no PR is found', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('no pull requests found') as any;
        err.code = 1;
        cb(err, '', 'no pull requests found');
      },
    );

    const result = await detectPr('/tmp');
    expect(result).toBeNull();
  });

  it('returns null when PR is closed (non-zero exit)', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('pull request is closed') as any;
        err.code = 1;
        cb(err, '', 'pull request is closed');
      },
    );

    const result = await detectPr('/tmp');
    expect(result).toBeNull();
  });

  it('returns null when not in a git repository', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('not a git repository') as any;
        err.code = 128;
        cb(err, '', 'not a git repository');
      },
    );

    const result = await detectPr('/tmp');
    expect(result).toBeNull();
  });

  it('re-throws GhApiError for unrecognised stderr messages', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        const err = new Error('rate limit exceeded') as any;
        err.code = 1;
        cb(err, '', 'rate limit exceeded');
      },
    );

    await expect(detectPr('/tmp')).rejects.toThrow('rate limit exceeded');
  });
});

describe('getRepoInfo', () => {
  it('returns owner and repo from gh repo view', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, repoJson, '');
      },
    );

    const result = await getRepoInfo('/tmp');
    expect(result).toEqual({ owner: 'user', repo: 'repo' });
  });

  it('throws when owner is undefined', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, JSON.stringify({ owner: {}, name: 'repo' }), '');
      },
    );

    await expect(getRepoInfo('/tmp')).rejects.toThrow('Invalid GitHub owner name');
  });

  it('throws when repo is undefined', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, JSON.stringify({ owner: { login: 'user' } }), '');
      },
    );

    await expect(getRepoInfo('/tmp')).rejects.toThrow('Invalid GitHub repo name');
  });

  it('throws when owner contains invalid characters', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, JSON.stringify({ owner: { login: 'owner/../hack' }, name: 'repo' }), '');
      },
    );

    await expect(getRepoInfo('/tmp')).rejects.toThrow('Invalid GitHub owner name');
  });

  it('accepts valid names with dots, hyphens, and underscores', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(
          null,
          JSON.stringify({ owner: { login: 'my-org.name_1' }, name: 'my-repo.v2_test' }),
          '',
        );
      },
    );

    const result = await getRepoInfo('/tmp');
    expect(result).toEqual({ owner: 'my-org.name_1', repo: 'my-repo.v2_test' });
  });
});

describe('openPrInBrowser', () => {
  it('calls gh pr view --web and does not throw', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, cb: Function) => {
        cb(null, '', '');
      },
    );

    await expect(openPrInBrowser('/tmp')).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '--web'],
      { cwd: '/tmp' },
      expect.any(Function),
    );
  });
});

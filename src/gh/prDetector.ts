import { execGh, GhApiError } from './ghCli';
import type { PrInfo } from '../sync/commentTypes';

const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function detectPr(cwd: string): Promise<PrInfo | null> {
  try {
    const { stdout: prStdout } = await execGh(
      ['pr', 'view', '--json', 'number,url,headRefName,baseRefName'],
      cwd,
    );
    const prJson = JSON.parse(prStdout);

    const { owner, repo } = await getRepoInfo(cwd);

    return {
      number: prJson.number,
      url: prJson.url,
      headRefName: prJson.headRefName,
      baseRefName: prJson.baseRefName,
      owner,
      repo,
    };
  } catch (err) {
    if (
      err instanceof GhApiError &&
      /no pull requests found|pull request is closed|not a git repository/i.test(err.stderr)
    ) {
      return null;
    }
    throw err;
  }
}

export async function getRepoInfo(
  cwd: string,
): Promise<{ owner: string; repo: string }> {
  const { stdout } = await execGh(['repo', 'view', '--json', 'owner,name'], cwd);
  const json = JSON.parse(stdout);
  const owner = json.owner?.login;
  const repo = json.name;

  if (typeof owner !== 'string' || !GITHUB_NAME_PATTERN.test(owner)) {
    throw new Error(`Invalid GitHub owner name: ${owner}`);
  }
  if (typeof repo !== 'string' || !GITHUB_NAME_PATTERN.test(repo)) {
    throw new Error(`Invalid GitHub repo name: ${repo}`);
  }

  return { owner, repo };
}

export async function openPrInBrowser(cwd: string): Promise<void> {
  try {
    await execGh(['pr', 'view', '--web'], cwd);
  } catch {
    // Fire-and-forget — ignore errors
  }
}

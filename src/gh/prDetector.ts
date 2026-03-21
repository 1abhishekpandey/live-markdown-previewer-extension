import { execGh, GhApiError } from './ghCli';
import type { PrInfo } from '../sync/commentTypes';

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
    if (err instanceof GhApiError) {
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
  return { owner: json.owner.login, repo: json.name };
}

export async function openPrInBrowser(cwd: string): Promise<void> {
  try {
    await execGh(['pr', 'view', '--web'], cwd);
  } catch {
    // Fire-and-forget — ignore errors
  }
}

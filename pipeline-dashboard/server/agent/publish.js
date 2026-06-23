import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function slugify(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change';
}

async function defaultGit(args, cwd) {
  return execFileAsync('git', args, { cwd });
}

// Branch + commit + push the working copy and open a PR. Never pushes to main/master.
// Never throws: failures resolve with { prUrl: null, error }.
export async function publish(
  { cwd, repo, title, body = '', branch },
  { git = (args) => defaultGit(args, cwd), githubClient }
) {
  const head = branch || `bot/${slugify(title)}-${Date.now()}`;
  // Safety gate: never push to a protected branch. Normalize first so case,
  // surrounding whitespace, or a refs/heads/ prefix can't slip past the check.
  const normalized = head.trim().toLowerCase().replace(/^refs\/heads\//, '');
  if (normalized === 'main' || normalized === 'master') {
    return { prUrl: null, error: 'Refusing to push to protected branch main/master' };
  }
  try {
    const base = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim() || 'main';
    const pushBase = base === head ? 'main' : base;
    await git(['checkout', '-b', head], cwd);
    await git(['add', '-A'], cwd);
    await git(['commit', '-m', title], cwd);
    await git(['push', '-u', 'origin', head], cwd);
    const res = await githubClient.post(`/repos/${repo.fullName}/pulls`, {
      title, body, head, base: pushBase,
    });
    if (!res.ok) {
      return { prUrl: null, error: res.data?.message || `PR creation failed (${res.status})` };
    }
    return { prUrl: res.data.html_url, error: null };
  } catch (err) {
    return { prUrl: null, error: err.message || 'publish failed' };
  }
}

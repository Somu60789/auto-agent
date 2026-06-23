import { describe, it, expect } from 'vitest';
import { publish } from '../server/agent/publish.js';

function fakeGit() {
  const cmds = [];
  const git = async (args) => {
    cmds.push(args.join(' '));
    if (args[0] === 'rev-parse') return { stdout: 'main\n' }; // current default branch
    return { stdout: '' };
  };
  git.cmds = cmds;
  return git;
}

function fakeClient(prUrl = 'https://github.com/o/r/pull/7') {
  const calls = [];
  return {
    calls,
    post: async (pathname, body) => {
      calls.push({ pathname, body });
      return { ok: true, status: 201, data: { html_url: prUrl } };
    },
  };
}

const repo = { owner: 'o', name: 'r', fullName: 'o/r' };

describe('publish', () => {
  it('creates a bot branch, commits, pushes, and opens a PR', async () => {
    const git = fakeGit();
    const client = fakeClient();
    const res = await publish(
      { cwd: '/repo/r', repo, title: 'Fix pipeline', body: 'changes' },
      { git, githubClient: client }
    );
    expect(res.prUrl).toBe('https://github.com/o/r/pull/7');
    expect(res.error).toBe(null);
    const joined = git.cmds.join('|');
    expect(joined).toMatch(/checkout -b bot\//);
    expect(joined).toMatch(/push/);
    expect(client.calls[0].pathname).toBe('/repos/o/r/pulls');
    expect(client.calls[0].body.head).toMatch(/^bot\//);
  });

  it('returns an error (no push) if the branch would be main', async () => {
    const git = fakeGit();
    const client = fakeClient();
    const res = await publish(
      { cwd: '/repo/r', repo, title: 'main', body: '', branch: 'main' },
      { git, githubClient: client }
    );
    expect(res.error).toMatch(/main/);
    expect(git.cmds.join('|')).not.toMatch(/push/);
    expect(client.calls).toHaveLength(0);
  });
});

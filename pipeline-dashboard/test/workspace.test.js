import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { resolveRepo, listRepos } from '../server/agent/workspace.js';

let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'allrepos-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolveRepo', () => {
  it('returns existing clone dir without cloning', async () => {
    await fs.mkdir(path.join(root, 'ep-home-ui', '.git'), { recursive: true });
    const calls = [];
    const fakeClone = async (...a) => calls.push(a);
    const dir = await resolveRepo(
      { allReposPath: root, token: 'tok', owner: 'default' },
      'https://github.com/tmlconnected/ep-home-ui',
      { cloneImpl: fakeClone }
    );
    expect(dir).toBe(path.join(root, 'ep-home-ui'));
    expect(calls).toHaveLength(0);
  });

  it('clones when missing, using token-authenticated url', async () => {
    const calls = [];
    const fakeClone = async (url, dest) => {
      calls.push({ url, dest });
      await fs.mkdir(path.join(dest, '.git'), { recursive: true });
    };
    const dir = await resolveRepo(
      { allReposPath: root, token: 'tok', owner: 'default' },
      'tmlconnected/ep-infra',
      { cloneImpl: fakeClone }
    );
    expect(dir).toBe(path.join(root, 'ep-infra'));
    expect(calls[0].url).toContain('tok@github.com');
    expect(calls[0].url).toContain('tmlconnected/ep-infra');
  });

  it('throws on an unparseable repo reference', async () => {
    await expect(
      resolveRepo({ allReposPath: root, token: 't', owner: 'default' }, 'not a repo', {})
    ).rejects.toThrow(/repo/i);
  });

  it('resolves a bare name to an existing clone without cloning', async () => {
    await fs.mkdir(path.join(root, 'smoke-test', '.git'), { recursive: true });
    const calls = [];
    const dir = await resolveRepo(
      { allReposPath: root, token: 't', owner: 'default' },
      'smoke-test',
      { cloneImpl: async (...a) => calls.push(a) }
    );
    expect(dir).toBe(path.join(root, 'smoke-test'));
    expect(calls).toHaveLength(0);
  });

  it('throws for a bare name that is not cloned', async () => {
    await expect(
      resolveRepo({ allReposPath: root, token: 't', owner: 'default' }, 'missing', {})
    ).rejects.toThrow(/ALL_Repos/);
  });
});

describe('listRepos', () => {
  it('lists git subdirs and skips the state dir', async () => {
    await fs.mkdir(path.join(root, 'a', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'b', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, '.co-worker'), { recursive: true });
    await fs.mkdir(path.join(root, 'plain'), { recursive: true });
    const repos = await listRepos(root);
    expect(repos.sort()).toEqual(['a', 'b']);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseRepoUrl } from '../server/repoList.js';
import { scanPipelineRepos } from '../server/repoList.js';
import { scanLocalRepos } from '../server/repoList.js';
import { buildRepoList } from '../server/repoList.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_EP = path.join(__dirname, 'fixtures', 'ep-pipelines');

let tmpRoot;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tml-repos-'));
  await fs.mkdir(path.join(tmpRoot, 'ep-home-ui', '.git'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'ep-home-ui', '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/tmlconnected/ep-home-ui.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
  );
  await fs.mkdir(path.join(tmpRoot, 'ep-issue-report', '.git'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'ep-issue-report', '.git', 'config'),
    '[remote "origin"]\n\turl = git@github.com:tmlconnected/ep-issue-report.git\n'
  );
  await fs.mkdir(path.join(tmpRoot, 'not-a-repo'), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, 'not-a-repo', 'README.md'),
    'just a folder, no .git\n'
  );
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('parseRepoUrl', () => {
  it('parses an https .git url', () => {
    expect(parseRepoUrl('https://github.com/tmlconnected/ep-home-ui.git')).toEqual({
      owner: 'tmlconnected',
      name: 'ep-home-ui',
      fullName: 'tmlconnected/ep-home-ui',
      url: 'https://github.com/tmlconnected/ep-home-ui',
    });
  });

  it('parses an https url without .git suffix', () => {
    expect(parseRepoUrl('https://github.com/tmlconnected/ep-andon-jlr')).toEqual({
      owner: 'tmlconnected',
      name: 'ep-andon-jlr',
      fullName: 'tmlconnected/ep-andon-jlr',
      url: 'https://github.com/tmlconnected/ep-andon-jlr',
    });
  });

  it('parses an ssh git url', () => {
    expect(parseRepoUrl('git@github.com:tmlconnected/ep-eloto.git')).toEqual({
      owner: 'tmlconnected',
      name: 'ep-eloto',
      fullName: 'tmlconnected/ep-eloto',
      url: 'https://github.com/tmlconnected/ep-eloto',
    });
  });

  it('returns null for a non-github url', () => {
    expect(parseRepoUrl('https://example.com/foo/bar.git')).toBeNull();
  });
});

describe('scanPipelineRepos', () => {
  it('finds all unique github repos referenced in the ep-pipelines tree', async () => {
    const repos = await scanPipelineRepos(FIXTURE_EP);
    const names = repos.map((r) => r.fullName).sort();
    expect(names).toEqual([
      'tmlconnected/control-tower-backend',
      'tmlconnected/ep-home-ui',
      'tmlconnected/ep-reconciliation',
    ]);
  });

  it('returns empty array when the directory does not exist', async () => {
    const repos = await scanPipelineRepos('/no/such/path');
    expect(repos).toEqual([]);
  });
});

describe('scanLocalRepos', () => {
  it('lists immediate subdirs that are git repos, keyed by origin remote', async () => {
    const repos = await scanLocalRepos(tmpRoot);
    const names = repos.map((r) => r.fullName).sort();
    expect(names).toEqual([
      'tmlconnected/ep-home-ui',
      'tmlconnected/ep-issue-report',
    ]);
  });

  it('returns empty array when the directory does not exist', async () => {
    expect(await scanLocalRepos('/no/such/path')).toEqual([]);
  });
});

describe('buildRepoList', () => {
  it('unions pipeline + local repos with membership flags', async () => {
    const repos = await buildRepoList({
      epPipelinesPath: FIXTURE_EP,
      tmlReposPath: tmpRoot,
    });
    const byName = Object.fromEntries(repos.map((r) => [r.fullName, r]));

    expect(byName['tmlconnected/ep-home-ui'].inPipelines).toBe(true);
    expect(byName['tmlconnected/ep-home-ui'].clonedLocally).toBe(true);

    expect(byName['tmlconnected/control-tower-backend'].inPipelines).toBe(true);
    expect(byName['tmlconnected/control-tower-backend'].clonedLocally).toBe(false);

    expect(byName['tmlconnected/ep-issue-report'].inPipelines).toBe(false);
    expect(byName['tmlconnected/ep-issue-report'].clonedLocally).toBe(true);
  });

  it('sorts results by fullName', async () => {
    const repos = await buildRepoList({
      epPipelinesPath: FIXTURE_EP,
      tmlReposPath: tmpRoot,
    });
    const names = repos.map((r) => r.fullName);
    expect(names).toEqual([...names].sort());
  });
});

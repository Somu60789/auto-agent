# Pipeline Visibility Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted, read-only web dashboard that lists every EP pipeline repository (union of repos referenced in `ep-pipelines` and repos cloned in `TML_Repos`) with columns showing whether GitHub Actions / Jenkins config / Dockerfile exist and the latest GitHub Actions build status, fetched live from the GitHub API.

**Architecture:** A minimal Node/Express backend builds the repo list from the local filesystem (parsing the `ep-pipelines` clone and listing `TML_Repos`), enriches each repo via the GitHub REST API (concurrency-capped, cached), and serves `/api/repos`, `/api/refresh`, `/api/health`. A Vite + React 18 + MUI v5 single-page frontend renders a sortable/filterable table and a Refresh button, proxying `/api` to the backend.

**Tech Stack:** Node 18, Express, Vitest (backend tests), Vite + React 18 + Material-UI v5, axios (frontend). GitHub PAT supplied via `GITHUB_TOKEN` env var.

---

## File Structure

```
pipeline-dashboard/
  package.json              # backend deps + scripts, type:"module"
  .env.example              # GITHUB_TOKEN=, TML_REPOS_PATH=, EP_PIPELINES_PATH=, PORT=, CACHE_TTL_SECONDS=
  .gitignore                # node_modules, .env, web/dist
  README.md
  server/
    config.js               # reads env, exports paths/port/ttl
    githubClient.js         # GitHub REST wrapper + error classification
    repoList.js             # build union repo list from filesystem
    enrich.js               # enrich repos via GitHub API, concurrency + cache
    index.js                # Express app + routes
  test/
    repoList.test.js
    enrich.test.js
    githubClient.test.js
    health.test.js
    fixtures/
      ep-pipelines/         # tiny fixture tree with .git urls + seed-job config
      TML_Repos/            # tiny fixture tree with fake cloned repos
  web/
    package.json            # vite + react + mui
    vite.config.js          # dev proxy /api -> backend
    index.html
    src/
      main.jsx
      App.jsx
      api.js
      components/StatusChip.jsx
      components/RepoTable.jsx
      components/DashboardToolbar.jsx
```

The backend and frontend are separate npm packages so their dependency trees stay clean. The repo root for all paths below is `/home/somasekhar/Downloads/agets/auto-agent/pipeline-dashboard`.

---

## Task 1: Backend project scaffold

**Files:**
- Create: `pipeline-dashboard/package.json`
- Create: `pipeline-dashboard/.gitignore`
- Create: `pipeline-dashboard/.env.example`

- [ ] **Step 1: Create `pipeline-dashboard/package.json`**

```json
{
  "name": "pipeline-dashboard-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `pipeline-dashboard/.gitignore`**

```
node_modules/
.env
web/dist/
web/node_modules/
```

- [ ] **Step 3: Create `pipeline-dashboard/.env.example`**

```
# GitHub Personal Access Token with repo + workflow read scope
GITHUB_TOKEN=
# Absolute path to the local TML_Repos directory
TML_REPOS_PATH=/home/somasekhar/Desktop/TML_Repos
# Absolute path to the local ep-pipelines clone (defaults to TML_REPOS_PATH/ep-pipelines)
EP_PIPELINES_PATH=
# Backend port
PORT=4000
# Cache lifetime for enriched repo data, in seconds
CACHE_TTL_SECONDS=300
```

- [ ] **Step 4: Install dependencies**

Run: `cd pipeline-dashboard && npm install`
Expected: `node_modules/` created, `express` and `vitest` installed, no errors.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/package.json pipeline-dashboard/package-lock.json pipeline-dashboard/.gitignore pipeline-dashboard/.env.example
git commit -m "Scaffold pipeline-dashboard backend project"
```

---

## Task 2: Config module

**Files:**
- Create: `pipeline-dashboard/server/config.js`
- Test: `pipeline-dashboard/test/config.test.js`

- [ ] **Step 1: Write the failing test**

Create `pipeline-dashboard/test/config.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../server/config.js';

describe('loadConfig', () => {
  it('uses defaults when optional env vars are absent', () => {
    const cfg = loadConfig({ GITHUB_TOKEN: 'tok', TML_REPOS_PATH: '/repos' });
    expect(cfg.githubToken).toBe('tok');
    expect(cfg.tmlReposPath).toBe('/repos');
    expect(cfg.epPipelinesPath).toBe('/repos/ep-pipelines');
    expect(cfg.port).toBe(4000);
    expect(cfg.cacheTtlSeconds).toBe(300);
  });

  it('honors explicit EP_PIPELINES_PATH, PORT and CACHE_TTL_SECONDS', () => {
    const cfg = loadConfig({
      GITHUB_TOKEN: 'tok',
      TML_REPOS_PATH: '/repos',
      EP_PIPELINES_PATH: '/custom/ep',
      PORT: '8080',
      CACHE_TTL_SECONDS: '60',
    });
    expect(cfg.epPipelinesPath).toBe('/custom/ep');
    expect(cfg.port).toBe(8080);
    expect(cfg.cacheTtlSeconds).toBe(60);
  });

  it('throws when GITHUB_TOKEN is missing', () => {
    expect(() => loadConfig({ TML_REPOS_PATH: '/repos' })).toThrow(/GITHUB_TOKEN/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/config.test.js`
Expected: FAIL — cannot find module `../server/config.js`.

- [ ] **Step 3: Write minimal implementation**

Create `pipeline-dashboard/server/config.js`:

```js
import path from 'node:path';

export function loadConfig(env = process.env) {
  const githubToken = env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }
  const tmlReposPath = env.TML_REPOS_PATH || '/home/somasekhar/Desktop/TML_Repos';
  const epPipelinesPath =
    env.EP_PIPELINES_PATH || path.join(tmlReposPath, 'ep-pipelines');
  return {
    githubToken,
    tmlReposPath,
    epPipelinesPath,
    port: Number(env.PORT) || 4000,
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS) || 300,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/config.test.js`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/config.js pipeline-dashboard/test/config.test.js
git commit -m "Add config module with env defaults and validation"
```

---

## Task 3: Repo list — parse owner/repo from a git URL

**Files:**
- Create: `pipeline-dashboard/server/repoList.js`
- Test: `pipeline-dashboard/test/repoList.test.js`

- [ ] **Step 1: Write the failing test**

Create `pipeline-dashboard/test/repoList.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseRepoUrl } from '../server/repoList.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: FAIL — `parseRepoUrl` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `pipeline-dashboard/server/repoList.js`:

```js
const GITHUB_URL_RE =
  /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?(?:\s|$|["'])/;

export function parseRepoUrl(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(GITHUB_URL_RE);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/repoList.js pipeline-dashboard/test/repoList.test.js
git commit -m "Add parseRepoUrl helper for repo list building"
```

---

## Task 4: Repo list — scan ep-pipelines for referenced repos

**Files:**
- Modify: `pipeline-dashboard/server/repoList.js`
- Test: `pipeline-dashboard/test/repoList.test.js` (add cases)
- Create fixture: `pipeline-dashboard/test/fixtures/ep-pipelines/vars/build.groovy`
- Create fixture: `pipeline-dashboard/test/fixtures/ep-pipelines/ci/seed-job/dev/config.yaml`

- [ ] **Step 1: Create fixture files**

Create `pipeline-dashboard/test/fixtures/ep-pipelines/vars/build.groovy`:

```groovy
// sample groovy referencing a repo
def repo = "https://github.com/tmlconnected/ep-home-ui.git"
def other = "https://github.com/tmlconnected/control-tower-backend.git"
```

Create `pipeline-dashboard/test/fixtures/ep-pipelines/ci/seed-job/dev/config.yaml`:

```yaml
jobs:
  - path: "esakha/build/reconciliation"
    auto_trigger_repo: "https://github.com/tmlconnected/ep-reconciliation.git"
  - path: "esakha/build/home"
    auto_trigger_repo: "https://github.com/tmlconnected/ep-home-ui.git"
```

- [ ] **Step 2: Write the failing test (add to existing file)**

Add to `pipeline-dashboard/test/repoList.test.js`:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPipelineRepos } from '../server/repoList.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_EP = path.join(__dirname, 'fixtures', 'ep-pipelines');

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: FAIL — `scanPipelineRepos` is not exported.

- [ ] **Step 4: Write minimal implementation (add to repoList.js)**

Add to `pipeline-dashboard/server/repoList.js`:

```js
import fs from 'node:fs/promises';
import path from 'node:path';

const ALL_GITHUB_URLS_RE = /github\.com[/:][^/\s"']+\/[^/\s"']+?(?:\.git)?(?=["'\s])/g;

async function walkFiles(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function scanPipelineRepos(epPipelinesPath) {
  const files = await walkFiles(epPipelinesPath);
  const byFullName = new Map();
  for (const file of files) {
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const matches = content.match(ALL_GITHUB_URLS_RE) || [];
    for (const m of matches) {
      const parsed = parseRepoUrl(m + ' ');
      if (parsed) byFullName.set(parsed.fullName, parsed);
    }
  }
  return [...byFullName.values()];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: PASS — all repoList tests pass.

- [ ] **Step 6: Commit**

```bash
git add pipeline-dashboard/server/repoList.js pipeline-dashboard/test/repoList.test.js pipeline-dashboard/test/fixtures/ep-pipelines
git commit -m "Add scanPipelineRepos to extract repo refs from ep-pipelines tree"
```

---

## Task 5: Repo list — scan local TML_Repos clones

**Files:**
- Modify: `pipeline-dashboard/server/repoList.js`
- Test: `pipeline-dashboard/test/repoList.test.js` (add cases)
- Create fixture: `pipeline-dashboard/test/fixtures/TML_Repos/ep-home-ui/.git/config`
- Create fixture: `pipeline-dashboard/test/fixtures/TML_Repos/ep-issue-report/.git/config`
- Create fixture: `pipeline-dashboard/test/fixtures/TML_Repos/not-a-repo/README.md`

- [ ] **Step 1: Create fixture files**

Create `pipeline-dashboard/test/fixtures/TML_Repos/ep-home-ui/.git/config`:

```
[remote "origin"]
	url = https://github.com/tmlconnected/ep-home-ui.git
	fetch = +refs/heads/*:refs/remotes/origin/*
```

Create `pipeline-dashboard/test/fixtures/TML_Repos/ep-issue-report/.git/config`:

```
[remote "origin"]
	url = git@github.com:tmlconnected/ep-issue-report.git
```

Create `pipeline-dashboard/test/fixtures/TML_Repos/not-a-repo/README.md`:

```
just a folder, no .git
```

- [ ] **Step 2: Write the failing test (add to existing file)**

Add to `pipeline-dashboard/test/repoList.test.js`:

```js
import { scanLocalRepos } from '../server/repoList.js';

const FIXTURE_TML = path.join(__dirname, 'fixtures', 'TML_Repos');

describe('scanLocalRepos', () => {
  it('lists immediate subdirs that are git repos, keyed by origin remote', async () => {
    const repos = await scanLocalRepos(FIXTURE_TML);
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: FAIL — `scanLocalRepos` is not exported.

- [ ] **Step 4: Write minimal implementation (add to repoList.js)**

Add to `pipeline-dashboard/server/repoList.js`:

```js
function parseOriginFromGitConfig(configText) {
  const lines = configText.split('\n');
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[remote ')) {
      inOrigin = trimmed.includes('"origin"');
      continue;
    }
    if (inOrigin && trimmed.startsWith('url')) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

export async function scanLocalRepos(tmlReposPath) {
  let entries;
  try {
    entries = await fs.readdir(tmlReposPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const byFullName = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const gitConfigPath = path.join(tmlReposPath, entry.name, '.git', 'config');
    let configText;
    try {
      configText = await fs.readFile(gitConfigPath, 'utf8');
    } catch {
      continue;
    }
    const originUrl = parseOriginFromGitConfig(configText);
    const parsed = parseRepoUrl((originUrl || '') + ' ');
    if (parsed) byFullName.set(parsed.fullName, parsed);
  }
  return [...byFullName.values()];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: PASS — all repoList tests pass.

- [ ] **Step 6: Commit**

```bash
git add pipeline-dashboard/server/repoList.js pipeline-dashboard/test/repoList.test.js pipeline-dashboard/test/fixtures/TML_Repos
git commit -m "Add scanLocalRepos to list cloned repos from TML_Repos"
```

---

## Task 6: Repo list — union of pipeline + local sets

**Files:**
- Modify: `pipeline-dashboard/server/repoList.js`
- Test: `pipeline-dashboard/test/repoList.test.js` (add cases)

- [ ] **Step 1: Write the failing test (add to existing file)**

Add to `pipeline-dashboard/test/repoList.test.js`:

```js
import { buildRepoList } from '../server/repoList.js';

describe('buildRepoList', () => {
  it('unions pipeline + local repos with membership flags', async () => {
    const repos = await buildRepoList({
      epPipelinesPath: FIXTURE_EP,
      tmlReposPath: FIXTURE_TML,
    });
    const byName = Object.fromEntries(repos.map((r) => [r.fullName, r]));

    // ep-home-ui is in BOTH sets
    expect(byName['tmlconnected/ep-home-ui'].inPipelines).toBe(true);
    expect(byName['tmlconnected/ep-home-ui'].clonedLocally).toBe(true);

    // control-tower-backend only in pipelines
    expect(byName['tmlconnected/control-tower-backend'].inPipelines).toBe(true);
    expect(byName['tmlconnected/control-tower-backend'].clonedLocally).toBe(false);

    // ep-issue-report only cloned locally
    expect(byName['tmlconnected/ep-issue-report'].inPipelines).toBe(false);
    expect(byName['tmlconnected/ep-issue-report'].clonedLocally).toBe(true);
  });

  it('sorts results by fullName', async () => {
    const repos = await buildRepoList({
      epPipelinesPath: FIXTURE_EP,
      tmlReposPath: FIXTURE_TML,
    });
    const names = repos.map((r) => r.fullName);
    expect(names).toEqual([...names].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: FAIL — `buildRepoList` is not exported.

- [ ] **Step 3: Write minimal implementation (add to repoList.js)**

Add to `pipeline-dashboard/server/repoList.js`:

```js
export async function buildRepoList({ epPipelinesPath, tmlReposPath }) {
  const [pipelineRepos, localRepos] = await Promise.all([
    scanPipelineRepos(epPipelinesPath),
    scanLocalRepos(tmlReposPath),
  ]);
  const byFullName = new Map();
  const ensure = (repo) => {
    if (!byFullName.has(repo.fullName)) {
      byFullName.set(repo.fullName, {
        ...repo,
        inPipelines: false,
        clonedLocally: false,
      });
    }
    return byFullName.get(repo.fullName);
  };
  for (const repo of pipelineRepos) ensure(repo).inPipelines = true;
  for (const repo of localRepos) ensure(repo).clonedLocally = true;
  return [...byFullName.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/repoList.test.js`
Expected: PASS — all repoList tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/repoList.js pipeline-dashboard/test/repoList.test.js
git commit -m "Add buildRepoList to union pipeline and local repos"
```

---

## Task 7: GitHub client wrapper

**Files:**
- Create: `pipeline-dashboard/server/githubClient.js`
- Test: `pipeline-dashboard/test/githubClient.test.js`

The client uses the global `fetch` (Node 18+). A `fetchImpl` parameter is injected for testing.

- [ ] **Step 1: Write the failing test**

Create `pipeline-dashboard/test/githubClient.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { createGithubClient } from '../server/githubClient.js';

function mockResponse({ status = 200, body = {}, headers = {} }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe('createGithubClient', () => {
  it('sends Authorization header and returns parsed json on 200', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { login: 'x' }, headers: { 'x-ratelimit-remaining': '42' } })
    );
    const client = createGithubClient({ token: 'tok', fetchImpl });
    const res = await client.get('/user');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ login: 'x' });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('classifies 404 as notFound without throwing', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 404 }));
    const client = createGithubClient({ token: 'tok', fetchImpl });
    const res = await client.get('/repos/x/y/contents/Dockerfile');
    expect(res.status).toBe(404);
    expect(res.notFound).toBe(true);
  });

  it('tracks last rate-limit remaining', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: {}, headers: { 'x-ratelimit-remaining': '7' } })
    );
    const client = createGithubClient({ token: 'tok', fetchImpl });
    await client.get('/user');
    expect(client.rateLimitRemaining()).toBe(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/githubClient.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `pipeline-dashboard/server/githubClient.js`:

```js
const API_BASE = 'https://api.github.com';

export function createGithubClient({ token, fetchImpl = fetch }) {
  let lastRemaining = null;

  async function get(pathname) {
    const response = await fetchImpl(`${API_BASE}${pathname}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) lastRemaining = Number(remaining);

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      notFound: response.status === 404,
      forbidden: response.status === 403,
      data,
    };
  }

  return {
    get,
    rateLimitRemaining: () => lastRemaining,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/githubClient.test.js`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/githubClient.js pipeline-dashboard/test/githubClient.test.js
git commit -m "Add GitHub REST client wrapper with error and rate-limit handling"
```

---

## Task 8: Enrich a single repo

**Files:**
- Create: `pipeline-dashboard/server/enrich.js`
- Test: `pipeline-dashboard/test/enrich.test.js`

- [ ] **Step 1: Write the failing test**

Create `pipeline-dashboard/test/enrich.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { enrichRepo } from '../server/enrich.js';

// Fake client whose responses are keyed by pathname.
function fakeClient(routes) {
  return {
    get: async (pathname) => {
      const r = routes[pathname];
      if (!r) return { status: 404, ok: false, notFound: true, data: null };
      return { ok: r.status >= 200 && r.status < 300, notFound: r.status === 404, forbidden: r.status === 403, ...r };
    },
    rateLimitRemaining: () => 100,
  };
}

const base = {
  owner: 'tmlconnected',
  name: 'ep-home-ui',
  fullName: 'tmlconnected/ep-home-ui',
  url: 'https://github.com/tmlconnected/ep-home-ui',
  inPipelines: true,
  clonedLocally: true,
};

describe('enrichRepo', () => {
  it('detects workflows, dockerfile, and maps latest run conclusion', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows': {
        status: 200,
        data: [{ name: 'build.yml' }],
      },
      '/repos/tmlconnected/ep-home-ui/contents/Dockerfile': { status: 200, data: { name: 'Dockerfile' } },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': {
        status: 200,
        data: { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'https://x/runs/1' }] },
      },
    });
    const result = await enrichRepo(client, base);
    expect(result.githubActions).toBe(true);
    expect(result.dockerfile).toBe(true);
    expect(result.jenkins).toBe(true); // inPipelines -> jenkins config presence
    expect(result.latestBuild).toEqual({ status: 'success', url: 'https://x/runs/1' });
    expect(result.error).toBeNull();
  });

  it('reports false/none when artifacts are absent', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': {
        status: 200,
        data: { workflow_runs: [] },
      },
    });
    const result = await enrichRepo(client, { ...base, inPipelines: false });
    expect(result.githubActions).toBe(false);
    expect(result.dockerfile).toBe(false);
    expect(result.jenkins).toBe(false);
    expect(result.latestBuild).toEqual({ status: 'none', url: null });
  });

  it('maps an in-progress run to running', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows': { status: 200, data: [{ name: 'a.yml' }] },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': {
        status: 200,
        data: { workflow_runs: [{ status: 'in_progress', conclusion: null, html_url: 'https://x/runs/2' }] },
      },
    });
    const result = await enrichRepo(client, base);
    expect(result.latestBuild.status).toBe('running');
  });

  it('falls back to docker-compose.yml for the dockerfile flag', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/docker-compose.yml': { status: 200, data: { name: 'docker-compose.yml' } },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.dockerfile).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/enrich.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `pipeline-dashboard/server/enrich.js`:

```js
function mapLatestRun(runsData) {
  const runs = runsData?.workflow_runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    return { status: 'none', url: null };
  }
  const run = runs[0];
  let status;
  if (run.status !== 'completed') {
    status = 'running';
  } else if (run.conclusion === 'success') {
    status = 'success';
  } else if (run.conclusion === 'failure') {
    status = 'failure';
  } else {
    status = run.conclusion || 'unknown';
  }
  return { status, url: run.html_url || null };
}

async function pathExists(client, pathname) {
  const res = await client.get(pathname);
  return res.ok;
}

export async function enrichRepo(client, repo) {
  const { owner, name } = repo;
  const prefix = `/repos/${owner}/${name}`;
  try {
    const [workflows, dockerfile, dockerCompose, runs] = await Promise.all([
      pathExists(client, `${prefix}/contents/.github/workflows`),
      pathExists(client, `${prefix}/contents/Dockerfile`),
      pathExists(client, `${prefix}/contents/docker-compose.yml`),
      client.get(`${prefix}/actions/runs?per_page=1`),
    ]);
    return {
      ...repo,
      githubActions: workflows,
      dockerfile: dockerfile || dockerCompose,
      jenkins: Boolean(repo.inPipelines),
      latestBuild: runs.ok ? mapLatestRun(runs.data) : { status: 'unknown', url: null },
      error: null,
    };
  } catch (err) {
    return {
      ...repo,
      githubActions: false,
      dockerfile: false,
      jenkins: Boolean(repo.inPipelines),
      latestBuild: { status: 'unknown', url: null },
      error: err.message || 'enrichment failed',
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/enrich.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/enrich.js pipeline-dashboard/test/enrich.test.js
git commit -m "Add enrichRepo to derive build artifact flags and status"
```

---

## Task 9: Enrich many repos with concurrency cap

**Files:**
- Modify: `pipeline-dashboard/server/enrich.js`
- Test: `pipeline-dashboard/test/enrich.test.js` (add cases)

- [ ] **Step 1: Write the failing test (add to existing file)**

Add to `pipeline-dashboard/test/enrich.test.js`:

```js
import { enrichAll } from '../server/enrich.js';

describe('enrichAll', () => {
  it('enriches every repo and never exceeds the concurrency cap', async () => {
    let active = 0;
    let maxActive = 0;
    const client = {
      get: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { ok: false, notFound: true, status: 404, data: null };
      },
      rateLimitRemaining: () => 99,
    };
    const repos = Array.from({ length: 20 }, (_, i) => ({
      owner: 'o',
      name: `r${i}`,
      fullName: `o/r${i}`,
      url: `https://github.com/o/r${i}`,
      inPipelines: false,
      clonedLocally: true,
    }));
    const results = await enrichAll(client, repos, { concurrency: 4 });
    expect(results).toHaveLength(20);
    expect(maxActive).toBeLessThanOrEqual(4 * 4); // 4 repos * up to 4 calls each in flight
    expect(results.every((r) => 'githubActions' in r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/enrich.test.js`
Expected: FAIL — `enrichAll` is not exported.

- [ ] **Step 3: Write minimal implementation (add to enrich.js)**

Add to `pipeline-dashboard/server/enrich.js`:

```js
export async function enrichAll(client, repos, { concurrency = 8 } = {}) {
  const results = new Array(repos.length);
  let cursor = 0;
  async function worker() {
    while (cursor < repos.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await enrichRepo(client, repos[index]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, repos.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/enrich.test.js`
Expected: PASS — all enrich tests pass.

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/enrich.js pipeline-dashboard/test/enrich.test.js
git commit -m "Add enrichAll with worker-pool concurrency cap"
```

---

## Task 10: Express app, routes, and cache

**Files:**
- Create: `pipeline-dashboard/server/index.js`
- Test: `pipeline-dashboard/test/health.test.js`

The app factory takes injected `config`, `client`, and a `buildRepos` function so it is testable without hitting GitHub or the filesystem.

- [ ] **Step 1: Write the failing test**

Create `pipeline-dashboard/test/health.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createApp } from '../server/index.js';

function makeApp(overrides = {}) {
  const client = { get: async () => ({ ok: true }), rateLimitRemaining: () => 55 };
  const buildRepos = overrides.buildRepos || (async () => [
    {
      owner: 'o', name: 'r', fullName: 'o/r', url: 'https://github.com/o/r',
      inPipelines: true, clonedLocally: true,
      githubActions: true, dockerfile: false, jenkins: true,
      latestBuild: { status: 'success', url: 'https://x/1' }, error: null,
    },
  ]);
  return createApp({
    config: { cacheTtlSeconds: 300 },
    client,
    buildRepos,
  });
}

async function call(app, method, path) {
  // Minimal supertest-free invocation via fetch against a listening server.
  const server = app.listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

describe('createApp routes', () => {
  it('GET /api/health returns ok and rate limit', async () => {
    const app = makeApp();
    const { status, body } = await call(app, 'GET', '/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.rateLimitRemaining).toBe(55);
  });

  it('GET /api/repos returns the enriched list', async () => {
    const app = makeApp();
    const { status, body } = await call(app, 'GET', '/api/repos');
    expect(status).toBe(200);
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0].fullName).toBe('o/r');
    expect(typeof body.generatedAt).toBe('string');
  });

  it('caches repos so buildRepos is called once across two GETs', async () => {
    let calls = 0;
    const app = makeApp({
      buildRepos: async () => {
        calls += 1;
        return [];
      },
    });
    await call(app, 'GET', '/api/repos');
    await call(app, 'GET', '/api/repos');
    expect(calls).toBe(1);
  });

  it('POST /api/refresh rebuilds even when cache is warm', async () => {
    let calls = 0;
    const app = makeApp({
      buildRepos: async () => {
        calls += 1;
        return [];
      },
    });
    await call(app, 'GET', '/api/repos');
    await call(app, 'POST', '/api/refresh');
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npx vitest run test/health.test.js`
Expected: FAIL — module not found / `createApp` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `pipeline-dashboard/server/index.js`:

```js
import express from 'express';
import { loadConfig } from './config.js';
import { createGithubClient } from './githubClient.js';
import { buildRepoList } from './repoList.js';
import { enrichAll } from './enrich.js';

export function createApp({ config, client, buildRepos }) {
  const app = express();
  app.use(express.json());

  let cache = null; // { generatedAt, repos }
  let cacheTime = 0;

  function isFresh() {
    return cache && Date.now() - cacheTime < config.cacheTtlSeconds * 1000;
  }

  async function refresh() {
    const repos = await buildRepos();
    cache = {
      generatedAt: new Date().toISOString(),
      repos,
    };
    cacheTime = Date.now();
    return cache;
  }

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, rateLimitRemaining: client.rateLimitRemaining() });
  });

  app.get('/api/repos', async (req, res) => {
    try {
      if (!isFresh()) await refresh();
      res.json({
        ...cache,
        rateLimitRemaining: client.rateLimitRemaining(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/refresh', async (req, res) => {
    try {
      await refresh();
      res.json({
        ...cache,
        rateLimitRemaining: client.rateLimitRemaining(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// Real wiring used by `npm start`; skipped during unit tests.
export function startServer() {
  const config = loadConfig();
  const client = createGithubClient({ token: config.githubToken });
  const buildRepos = async () => {
    const repos = await buildRepoList({
      epPipelinesPath: config.epPipelinesPath,
      tmlReposPath: config.tmlReposPath,
    });
    return enrichAll(client, repos, { concurrency: 8 });
  };
  const app = createApp({ config, client, buildRepos });
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Pipeline dashboard API listening on http://localhost:${config.port}`);
  });
}

if (process.argv[1] && process.argv[1].endsWith('server/index.js')) {
  startServer();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npx vitest run test/health.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Run the full backend suite**

Run: `cd pipeline-dashboard && npm test`
Expected: PASS — all backend test files green.

- [ ] **Step 6: Commit**

```bash
git add pipeline-dashboard/server/index.js pipeline-dashboard/test/health.test.js
git commit -m "Add Express app with repos, refresh, health routes and caching"
```

---

## Task 11: Frontend scaffold (Vite + React + MUI)

**Files:**
- Create: `pipeline-dashboard/web/package.json`
- Create: `pipeline-dashboard/web/vite.config.js`
- Create: `pipeline-dashboard/web/index.html`
- Create: `pipeline-dashboard/web/src/main.jsx`

- [ ] **Step 1: Create `pipeline-dashboard/web/package.json`**

```json
{
  "name": "pipeline-dashboard-web",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@emotion/react": "^11.11.4",
    "@emotion/styled": "^11.11.5",
    "@mui/icons-material": "^5.15.20",
    "@mui/material": "^5.15.20",
    "axios": "^1.7.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.3.1"
  }
}
```

- [ ] **Step 2: Create `pipeline-dashboard/web/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
```

- [ ] **Step 3: Create `pipeline-dashboard/web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>EP Pipeline Visibility Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `pipeline-dashboard/web/src/main.jsx`**

```jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import App from './App.jsx';

const theme = createTheme({ palette: { mode: 'light' } });

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
```

- [ ] **Step 5: Install deps and verify build tooling resolves**

Run: `cd pipeline-dashboard/web && npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Commit**

```bash
git add pipeline-dashboard/web/package.json pipeline-dashboard/web/package-lock.json pipeline-dashboard/web/vite.config.js pipeline-dashboard/web/index.html pipeline-dashboard/web/src/main.jsx
git commit -m "Scaffold Vite + React + MUI frontend"
```

---

## Task 12: API client + StatusChip component

**Files:**
- Create: `pipeline-dashboard/web/src/api.js`
- Create: `pipeline-dashboard/web/src/components/StatusChip.jsx`

No automated test (UI). Verification is via the running app in Task 14.

- [ ] **Step 1: Create `pipeline-dashboard/web/src/api.js`**

```js
import axios from 'axios';

export async function fetchRepos() {
  const { data } = await axios.get('/api/repos');
  return data;
}

export async function refreshRepos() {
  const { data } = await axios.post('/api/refresh');
  return data;
}
```

- [ ] **Step 2: Create `pipeline-dashboard/web/src/components/StatusChip.jsx`**

```jsx
import Chip from '@mui/material/Chip';

const STATUS_CONFIG = {
  success: { label: 'success', color: 'success', variant: 'filled' },
  failure: { label: 'failure', color: 'error', variant: 'filled' },
  running: { label: 'running', color: 'warning', variant: 'filled' },
  none: { label: 'none', color: 'default', variant: 'outlined' },
  unknown: { label: 'unknown', color: 'default', variant: 'outlined' },
};

export default function StatusChip({ status, title }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  return (
    <Chip
      size="small"
      label={cfg.label}
      color={cfg.color}
      variant={cfg.variant}
      title={title || ''}
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add pipeline-dashboard/web/src/api.js pipeline-dashboard/web/src/components/StatusChip.jsx
git commit -m "Add frontend API client and StatusChip component"
```

---

## Task 13: RepoTable, DashboardToolbar, and App

**Files:**
- Create: `pipeline-dashboard/web/src/components/RepoTable.jsx`
- Create: `pipeline-dashboard/web/src/components/DashboardToolbar.jsx`
- Create: `pipeline-dashboard/web/src/App.jsx`

- [ ] **Step 1: Create `pipeline-dashboard/web/src/components/RepoTable.jsx`**

```jsx
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Paper from '@mui/material/Paper';
import Link from '@mui/material/Link';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useState } from 'react';
import StatusChip from './StatusChip.jsx';

const BOOL_COLUMNS = [
  { key: 'inPipelines', label: 'In Pipelines' },
  { key: 'clonedLocally', label: 'Cloned' },
  { key: 'githubActions', label: 'GH Actions' },
  { key: 'jenkins', label: 'Jenkins' },
  { key: 'dockerfile', label: 'Dockerfile' },
];

function BoolCell({ value }) {
  return value ? (
    <CheckCircleIcon fontSize="small" color="success" titleAccess="yes" />
  ) : (
    <CancelIcon fontSize="small" color="disabled" titleAccess="no" />
  );
}

export default function RepoTable({ repos }) {
  const [orderBy, setOrderBy] = useState('fullName');
  const [order, setOrder] = useState('asc');

  const handleSort = (key) => {
    if (orderBy === key) {
      setOrder(order === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(key);
      setOrder('asc');
    }
  };

  const sorted = [...repos].sort((a, b) => {
    const av = a[orderBy];
    const bv = b[orderBy];
    let cmp;
    if (orderBy === 'latestBuild') {
      cmp = String(a.latestBuild?.status).localeCompare(String(b.latestBuild?.status));
    } else if (typeof av === 'boolean') {
      cmp = av === bv ? 0 : av ? -1 : 1;
    } else {
      cmp = String(av).localeCompare(String(bv));
    }
    return order === 'asc' ? cmp : -cmp;
  });

  return (
    <TableContainer component={Paper}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell sortDirection={orderBy === 'fullName' ? order : false}>
              <TableSortLabel
                active={orderBy === 'fullName'}
                direction={orderBy === 'fullName' ? order : 'asc'}
                onClick={() => handleSort('fullName')}
              >
                Repo
              </TableSortLabel>
            </TableCell>
            {BOOL_COLUMNS.map((col) => (
              <TableCell key={col.key} align="center">
                <TableSortLabel
                  active={orderBy === col.key}
                  direction={orderBy === col.key ? order : 'asc'}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                </TableSortLabel>
              </TableCell>
            ))}
            <TableCell>
              <TableSortLabel
                active={orderBy === 'latestBuild'}
                direction={orderBy === 'latestBuild' ? order : 'asc'}
                onClick={() => handleSort('latestBuild')}
              >
                Latest Build
              </TableSortLabel>
            </TableCell>
            <TableCell>Link</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((repo) => (
            <TableRow key={repo.fullName} hover>
              <TableCell>{repo.name}</TableCell>
              {BOOL_COLUMNS.map((col) => (
                <TableCell key={col.key} align="center">
                  <BoolCell value={repo[col.key]} />
                </TableCell>
              ))}
              <TableCell>
                <StatusChip
                  status={repo.latestBuild?.status || 'unknown'}
                  title={repo.error || ''}
                />
              </TableCell>
              <TableCell>
                <Link href={repo.url} target="_blank" rel="noopener">
                  <OpenInNewIcon fontSize="small" />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
```

- [ ] **Step 2: Create `pipeline-dashboard/web/src/components/DashboardToolbar.jsx`**

```jsx
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import RefreshIcon from '@mui/icons-material/Refresh';

export default function DashboardToolbar({
  total,
  query,
  onQueryChange,
  onRefresh,
  loading,
  generatedAt,
  rateLimitRemaining,
}) {
  return (
    <Toolbar sx={{ gap: 2, flexWrap: 'wrap', py: 1 }}>
      <Typography variant="h6" sx={{ flexShrink: 0 }}>
        EP Pipeline Dashboard
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {total} repos
      </Typography>
      <TextField
        size="small"
        placeholder="Search repos…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.secondary">
        {generatedAt ? `Updated ${new Date(generatedAt).toLocaleTimeString()}` : ''}
        {rateLimitRemaining != null ? ` · API left: ${rateLimitRemaining}` : ''}
      </Typography>
      <Button
        variant="contained"
        startIcon={<RefreshIcon />}
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </Button>
    </Toolbar>
  );
}
```

- [ ] **Step 3: Create `pipeline-dashboard/web/src/App.jsx`**

```jsx
import { useEffect, useMemo, useState } from 'react';
import Container from '@mui/material/Container';
import AppBar from '@mui/material/AppBar';
import Alert from '@mui/material/Alert';
import LinearProgress from '@mui/material/LinearProgress';
import Box from '@mui/material/Box';
import { fetchRepos, refreshRepos } from './api.js';
import RepoTable from './components/RepoTable.jsx';
import DashboardToolbar from './components/DashboardToolbar.jsx';

export default function App() {
  const [data, setData] = useState({ repos: [], generatedAt: null, rateLimitRemaining: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  async function load(refresh = false) {
    setLoading(true);
    setError(null);
    try {
      const result = refresh ? await refreshRepos() : await fetchRepos();
      setData(result);
    } catch (err) {
      setError(err.message || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data.repos;
    return data.repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [data.repos, query]);

  return (
    <Box>
      <AppBar position="static" color="default" elevation={1}>
        <DashboardToolbar
          total={data.repos.length}
          query={query}
          onQueryChange={setQuery}
          onRefresh={() => load(true)}
          loading={loading}
          generatedAt={data.generatedAt}
          rateLimitRemaining={data.rateLimitRemaining}
        />
      </AppBar>
      {loading && <LinearProgress />}
      <Container maxWidth={false} sx={{ py: 2 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <RepoTable repos={filtered} />
      </Container>
    </Box>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add pipeline-dashboard/web/src/components/RepoTable.jsx pipeline-dashboard/web/src/components/DashboardToolbar.jsx pipeline-dashboard/web/src/App.jsx
git commit -m "Add RepoTable, toolbar, and App with search/sort/refresh"
```

---

## Task 14: End-to-end verification + README

**Files:**
- Create: `pipeline-dashboard/README.md`

- [ ] **Step 1: Create `pipeline-dashboard/README.md`**

```markdown
# EP Pipeline Visibility Dashboard

Self-hosted, read-only dashboard listing every EP pipeline repository (union of repos
referenced in `ep-pipelines` and repos cloned in `TML_Repos`) with columns showing whether
GitHub Actions / Jenkins config / Dockerfile exist and the latest GitHub Actions build status.

## Prerequisites

- Node 18+
- A GitHub Personal Access Token with `repo` + `workflow` read scope

## Setup

```bash
cd pipeline-dashboard
cp .env.example .env          # then edit .env and set GITHUB_TOKEN
npm install
(cd web && npm install)
```

## Running

Terminal 1 — backend API:

```bash
cd pipeline-dashboard
export $(grep -v '^#' .env | xargs)
npm start
```

Terminal 2 — frontend dev server:

```bash
cd pipeline-dashboard/web
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend on port 4000.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `GITHUB_TOKEN` | (required) | PAT for the GitHub API |
| `TML_REPOS_PATH` | `/home/somasekhar/Desktop/TML_Repos` | Local repos directory |
| `EP_PIPELINES_PATH` | `$TML_REPOS_PATH/ep-pipelines` | ep-pipelines clone |
| `PORT` | `4000` | Backend port |
| `CACHE_TTL_SECONDS` | `300` | Cache lifetime for enriched data |

## Tests

```bash
cd pipeline-dashboard && npm test
```
```

- [ ] **Step 2: Run the backend test suite once more**

Run: `cd pipeline-dashboard && npm test`
Expected: PASS — all backend tests green.

- [ ] **Step 3: Start the backend with the real token and hit health**

Run:
```bash
cd pipeline-dashboard
GITHUB_TOKEN="$(gh auth token)" PORT=4000 node server/index.js &
sleep 2
curl -s http://localhost:4000/api/health
```
Expected: JSON like `{"ok":true,"rateLimitRemaining":...}`.

- [ ] **Step 4: Hit the repos endpoint and confirm real data**

Run: `curl -s http://localhost:4000/api/repos | head -c 600`
Expected: JSON with `generatedAt`, `rateLimitRemaining`, and a non-empty `repos` array whose entries include `inPipelines`, `clonedLocally`, `githubActions`, `dockerfile`, `jenkins`, `latestBuild`. Then stop the backend: `kill %1`.

- [ ] **Step 5: Build the frontend to confirm it compiles**

Run: `cd pipeline-dashboard/web && npm run build`
Expected: `dist/` produced with no build errors.

- [ ] **Step 6: Commit**

```bash
git add pipeline-dashboard/README.md
git commit -m "Add README and document setup, run, and verification steps"
```

---

## Task 15: Open the pull request

- [ ] **Step 1: Push the branch**

```bash
git push -u origin bot/pipeline-dashboard-design
```

- [ ] **Step 2: Create the PR**

```bash
gh pr create \
  --title "Add EP pipeline visibility dashboard" \
  --body "Adds a self-hosted, read-only dashboard listing every EP pipeline repository (union of repos referenced in ep-pipelines and repos cloned in TML_Repos) with columns showing whether GitHub Actions / Jenkins config / Dockerfile exist plus the latest GitHub Actions build status, fetched live from the GitHub API.

## Stack
- Backend: Node 18 + Express, Vitest
- Frontend: Vite + React 18 + Material-UI v5

## Verification
- Backend unit tests pass (npm test)
- /api/health and /api/repos verified against the live GitHub API
- Frontend builds clean (npm run build)

See pipeline-dashboard/README.md for setup and run instructions."
```

Expected: PR URL printed.

---

## Self-Review Notes

- **Spec coverage:** union repo list (Tasks 4–6), GH Actions existence + latest status (Task 8), Dockerfile w/ compose fallback (Task 8), Jenkins config-presence (Task 8), live GitHub API via PAT env var (Tasks 7, 10), concurrency cap + cache (Tasks 9, 10), table with all columns + status chips + search + sort + refresh + rate-limit display (Tasks 12, 13), error degradation per-repo (Task 8 `error` field + StatusChip tooltip), config + project layout + testing (Tasks 1–2, 10, 14). All spec sections mapped.
- **Type consistency:** repo object shape (`owner`, `name`, `fullName`, `url`, `inPipelines`, `clonedLocally`, `githubActions`, `dockerfile`, `jenkins`, `latestBuild:{status,url}`, `error`) is identical across `buildRepoList`, `enrichRepo`, the API response, and `RepoTable`. Function names consistent: `loadConfig`, `parseRepoUrl`, `scanPipelineRepos`, `scanLocalRepos`, `buildRepoList`, `createGithubClient`, `enrichRepo`, `enrichAll`, `createApp`/`startServer`, `fetchRepos`/`refreshRepos`.
- **Placeholders:** none — every code step contains complete code.

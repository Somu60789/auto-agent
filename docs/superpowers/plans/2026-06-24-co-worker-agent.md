# Co-Worker Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser page to pipeline-dashboard that runs a multi-turn coding agent (the local `claude` CLI) against repos in `ALL_Repos`, shipping changes as branch + PR.

**Architecture:** New `server/agent/` modules wrap the `claude` CLI in headless stream-json mode, manage durable sessions (CLI transcripts + a JSON index), resolve/clone working copies under `ALL_REPOS_PATH`, and publish via the existing `githubClient`. A new React page streams turns over SSE. The dashboard is untouched; everything new is namespaced under `/api/agent`.

**Tech Stack:** Node 18+ ESM, Express 4, Vitest, child_process (`spawn`), `node:fs/promises`, React 18 + MUI 5 + Vite, axios + EventSource.

---

## File Structure

**Backend (create):**
- `pipeline-dashboard/server/agent/claudeRunner.js` — spawn `claude`, parse stream-json into events.
- `pipeline-dashboard/server/agent/workspace.js` — resolve/clone repos under `ALL_REPOS_PATH`, list repos.
- `pipeline-dashboard/server/agent/session.js` — in-memory session map + JSON index persistence.
- `pipeline-dashboard/server/agent/publish.js` — branch/commit/push/PR via `githubClient` + git.
- `pipeline-dashboard/server/agent/routes.js` — Express router mounting `/api/agent/*` + SSE.

**Backend (modify):**
- `pipeline-dashboard/server/config.js` — add `allReposPath`, `agentStateDir`, `claudeBin`.
- `pipeline-dashboard/server/index.js` — wire the agent router into `createApp`/`startServer`.

**Backend (tests, create):**
- `pipeline-dashboard/test/claudeRunner.test.js`
- `pipeline-dashboard/test/workspace.test.js`
- `pipeline-dashboard/test/session.test.js`
- `pipeline-dashboard/test/publish.test.js`
- `pipeline-dashboard/test/agentConfig.test.js`

**Frontend (create):**
- `pipeline-dashboard/web/src/pages/CoWorker.jsx` — repo picker, past-chat list, transcript, input, Create PR.

**Frontend (modify):**
- `pipeline-dashboard/web/src/api.js` — add `/api/agent/*` calls + stream helper.
- `pipeline-dashboard/web/src/App.jsx` — add a tab/route toggle between dashboard and co-worker.

---

## Conventions (read before starting)

- ESM everywhere, `node:` prefix for builtins (see `server/config.js`).
- Network/CLI/git-touching code NEVER throws on failure — it returns a result with an `error`
  field (see `server/githubClient.js`, `server/enrich.js`).
- All dependencies are constructor/argument-injected for testing: fakes keyed by input (see
  `test/enrich.test.js`'s `fakeClient`). No real network, no real CLI, no real git in tests.
- Run a single test file: `cd pipeline-dashboard && npm test -- test/<file>.test.js`.
- `parseNumber` in `config.js` preserves a deliberate `0` — reuse it for numeric env.

---

## Task 1: Config — agent paths

**Files:**
- Modify: `pipeline-dashboard/server/config.js`
- Test: `pipeline-dashboard/test/agentConfig.test.js`

- [ ] **Step 1: Write the failing test**

```js
// pipeline-dashboard/test/agentConfig.test.js
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

const base = { GITHUB_TOKEN: 't', TML_REPOS_PATH: '/home/x/TML_Repos' };

describe('loadConfig agent fields', () => {
  it('defaults allReposPath to a sibling ALL_Repos of TML_REPOS_PATH', () => {
    const c = loadConfig(base);
    expect(c.allReposPath).toBe(path.join('/home/x', 'ALL_Repos'));
  });

  it('defaults agentStateDir under allReposPath and claudeBin to "claude"', () => {
    const c = loadConfig(base);
    expect(c.agentStateDir).toBe(path.join('/home/x', 'ALL_Repos', '.co-worker'));
    expect(c.claudeBin).toBe('claude');
  });

  it('honors explicit overrides', () => {
    const c = loadConfig({ ...base, ALL_REPOS_PATH: '/data/repos', CLAUDE_BIN: '/usr/bin/claude' });
    expect(c.allReposPath).toBe('/data/repos');
    expect(c.agentStateDir).toBe(path.join('/data/repos', '.co-worker'));
    expect(c.claudeBin).toBe('/usr/bin/claude');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/agentConfig.test.js`
Expected: FAIL (`allReposPath` is undefined).

- [ ] **Step 3: Add fields to `loadConfig`**

In `server/config.js`, inside `loadConfig`, after `epPipelinesPath` is computed and before the
`return`, add:

```js
  const allReposPath =
    env.ALL_REPOS_PATH || path.join(path.dirname(tmlReposPath), 'ALL_Repos');
  const agentStateDir = env.AGENT_STATE_DIR || path.join(allReposPath, '.co-worker');
  const claudeBin = env.CLAUDE_BIN || 'claude';
```

Then add `allReposPath, agentStateDir, claudeBin,` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/agentConfig.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/config.js pipeline-dashboard/test/agentConfig.test.js
git commit -m "Add agent config paths to loadConfig"
```

---

## Task 2: claudeRunner — parse stream-json into events

**Files:**
- Create: `pipeline-dashboard/server/agent/claudeRunner.js`
- Test: `pipeline-dashboard/test/claudeRunner.test.js`

The `claude` CLI in `-p --output-format stream-json --verbose` mode emits one JSON object per
line. Relevant shapes: a `system` init line with `session_id`; `assistant` lines with
`message.content` (array of `{type:'text',text}` and `{type:'tool_use',name}`); a final
`result` line with `session_id` and `is_error`. We inject `spawnImpl` returning a fake child
with `stdout`/`stderr` (async-iterable or event-emitter) and an exit.

- [ ] **Step 1: Write the failing test**

```js
// pipeline-dashboard/test/claudeRunner.test.js
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { runTurn } from '../server/agent/claudeRunner.js';

function fakeChild(lines, { code = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // emit asynchronously after caller subscribes
  queueMicrotask(() => {
    for (const l of lines) child.stdout.emit('data', Buffer.from(l + '\n'));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

function fakeSpawn(lines, opts) {
  const calls = [];
  const impl = (bin, args, options) => {
    calls.push({ bin, args, options });
    return fakeChild(lines, opts);
  };
  impl.calls = calls;
  return impl;
}

const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
const asstLine = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', name: 'Edit' }] },
});
const resultLine = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false });

describe('runTurn', () => {
  it('parses session id, text, and tool-use events and returns final session id', async () => {
    const events = [];
    const spawnImpl = fakeSpawn([initLine, asstLine, resultLine]);
    const res = await runTurn(
      { cwd: '/repo', prompt: 'hi', sessionId: null, claudeBin: 'claude' },
      { spawnImpl, onEvent: (e) => events.push(e) }
    );
    expect(res.sessionId).toBe('sess-1');
    expect(res.error).toBe(null);
    expect(events).toContainEqual({ type: 'session', sessionId: 'sess-1' });
    expect(events).toContainEqual({ type: 'text', text: 'Hello' });
    expect(events).toContainEqual({ type: 'tool', name: 'Edit' });
    expect(events.at(-1)).toEqual({ type: 'result', error: null });
  });

  it('passes --resume when sessionId given', async () => {
    const spawnImpl = fakeSpawn([resultLine]);
    await runTurn(
      { cwd: '/repo', prompt: 'next', sessionId: 'sess-1', claudeBin: 'claude' },
      { spawnImpl, onEvent: () => {} }
    );
    const { args, options } = spawnImpl.calls[0];
    expect(args).toContain('--resume');
    expect(args).toContain('sess-1');
    expect(options.cwd).toBe('/repo');
  });

  it('returns an error event on non-zero exit without throwing', async () => {
    const events = [];
    const spawnImpl = fakeSpawn([], { code: 1, stderr: 'boom' });
    const res = await runTurn(
      { cwd: '/repo', prompt: 'x', sessionId: null, claudeBin: 'claude' },
      { spawnImpl, onEvent: (e) => events.push(e) }
    );
    expect(res.error).toMatch(/boom/);
    expect(events.at(-1)).toEqual({ type: 'result', error: res.error });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/claudeRunner.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `claudeRunner.js`**

```js
// pipeline-dashboard/server/agent/claudeRunner.js
import { spawn as nodeSpawn } from 'node:child_process';

function emitFromLine(line, onEvent, state) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  if (obj.session_id && obj.session_id !== state.sessionId) {
    state.sessionId = obj.session_id;
    onEvent({ type: 'session', sessionId: obj.session_id });
  }
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    for (const part of obj.message.content) {
      if (part.type === 'text' && part.text) onEvent({ type: 'text', text: part.text });
      else if (part.type === 'tool_use') onEvent({ type: 'tool', name: part.name });
    }
  }
  if (obj.type === 'result' && obj.is_error) {
    state.resultError = obj.subtype || 'agent reported an error';
  }
}

// Spawn the claude CLI for one turn. Streams parsed events via onEvent.
// Never throws: a spawn/exit failure resolves with { sessionId, error }.
export function runTurn(
  { cwd, prompt, sessionId, claudeBin = 'claude' },
  { spawnImpl = nodeSpawn, onEvent = () => {} } = {}
) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);

    let child;
    try {
      child = spawnImpl(claudeBin, args, { cwd });
    } catch (err) {
      const error = err.message || 'failed to spawn claude';
      onEvent({ type: 'result', error });
      resolve({ sessionId: sessionId || null, error });
      return;
    }

    const state = { sessionId: sessionId || null, resultError: null };
    let buf = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) emitFromLine(line, onEvent, state);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      const error = err.message || 'claude process error';
      onEvent({ type: 'result', error });
      resolve({ sessionId: state.sessionId, error });
    });
    child.on('close', (code) => {
      if (buf.trim()) emitFromLine(buf.trim(), onEvent, state);
      let error = null;
      if (code !== 0) error = stderr.trim() || `claude exited with code ${code}`;
      else if (state.resultError) error = state.resultError;
      onEvent({ type: 'result', error });
      resolve({ sessionId: state.sessionId, error });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/claudeRunner.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/agent/claudeRunner.js pipeline-dashboard/test/claudeRunner.test.js
git commit -m "Add claudeRunner: spawn claude CLI and parse stream-json"
```

---

## Task 3: workspace — resolve and clone repos

**Files:**
- Create: `pipeline-dashboard/server/agent/workspace.js`
- Test: `pipeline-dashboard/test/workspace.test.js`

`resolveRepo` maps a repo (parsed via the existing `parseRepoUrl` from `repoList.js`) to a dir
`<allReposPath>/<name>`. If it exists, return it; else `git clone` using the token. `listRepos`
returns subdirs of `allReposPath` that contain `.git` (excludes the `.co-worker` state dir).
Both `fs` and the clone function are injected. Tests use a real temp dir for `fs`, a fake clone.

- [ ] **Step 1: Write the failing test**

```js
// pipeline-dashboard/test/workspace.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/workspace.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `workspace.js`**

```js
// pipeline-dashboard/server/agent/workspace.js
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseRepoUrl } from '../repoList.js';

const execFileAsync = promisify(execFile);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultClone(url, dest) {
  await execFileAsync('git', ['clone', url, dest]);
}

// Resolve a repo reference (full URL or owner/name) to a working-copy dir under
// allReposPath, cloning with the token if it isn't present yet.
// ponytail: owner is accepted now for the multi-user seam but unused single-user.
export async function resolveRepo(
  { allReposPath, token /*, owner */ },
  ref,
  { cloneImpl = defaultClone } = {}
) {
  const parsed = parseRepoUrl(String(ref).trim() + ' ');
  if (!parsed) throw new Error(`Unrecognized repo reference: ${ref}`);
  const dest = path.join(allReposPath, parsed.name);
  if (await exists(path.join(dest, '.git'))) return dest;
  await fs.mkdir(allReposPath, { recursive: true });
  const authUrl = `https://${token}@github.com/${parsed.fullName}.git`;
  await cloneImpl(authUrl, dest);
  return dest;
}

export async function listRepos(allReposPath) {
  let entries;
  try {
    entries = await fs.readdir(allReposPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (await exists(path.join(allReposPath, e.name, '.git'))) names.push(e.name);
  }
  return names;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/workspace.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/agent/workspace.js pipeline-dashboard/test/workspace.test.js
git commit -m "Add workspace: resolve/clone repos under ALL_Repos"
```

---

## Task 4: session — lifecycle and durable index

**Files:**
- Create: `pipeline-dashboard/server/agent/session.js`
- Test: `pipeline-dashboard/test/session.test.js`

`createSessionStore({ stateDir, runner, now })` returns `{ create, get, list, sendMessage,
load }`. Sessions live in a `Map` keyed by id; the index (subset of fields) is written to
`<stateDir>/sessions.json` on every mutation and reloaded by `load()`. `sendMessage` calls the
injected `runner.runTurn`, appends events to the in-memory transcript, and persists the
returned `claudeSessionId`. `now` is injected for deterministic timestamps/ids.

- [ ] **Step 1: Write the failing test**

```js
// pipeline-dashboard/test/session.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionStore } from '../server/agent/session.js';

let dir;
let counter;
const now = () => 1000 + counter++; // deterministic increasing clock
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sess-'));
  counter = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeRunner(sessionId = 'claude-1', error = null) {
  const calls = [];
  return {
    calls,
    runTurn: async ({ cwd, prompt, sessionId: prev }, { onEvent }) => {
      calls.push({ cwd, prompt, prev });
      onEvent({ type: 'text', text: 'ok' });
      onEvent({ type: 'result', error });
      return { sessionId, error };
    },
  };
}

describe('session store', () => {
  it('creates a session and persists it to the index', async () => {
    const store = createSessionStore({ stateDir: dir, runner: fakeRunner(), now });
    const s = await store.create({ repos: ['a'], cwd: '/repo/a', title: 'fix a' });
    expect(s.id).toBeTruthy();
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'sessions.json'), 'utf8'));
    expect(raw.find((r) => r.id === s.id).title).toBe('fix a');
  });

  it('sendMessage runs a turn, records transcript, and stores claudeSessionId, resuming next time', async () => {
    const runner = fakeRunner('claude-xyz');
    const store = createSessionStore({ stateDir: dir, runner, now });
    const s = await store.create({ repos: ['a'], cwd: '/repo/a', title: 't' });
    await store.sendMessage(s.id, 'hello');
    expect(runner.calls[0].prev).toBe(null);
    const after = store.get(s.id);
    expect(after.claudeSessionId).toBe('claude-xyz');
    expect(after.transcript).toContainEqual({ type: 'text', text: 'ok' });
    await store.sendMessage(s.id, 'again');
    expect(runner.calls[1].prev).toBe('claude-xyz'); // resumes
  });

  it('reloads sessions from the index on a fresh store (survives restart)', async () => {
    const store1 = createSessionStore({ stateDir: dir, runner: fakeRunner(), now });
    const s = await store1.create({ repos: ['a'], cwd: '/repo/a', title: 'persist' });
    await store1.sendMessage(s.id, 'hi');
    const store2 = createSessionStore({ stateDir: dir, runner: fakeRunner(), now });
    await store2.load();
    const reloaded = store2.get(s.id);
    expect(reloaded.title).toBe('persist');
    expect(reloaded.claudeSessionId).toBe('claude-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/session.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `session.js`**

```js
// pipeline-dashboard/server/agent/session.js
import fs from 'node:fs/promises';
import path from 'node:path';

const INDEX_FIELDS = ['id', 'owner', 'title', 'repos', 'cwd', 'claudeSessionId', 'status', 'prUrl', 'createdAt'];

function indexRecord(s) {
  const r = {};
  for (const f of INDEX_FIELDS) r[f] = s[f];
  return r;
}

// In-memory session map + JSON index persistence. Transcripts live in memory
// (the claude CLI durably stores the real conversation; we replay via --resume).
export function createSessionStore({ stateDir, runner, now = () => Date.now(), owner = 'default' }) {
  const sessions = new Map();
  const indexPath = path.join(stateDir, 'sessions.json');

  async function persist() {
    await fs.mkdir(stateDir, { recursive: true });
    const arr = [...sessions.values()].map(indexRecord);
    await fs.writeFile(indexPath, JSON.stringify(arr, null, 2));
  }

  async function load() {
    let arr;
    try {
      arr = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    } catch {
      return;
    }
    for (const r of arr) sessions.set(r.id, { ...r, transcript: [] });
  }

  async function create({ repos, cwd, title }) {
    const id = `s_${now()}`;
    const s = {
      id, owner, title: title || repos.join(', '), repos, cwd,
      claudeSessionId: null, status: 'idle', prUrl: null,
      createdAt: new Date(now()).toISOString(), transcript: [],
    };
    sessions.set(id, s);
    await persist();
    return s;
  }

  function get(id) {
    return sessions.get(id) || null;
  }

  function list() {
    return [...sessions.values()].map(indexRecord);
  }

  async function sendMessage(id, prompt, { onEvent = () => {} } = {}) {
    const s = sessions.get(id);
    if (!s) throw new Error(`Unknown session: ${id}`);
    s.status = 'running';
    s.transcript.push({ type: 'user', text: prompt });
    const capture = (e) => {
      s.transcript.push(e);
      onEvent(e);
    };
    const res = await runner.runTurn(
      { cwd: s.cwd, prompt, sessionId: s.claudeSessionId },
      { onEvent: capture }
    );
    if (res.sessionId) s.claudeSessionId = res.sessionId;
    s.status = res.error ? 'error' : 'idle';
    await persist();
    return res;
  }

  return { create, get, list, sendMessage, load, persist };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/session.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/agent/session.js pipeline-dashboard/test/session.test.js
git commit -m "Add session store with durable JSON index and resume"
```

---

## Task 5: publish — branch, commit, push, PR

**Files:**
- Create: `pipeline-dashboard/server/agent/publish.js`
- Test: `pipeline-dashboard/test/publish.test.js`

`publish({ cwd, repo, title, body }, { git, githubClient })` runs git steps in `cwd` then opens
a PR. `git` is an injected `(args, cwd) => Promise<{stdout}>`. It refuses if the computed branch
would be `main`/`master`. PR creation uses a `githubClient.post` helper (added here as part of
the existing client in Task 6 wiring — for this task the test injects a fake with `.post`).

- [ ] **Step 1: Write the failing test**

```js
// pipeline-dashboard/test/publish.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/publish.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `publish.js`**

```js
// pipeline-dashboard/server/agent/publish.js
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
  if (head === 'main' || head === 'master') {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/publish.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/agent/publish.js pipeline-dashboard/test/publish.test.js
git commit -m "Add publish: branch/commit/push and open PR"
```

---

## Task 6: githubClient — add POST

**Files:**
- Modify: `pipeline-dashboard/server/githubClient.js`
- Test: `pipeline-dashboard/test/githubClient.test.js` (append)

`publish` needs `githubClient.post`. Add it alongside `get`, same return shape, injecting
`fetchImpl`.

- [ ] **Step 1: Write the failing test (append to existing file)**

```js
// append to pipeline-dashboard/test/githubClient.test.js
import { createGithubClient } from '../server/githubClient.js';
import { describe, it, expect } from 'vitest';

describe('createGithubClient.post', () => {
  it('POSTs JSON with auth headers and returns the parsed body', async () => {
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return {
        status: 201, ok: true,
        headers: { get: () => '4999' },
        json: async () => ({ html_url: 'https://x/pull/1' }),
      };
    };
    const client = createGithubClient({ token: 'tok', fetchImpl });
    const res = await client.post('/repos/o/r/pulls', { title: 't' });
    expect(res.ok).toBe(true);
    expect(res.data.html_url).toBe('https://x/pull/1');
    expect(seen.opts.method).toBe('POST');
    expect(JSON.parse(seen.opts.body).title).toBe('t');
    expect(seen.opts.headers.Authorization).toBe('Bearer tok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/githubClient.test.js`
Expected: FAIL (`client.post is not a function`).

- [ ] **Step 3: Add `post` to `createGithubClient`**

In `server/githubClient.js`, add this function inside `createGithubClient` (after `get`), and
add `post` to the returned object:

```js
  async function post(pathname, body) {
    const response = await fetchImpl(`${API_BASE}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
```

Change `return { get, rateLimitRemaining: ... }` to `return { get, post, rateLimitRemaining: ... }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/githubClient.test.js`
Expected: PASS (existing + new test).

- [ ] **Step 5: Commit**

```bash
git add pipeline-dashboard/server/githubClient.js pipeline-dashboard/test/githubClient.test.js
git commit -m "Add post() to githubClient for PR creation"
```

---

## Task 7: agent routes — Express router + SSE

**Files:**
- Create: `pipeline-dashboard/server/agent/routes.js`
- Modify: `pipeline-dashboard/server/index.js`
- Test: covered via integration in `test/agentRoutes.test.js` (create)

`createAgentRouter({ config, store, client, resolveRepo, listRepos, publish })` returns an
Express router. SSE: each session gets an event emitter; `GET /:id/stream` subscribes and
flushes the existing transcript first, then live events. `sendMessage`'s `onEvent` forwards to
the emitter.

- [ ] **Step 1: Write the failing test**

```js
// pipeline-dashboard/test/agentRoutes.test.js
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createAgentRouter } from '../server/agent/routes.js';

function makeStore() {
  const s = { id: 's1', repos: ['r'], cwd: '/repo/r', transcript: [], claudeSessionId: null };
  return {
    create: async () => s,
    get: () => s,
    list: () => [{ id: 's1', title: 'r' }],
    sendMessage: async (id, prompt, { onEvent }) => {
      onEvent({ type: 'text', text: 'done' });
      return { sessionId: 'c1', error: null };
    },
  };
}

async function call(app, method, path, body) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  server.close();
  return { status: res.status, data };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', createAgentRouter({
    config: { allReposPath: '/all', githubToken: 't' },
    store: makeStore(),
    client: { post: async () => ({ ok: true, data: { html_url: 'u' } }) },
    resolveRepo: async () => '/repo/r',
    listRepos: async () => ['r'],
    publish: async () => ({ prUrl: 'https://x/pull/1', error: null }),
  }));
  return app;
}

describe('agent routes', () => {
  it('lists repos', async () => {
    const { status, data } = await call(buildApp(), 'GET', '/api/agent/repos');
    expect(status).toBe(200);
    expect(data.repos).toEqual(['r']);
  });

  it('creates a session', async () => {
    const { status, data } = await call(buildApp(), 'POST', '/api/agent/sessions', { repos: ['r'] });
    expect(status).toBe(200);
    expect(data.id).toBe('s1');
  });

  it('publishes and returns a PR url', async () => {
    const { status, data } = await call(buildApp(), 'POST', '/api/agent/s1/publish', { title: 't' });
    expect(status).toBe(200);
    expect(data.prUrl).toBe('https://x/pull/1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline-dashboard && npm test -- test/agentRoutes.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `routes.js`**

```js
// pipeline-dashboard/server/agent/routes.js
import express from 'express';
import { EventEmitter } from 'node:events';

export function createAgentRouter({ config, store, client, resolveRepo, listRepos, publish }) {
  const router = express.Router();
  const emitters = new Map(); // sessionId -> EventEmitter

  function emitterFor(id) {
    if (!emitters.has(id)) emitters.set(id, new EventEmitter());
    return emitters.get(id);
  }

  router.get('/repos', async (req, res) => {
    try {
      res.json({ repos: await listRepos(config.allReposPath) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/sessions', (req, res) => {
    res.json({ sessions: store.list() });
  });

  router.post('/sessions', async (req, res) => {
    try {
      const refs = req.body.repos || [];
      const dirs = [];
      for (const ref of refs) {
        dirs.push(await resolveRepo(
          { allReposPath: config.allReposPath, token: config.githubToken, owner: 'default' },
          ref
        ));
      }
      const cwd = dirs.length === 1 ? dirs[0] : config.allReposPath;
      const session = await store.create({ repos: refs, cwd, title: req.body.title });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id/stream', (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    for (const e of session.transcript) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const em = emitterFor(req.params.id);
    const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    em.on('event', onEvent);
    req.on('close', () => em.off('event', onEvent));
  });

  router.post('/:id/message', async (req, res) => {
    try {
      const em = emitterFor(req.params.id);
      const result = await store.sendMessage(req.params.id, req.body.prompt, {
        onEvent: (e) => em.emit('event', e),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/publish', async (req, res) => {
    try {
      const session = store.get(req.params.id);
      if (!session) return res.status(404).json({ error: 'unknown session' });
      const result = await publish({
        cwd: session.cwd,
        repo: parseRepoRef(session.repos[0]),
        title: req.body.title || session.title,
        body: req.body.body || '',
      }, { githubClient: client });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function parseRepoRef(ref) {
  const m = String(ref).match(/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return { owner: '', name: '', fullName: ref };
  return { owner: m[1], name: m[2], fullName: `${m[1]}/${m[2]}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline-dashboard && npm test -- test/agentRoutes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the router into `index.js`**

In `server/index.js`:
- Add imports at top:

```js
import { createAgentRouter } from './agent/routes.js';
import { createSessionStore } from './agent/session.js';
import { runTurn } from './agent/claudeRunner.js';
import { resolveRepo, listRepos } from './agent/workspace.js';
import { publish } from './agent/publish.js';
```

- Change `createApp` signature to accept `agentRouter`:

```js
export function createApp({ config, client, buildRepos, agentRouter }) {
```

- After `app.use(express.json());`, add:

```js
  if (agentRouter) app.use('/api/agent', agentRouter);
```

- In `startServer`, after `const client = ...`, build the store + router and pass it:

```js
  const runner = {
    runTurn: (turn, opts) => runTurn({ ...turn, claudeBin: config.claudeBin }, opts),
  };
  const store = createSessionStore({ stateDir: config.agentStateDir, runner });
  await store.load();
  const agentRouter = createAgentRouter({
    config, store, client, resolveRepo, listRepos, publish,
  });
  const app = createApp({ config, client, buildRepos, agentRouter });
```

Make `startServer` `async` (add `async` keyword) since it now awaits `store.load()`.

- [ ] **Step 6: Run the full backend suite**

Run: `cd pipeline-dashboard && npm test`
Expected: PASS (all existing + new files).

- [ ] **Step 7: Commit**

```bash
git add pipeline-dashboard/server/agent/routes.js pipeline-dashboard/server/index.js pipeline-dashboard/test/agentRoutes.test.js
git commit -m "Add agent router with SSE and wire into server"
```

---

## Task 8: frontend API client

**Files:**
- Modify: `pipeline-dashboard/web/src/api.js`

No frontend test suite exists; this is a thin client, verified manually in Task 10.

- [ ] **Step 1: Append agent calls to `api.js`**

```js
// append to pipeline-dashboard/web/src/api.js
export async function listAgentRepos() {
  const { data } = await axios.get('/api/agent/repos');
  return data.repos;
}

export async function listSessions() {
  const { data } = await axios.get('/api/agent/sessions');
  return data.sessions;
}

export async function createSession(repos, title) {
  const { data } = await axios.post('/api/agent/sessions', { repos, title });
  return data;
}

export async function sendMessage(id, prompt) {
  const { data } = await axios.post(`/api/agent/${id}/message`, { prompt });
  return data;
}

export async function publishSession(id, title, body) {
  const { data } = await axios.post(`/api/agent/${id}/publish`, { title, body });
  return data;
}

// Subscribe to a session's SSE stream. Returns the EventSource so the caller can close it.
export function streamSession(id, onEvent) {
  const es = new EventSource(`/api/agent/${id}/stream`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  return es;
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline-dashboard/web/src/api.js
git commit -m "Add agent API client calls and SSE stream helper"
```

---

## Task 9: CoWorker page

**Files:**
- Create: `pipeline-dashboard/web/src/pages/CoWorker.jsx`

- [ ] **Step 1: Implement the page**

```jsx
// pipeline-dashboard/web/src/pages/CoWorker.jsx
import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import {
  listAgentRepos, listSessions, createSession, sendMessage, publishSession, streamSession,
} from '../api.js';

export default function CoWorker() {
  const [repos, setRepos] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [repoInput, setRepoInput] = useState('');
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [prUrl, setPrUrl] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    listAgentRepos().then(setRepos).catch(() => {});
    listSessions().then(setSessions).catch(() => {});
  }, []);

  function openStream(id) {
    if (esRef.current) esRef.current.close();
    setEvents([]);
    esRef.current = streamSession(id, (e) => setEvents((prev) => [...prev, e]));
  }

  async function start() {
    setError(null);
    setPrUrl(null);
    try {
      const refs = repoInput.split(',').map((s) => s.trim()).filter(Boolean);
      const s = await createSession(refs, refs.join(', '));
      setSession(s);
      openStream(s.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function send() {
    if (!session || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await sendMessage(session.id, prompt);
      setPrompt('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function createPr() {
    setBusy(true);
    setError(null);
    try {
      const res = await publishSession(session.id, session.title, '');
      if (res.error) setError(res.error);
      else setPrUrl(res.prUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6">Co-Worker Agent</Typography>
      {!session && (
        <Stack direction="row" spacing={1} sx={{ my: 2 }}>
          <TextField
            fullWidth size="small"
            label="Repos (comma-separated names or GitHub links)"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            helperText={repos.length ? `Available: ${repos.join(', ')}` : 'No repos cloned yet'}
          />
          <Button variant="contained" onClick={start} disabled={!repoInput.trim()}>Start</Button>
        </Stack>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {session && (
        <>
          <Paper variant="outlined" sx={{ p: 2, my: 2, maxHeight: 400, overflow: 'auto', fontFamily: 'monospace', fontSize: 13 }}>
            {events.map((e, i) => (
              <Box key={i} sx={{ color: e.type === 'tool' ? 'primary.main' : e.error ? 'error.main' : 'text.primary' }}>
                {e.type === 'user' && <strong>&gt; {e.text}</strong>}
                {e.type === 'text' && e.text}
                {e.type === 'tool' && `[tool: ${e.name}]`}
                {e.type === 'result' && e.error && `Error: ${e.error}`}
              </Box>
            ))}
          </Paper>
          <Stack direction="row" spacing={1}>
            <TextField
              fullWidth size="small" multiline maxRows={4}
              placeholder="Ask the agent to make a change..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <Button variant="contained" onClick={send} disabled={busy || !prompt.trim()}>Send</Button>
            <Button variant="outlined" onClick={createPr} disabled={busy}>Create PR</Button>
          </Stack>
          {prUrl && <Alert severity="success" sx={{ mt: 2 }}>PR opened: <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a></Alert>}
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline-dashboard/web/src/pages/CoWorker.jsx
git commit -m "Add CoWorker page: chat, stream, and Create PR"
```

---

## Task 10: route between dashboard and co-worker, manual verify

**Files:**
- Modify: `pipeline-dashboard/web/src/App.jsx`

- [ ] **Step 1: Add a tab toggle in `App.jsx`**

Add imports near the top of `App.jsx`:

```js
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import CoWorker from './pages/CoWorker.jsx';
```

Add `const [tab, setTab] = useState('dashboard');` with the other `useState` hooks.

Inside the `<AppBar>`, above `<DashboardToolbar .../>`, add:

```jsx
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label="Dashboard" value="dashboard" />
          <Tab label="Co-Worker" value="coworker" />
        </Tabs>
```

Wrap the existing dashboard body so it only shows on the dashboard tab, and render `CoWorker`
otherwise. Replace the `<DashboardToolbar .../>` + body region so the toolbar and table render
only when `tab === 'dashboard'`, and `{tab === 'coworker' && <CoWorker />}` renders below the
`<AppBar>`. Keep the existing dashboard JSX intact inside the `tab === 'dashboard'` guard.

- [ ] **Step 2: Build the frontend to catch syntax errors**

Run: `cd pipeline-dashboard/web && npm install && npm run build`
Expected: build succeeds, no errors.

- [ ] **Step 3: Manual end-to-end verification**

```bash
# ensure the claude CLI is on PATH and ALL_Repos has at least one clone
cd pipeline-dashboard
export $(grep -v '^#' .env | xargs)   # GITHUB_TOKEN set
npm start &                            # backend :4000
(cd web && npm run dev)                # frontend :5173
```

Open http://localhost:5173, switch to the **Co-Worker** tab. Enter a repo name present in
`ALL_Repos`, click **Start**, send a small instruction (e.g. "add a comment to the README"),
confirm streamed text/tool lines appear, then click **Create PR** and confirm a PR URL returns.

Expected: transcript streams; a `bot/...` branch + PR is created; `main` is never pushed.

- [ ] **Step 4: Commit**

```bash
git add pipeline-dashboard/web/src/App.jsx
git commit -m "Add tab navigation between dashboard and co-worker"
```

---

## Task 11: docs

**Files:**
- Modify: `pipeline-dashboard/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the co-worker feature in README**

Add a `## Co-Worker Agent` section to `pipeline-dashboard/README.md` describing: the new
env vars (`ALL_REPOS_PATH`, `AGENT_STATE_DIR`, `CLAUDE_BIN`), the `claude` CLI prerequisite,
the Co-Worker tab usage flow (pick repos → chat → Create PR), and that all changes ship as a
`bot/` branch + PR.

- [ ] **Step 2: Update CLAUDE.md architecture section**

Add a short paragraph to `CLAUDE.md` under Architecture noting `server/agent/` (claudeRunner,
workspace, session, publish, routes), the `/api/agent/*` endpoints with SSE streaming, and that
the agent wraps the local `claude` CLI editing clones in `ALL_REPOS_PATH`.

- [ ] **Step 3: Commit**

```bash
git add pipeline-dashboard/README.md CLAUDE.md
git commit -m "Document co-worker agent feature"
```

---

## Self-Review Notes

- **Spec coverage:** engine wrap (Task 2), `ALL_Repos` resolve/clone (Task 3), durable
  sessions + index + resume (Task 4), shared-memory dir lives at `ALL_REPOS_PATH` root and is
  picked up by the CLI automatically since `cwd` is under it — no extra task needed; branch+PR
  with never-push-to-main (Tasks 5–6); SSE multi-turn chat + endpoints (Task 7); UI incl. past
  chats list and Create PR (Tasks 8–10); owner-seam for multi-user present in workspace/session
  signatures; config (Task 1); docs (Task 11).
- **Type consistency:** `runTurn(turn, {spawnImpl,onEvent})` used identically in Task 2 and the
  runner adapter in Task 7. `store.sendMessage(id, prompt, {onEvent})` consistent across Tasks
  4 and 7. `publish({cwd,repo,title,body},{git,githubClient})` consistent across Tasks 5 and 7.
  `githubClient.post(path, body)` defined in Task 6, used in Tasks 5 and 7.
- **Known simplification (ponytail):** shared-memory file is implicit via `cwd` under
  `ALL_REPOS_PATH`; if a separate memory dir is wanted later, pass `--add-dir`. Sessions
  in-memory + JSON index; add a store when multi-user lands.

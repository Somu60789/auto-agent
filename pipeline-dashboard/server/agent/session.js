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
    // Write-then-rename so a crash mid-write can't corrupt the durable index.
    const tmp = `${indexPath}.${now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(arr, null, 2));
    await fs.rename(tmp, indexPath);
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
    const t = now();
    const id = `s_${t}`;
    const s = {
      id, owner, title: title || repos.join(', '), repos, cwd,
      claudeSessionId: null, status: 'idle', prUrl: null,
      createdAt: new Date(t).toISOString(), transcript: [],
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
    // One turn at a time per session: a second concurrent turn would interleave
    // the transcript and race two --resume against the same CLI session.
    if (s.status === 'running') return { sessionId: s.claudeSessionId, error: 'A turn is already in progress' };
    s.status = 'running';
    s.transcript.push({ type: 'user', text: prompt });
    const capture = (e) => {
      s.transcript.push(e);
      onEvent(e);
    };
    let res;
    try {
      res = await runner.runTurn(
        { cwd: s.cwd, prompt, sessionId: s.claudeSessionId },
        { onEvent: capture }
      );
      if (res.sessionId) s.claudeSessionId = res.sessionId;
      s.status = res.error ? 'error' : 'idle';
    } catch (err) {
      // runner is contracted not to throw; if it does, don't strand the session
      // as 'running' forever.
      res = { sessionId: s.claudeSessionId, error: err.message || 'turn failed' };
      s.status = 'error';
    }
    await persist();
    return res;
  }

  return { create, get, list, sendMessage, load, persist };
}

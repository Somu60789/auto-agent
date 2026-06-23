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

  it('sets status to error when the turn reports an error', async () => {
    const store = createSessionStore({ stateDir: dir, runner: fakeRunner('claude-1', 'boom'), now });
    const s = await store.create({ repos: ['a'], cwd: '/repo/a', title: 't' });
    const res = await store.sendMessage(s.id, 'go');
    expect(res.error).toBe('boom');
    expect(store.get(s.id).status).toBe('error');
  });

  it('does not strand status as running if the runner throws', async () => {
    const throwingRunner = { runTurn: async () => { throw new Error('kaboom'); } };
    const store = createSessionStore({ stateDir: dir, runner: throwingRunner, now });
    const s = await store.create({ repos: ['a'], cwd: '/repo/a', title: 't' });
    const res = await store.sendMessage(s.id, 'go');
    expect(res.error).toMatch(/kaboom/);
    expect(store.get(s.id).status).toBe('error');
  });

  it('never writes transcript content to the index file', async () => {
    const store = createSessionStore({ stateDir: dir, runner: fakeRunner(), now });
    const s = await store.create({ repos: ['a'], cwd: '/repo/a', title: 't' });
    await store.sendMessage(s.id, 'secret prompt');
    const text = await fs.readFile(path.join(dir, 'sessions.json'), 'utf8');
    expect(text).not.toContain('transcript');
    expect(text).not.toContain('secret prompt');
  });

  it('load() no-ops on a missing index without throwing', async () => {
    const store = createSessionStore({ stateDir: dir, runner: fakeRunner(), now });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

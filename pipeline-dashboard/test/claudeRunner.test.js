import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { runTurn } from '../server/agent/claudeRunner.js';

function fakeChild(lines, { code = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
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

  it('emits exactly one terminal result event when error and close both fire', async () => {
    const events = [];
    // A real child can emit 'error' then still emit 'close'; assert we settle once.
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.emit('error', new Error('spawn ENOENT'));
        child.emit('close', 1);
      });
      return child;
    };
    const res = await runTurn(
      { cwd: '/repo', prompt: 'x', sessionId: null, claudeBin: 'claude' },
      { spawnImpl, onEvent: (e) => events.push(e) }
    );
    expect(res.error).toMatch(/ENOENT/);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1);
  });
});

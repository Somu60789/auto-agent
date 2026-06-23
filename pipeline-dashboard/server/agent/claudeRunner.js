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

import express from 'express';
import { EventEmitter } from 'node:events';

export function createAgentRouter({ config, store, client, resolveRepo, listRepos, publish }) {
  const router = express.Router();
  // sessionId -> EventEmitter. ponytail: never evicted; bounded by session count,
  // fine single-user. Add eviction when a session delete/archive route lands.
  const emitters = new Map();

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
      // Resolve each repo, but don't let a bad ref kill the whole session: a casual
      // question needs no repo, and an unresolvable repo shouldn't 500. Collect what
      // resolves and report the rest so the user knows it was skipped.
      const dirs = [];
      const warnings = [];
      for (const ref of refs) {
        try {
          dirs.push(await resolveRepo(
            { allReposPath: config.allReposPath, token: config.githubToken, owner: config.githubOwner },
            ref
          ));
        } catch (err) {
          // git errors echo the clone URL, which embeds the token — redact it.
          const safe = String(err.message).replace(/https:\/\/[^@\s]+@/g, 'https://');
          warnings.push(`${ref}: ${safe}`);
        }
      }
      const cwd = dirs.length === 1 ? dirs[0] : config.allReposPath;
      const session = await store.create({ repos: refs, cwd, title: req.body.title });
      res.json(warnings.length ? { ...session, warnings } : session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id/stream', (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    // Flush the backlog then subscribe in the same synchronous tick — no await may
    // sit between these two, or a turn event fired in the gap would be lost.
    for (const e of session.transcript) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const em = emitterFor(req.params.id);
    const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    em.on('event', onEvent);
    req.on('close', () => em.off('event', onEvent));
  });

  router.post('/:id/message', async (req, res) => {
    if (!store.get(req.params.id)) return res.status(404).json({ error: 'unknown session' });
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

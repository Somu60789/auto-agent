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

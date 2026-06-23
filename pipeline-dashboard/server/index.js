import express from 'express';
import { loadConfig } from './config.js';
import { createGithubClient } from './githubClient.js';
import { createCodecovClient } from './codecovClient.js';
import { buildRepoList } from './repoList.js';
import { enrichAll } from './enrich.js';

export function createApp({ config, client, buildRepos }) {
  const app = express();
  app.use(express.json());

  let cache = null;
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

export function startServer() {
  const config = loadConfig();
  const client = createGithubClient({ token: config.githubToken });
  const codecov = createCodecovClient({ token: config.codecovToken });
  const buildRepos = async () => {
    const repos = await buildRepoList({
      epPipelinesPath: config.epPipelinesPath,
      tmlReposPath: config.tmlReposPath,
    });
    return enrichAll(client, repos, { concurrency: 8, codecov });
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

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

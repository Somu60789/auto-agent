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

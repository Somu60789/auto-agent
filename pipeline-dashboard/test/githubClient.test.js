import { describe, it, expect, vi } from 'vitest';
import { createGithubClient } from '../server/githubClient.js';

function mockResponse({ status = 200, body = {}, headers = {} }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe('createGithubClient', () => {
  it('sends Authorization header and returns parsed json on 200', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { login: 'x' }, headers: { 'x-ratelimit-remaining': '42' } })
    );
    const client = createGithubClient({ token: 'tok', fetchImpl });
    const res = await client.get('/user');
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ login: 'x' });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer tok');
  });

  it('classifies 404 as notFound without throwing', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 404 }));
    const client = createGithubClient({ token: 'tok', fetchImpl });
    const res = await client.get('/repos/x/y/contents/Dockerfile');
    expect(res.status).toBe(404);
    expect(res.notFound).toBe(true);
  });

  it('tracks last rate-limit remaining', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: {}, headers: { 'x-ratelimit-remaining': '7' } })
    );
    const client = createGithubClient({ token: 'tok', fetchImpl });
    await client.get('/user');
    expect(client.rateLimitRemaining()).toBe(7);
  });
});

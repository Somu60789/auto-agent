import { describe, it, expect } from 'vitest';
import { enrichRepo } from '../server/enrich.js';
import { enrichAll } from '../server/enrich.js';

function fakeClient(routes) {
  return {
    get: async (pathname) => {
      const r = routes[pathname];
      if (!r) return { status: 404, ok: false, notFound: true, data: null };
      return { ok: r.status >= 200 && r.status < 300, notFound: r.status === 404, forbidden: r.status === 403, ...r };
    },
    rateLimitRemaining: () => 100,
  };
}

const base = {
  owner: 'tmlconnected',
  name: 'ep-home-ui',
  fullName: 'tmlconnected/ep-home-ui',
  url: 'https://github.com/tmlconnected/ep-home-ui',
  inPipelines: true,
  clonedLocally: true,
};

describe('enrichRepo', () => {
  it('detects workflows, dockerfile, and maps latest run conclusion', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows': {
        status: 200,
        data: [{ name: 'build.yml' }],
      },
      '/repos/tmlconnected/ep-home-ui/contents/Dockerfile': { status: 200, data: { name: 'Dockerfile' } },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': {
        status: 200,
        data: { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'https://x/runs/1' }] },
      },
    });
    const result = await enrichRepo(client, base);
    expect(result.githubActions).toBe(true);
    expect(result.dockerfile).toBe(true);
    expect(result.jenkins).toBe(true);
    expect(result.latestBuild).toEqual({ status: 'success', url: 'https://x/runs/1' });
    expect(result.error).toBeNull();
  });

  it('reports false/none when artifacts are absent', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': {
        status: 200,
        data: { workflow_runs: [] },
      },
    });
    const result = await enrichRepo(client, { ...base, inPipelines: false });
    expect(result.githubActions).toBe(false);
    expect(result.dockerfile).toBe(false);
    expect(result.jenkins).toBe(false);
    expect(result.latestBuild).toEqual({ status: 'none', url: null });
  });

  it('maps an in-progress run to running', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows': { status: 200, data: [{ name: 'a.yml' }] },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': {
        status: 200,
        data: { workflow_runs: [{ status: 'in_progress', conclusion: null, html_url: 'https://x/runs/2' }] },
      },
    });
    const result = await enrichRepo(client, base);
    expect(result.latestBuild.status).toBe('running');
  });

  it('detects a test directory and parses committed coverage summary', async () => {
    const summary = Buffer.from(
      JSON.stringify({ total: { lines: { pct: 87.5 } } })
    ).toString('base64');
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/test': { status: 200, data: [{ name: 'a.test.js' }] },
      '/repos/tmlconnected/ep-home-ui/contents/coverage/coverage-summary.json': {
        status: 200,
        data: { content: summary },
      },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.tests).toBe(true);
    expect(result.coverage).toBe(87.5);
  });

  it('reports tests false and coverage null when absent', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.tests).toBe(false);
    expect(result.coverage).toBeNull();
  });

  it('falls back to docker-compose.yml for the dockerfile flag', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/docker-compose.yml': { status: 200, data: { name: 'docker-compose.yml' } },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.dockerfile).toBe(true);
  });
});

describe('enrichAll', () => {
  it('enriches every repo and never exceeds the concurrency cap', async () => {
    let active = 0;
    let maxActive = 0;
    const client = {
      get: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return { ok: false, notFound: true, status: 404, data: null };
      },
      rateLimitRemaining: () => 99,
    };
    const repos = Array.from({ length: 20 }, (_, i) => ({
      owner: 'o',
      name: `r${i}`,
      fullName: `o/r${i}`,
      url: `https://github.com/o/r${i}`,
      inPipelines: false,
      clonedLocally: true,
    }));
    const results = await enrichAll(client, repos, { concurrency: 4 });
    expect(results).toHaveLength(20);
    // 4 workers, each enrichRepo fires up to 9 parallel gets
    // (workflows, Dockerfile, docker-compose, runs, 4 test dirs, coverage).
    expect(maxActive).toBeLessThanOrEqual(4 * 9);
    expect(results.every((r) => 'githubActions' in r)).toBe(true);
  });
});

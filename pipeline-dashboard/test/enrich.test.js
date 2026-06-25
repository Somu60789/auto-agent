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

  it('detects a test directory and reads coverage from Codecov', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/test': { status: 200, data: [{ name: 'a.test.js' }] },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const codecov = { coverage: async () => 87.5 };
    const result = await enrichRepo(client, base, { codecov });
    expect(result.tests).toBe(true);
    expect(result.coverage).toBe(87.5);
  });

  it('reports tests false and coverage null when absent / no codecov', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.tests).toBe(false);
    expect(result.coverage).toBeNull();
  });

  it('detects a Jira/ALM integration file', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.jira.yml': { status: 200, data: { name: '.jira.yml' } },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.jira).toBe(true);
  });

  it('detects Jira when a jira-* workflow actually calls a Jira action', async () => {
    const wf = Buffer.from('uses: atlassian/gajira-transition@v3').toString('base64');
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows': {
        status: 200,
        data: [{ name: 'build.yml' }, { name: 'jira-sync.yml', path: '.github/workflows/jira-sync.yml' }],
      },
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows/jira-sync.yml': {
        status: 200,
        data: { content: wf },
      },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
    });
    const result = await enrichRepo(client, base);
    expect(result.githubActions).toBe(true);
    expect(result.jira).toBe(true);
  });

  it('does NOT flag Jira for a jira-named workflow with no real Jira call', async () => {
    const wf = Buffer.from('run: echo "nothing to see"').toString('base64');
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows': {
        status: 200,
        data: [{ name: 'jira-sync.yml', path: '.github/workflows/jira-sync.yml' }],
      },
      '/repos/tmlconnected/ep-home-ui/contents/.github/workflows/jira-sync.yml': {
        status: 200,
        data: { content: wf },
      },
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
      '/repos/tmlconnected/ep-home-ui/commits?per_page=30': { status: 200, data: [] },
    });
    const result = await enrichRepo(client, base);
    expect(result.jira).toBe(false);
  });

  it('detects Jira from issue keys in recent commits', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
      '/repos/tmlconnected/ep-home-ui/commits?per_page=30': {
        status: 200,
        data: [{ commit: { message: 'chore: tidy' } }, { commit: { message: 'DAC-181 Add Jira integration' } }],
      },
    });
    const result = await enrichRepo(client, base);
    expect(result.jira).toBe(true);
  });

  it('ignores non-Jira prefixes like UTF-8 in commits', async () => {
    const client = fakeClient({
      '/repos/tmlconnected/ep-home-ui/actions/runs?per_page=1': { status: 200, data: { workflow_runs: [] } },
      '/repos/tmlconnected/ep-home-ui/commits?per_page=30': {
        status: 200,
        data: [{ commit: { message: 'UTF-8 encoding fix' } }, { commit: { message: 'CVE-2021 patch' } }],
      },
    });
    const result = await enrichRepo(client, base);
    expect(result.jira).toBe(false);
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
    // 4 workers, each enrichRepo fires up to 13 parallel client.gets
    // (workflows, Dockerfile, docker-compose, runs, 4 test dirs, 5 jira files).
    expect(maxActive).toBeLessThanOrEqual(4 * 13);
    expect(results.every((r) => 'githubActions' in r)).toBe(true);
  });
});

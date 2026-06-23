function mapLatestRun(runsData) {
  const runs = runsData?.workflow_runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    return { status: 'none', url: null };
  }
  const run = runs[0];
  let status;
  if (run.status !== 'completed') {
    status = 'running';
  } else if (run.conclusion === 'success') {
    status = 'success';
  } else if (run.conclusion === 'failure') {
    status = 'failure';
  } else {
    status = run.conclusion || 'unknown';
  }
  return { status, url: run.html_url || null };
}

async function pathExists(client, pathname) {
  const res = await client.get(pathname);
  return res.ok;
}

// Tests: true if any conventional test directory exists.
const TEST_DIRS = ['test', 'tests', '__tests__', 'spec'];
async function detectTests(client, prefix) {
  const checks = await Promise.all(
    TEST_DIRS.map((dir) => pathExists(client, `${prefix}/contents/${dir}`))
  );
  return checks.some(Boolean);
}

// Coverage: read a committed Istanbul coverage-summary.json if present and return
// total line coverage %. Returns null when no real number is available — we never
// fabricate a coverage figure (the GitHub API can't compute one live).
async function detectCoverage(client, prefix) {
  const res = await client.get(`${prefix}/contents/coverage/coverage-summary.json`);
  if (!res.ok || !res.data?.content) return null;
  try {
    const json = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    const pct = json?.total?.lines?.pct;
    return typeof pct === 'number' ? pct : null;
  } catch {
    return null;
  }
}

export async function enrichRepo(client, repo) {
  const { owner, name } = repo;
  const prefix = `/repos/${owner}/${name}`;
  try {
    const [workflows, dockerfile, dockerCompose, runs, tests, coverage] = await Promise.all([
      pathExists(client, `${prefix}/contents/.github/workflows`),
      pathExists(client, `${prefix}/contents/Dockerfile`),
      pathExists(client, `${prefix}/contents/docker-compose.yml`),
      client.get(`${prefix}/actions/runs?per_page=1`),
      detectTests(client, prefix),
      detectCoverage(client, prefix),
    ]);
    return {
      ...repo,
      githubActions: workflows,
      dockerfile: dockerfile || dockerCompose,
      jenkins: Boolean(repo.inPipelines),
      latestBuild: runs.ok ? mapLatestRun(runs.data) : { status: 'unknown', url: null },
      tests,
      coverage,
      error: null,
    };
  } catch (err) {
    return {
      ...repo,
      githubActions: false,
      dockerfile: false,
      jenkins: Boolean(repo.inPipelines),
      latestBuild: { status: 'unknown', url: null },
      tests: false,
      coverage: null,
      error: err.message || 'enrichment failed',
    };
  }
}

export async function enrichAll(client, repos, { concurrency = 8 } = {}) {
  const results = new Array(repos.length);
  let cursor = 0;
  async function worker() {
    while (cursor < repos.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await enrichRepo(client, repos[index]);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, repos.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

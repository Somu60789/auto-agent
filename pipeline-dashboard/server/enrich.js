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

// Jira / ALM: config-presence signal (like Jenkins). True if the repo carries a
// Jira/ALM integration marker file.
const JIRA_FILES = [
  '.jira.yml',
  'jira.yml',
  '.github/jira.yml',
  'atlassian-ide-plugin.xml',
  '.jira',
];
async function detectJira(client, prefix) {
  const checks = await Promise.all(
    JIRA_FILES.map((f) => pathExists(client, `${prefix}/contents/${f}`))
  );
  return checks.some(Boolean);
}

// Coverage: read the actual line coverage % from Codecov for this repo.
// Returns null when no Codecov client is configured or the repo isn't on Codecov —
// we never fabricate a figure (coverage only exists once a suite is run + reported).
async function detectCoverage(codecov, owner, name) {
  if (!codecov) return null;
  return codecov.coverage(owner, name);
}

export async function enrichRepo(client, repo, { codecov = null } = {}) {
  const { owner, name } = repo;
  const prefix = `/repos/${owner}/${name}`;
  try {
    const [workflows, dockerfile, dockerCompose, runs, tests, coverage, jira] = await Promise.all([
      pathExists(client, `${prefix}/contents/.github/workflows`),
      pathExists(client, `${prefix}/contents/Dockerfile`),
      pathExists(client, `${prefix}/contents/docker-compose.yml`),
      client.get(`${prefix}/actions/runs?per_page=1`),
      detectTests(client, prefix),
      detectCoverage(codecov, owner, name),
      detectJira(client, prefix),
    ]);
    return {
      ...repo,
      githubActions: workflows,
      dockerfile: dockerfile || dockerCompose,
      jenkins: Boolean(repo.inPipelines),
      latestBuild: runs.ok ? mapLatestRun(runs.data) : { status: 'unknown', url: null },
      tests,
      coverage,
      jira,
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
      jira: false,
      error: err.message || 'enrichment failed',
    };
  }
}

export async function enrichAll(client, repos, { concurrency = 8, codecov = null } = {}) {
  const results = new Array(repos.length);
  let cursor = 0;
  async function worker() {
    while (cursor < repos.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await enrichRepo(client, repos[index], { codecov });
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, repos.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

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

// Jira / ALM: detect *real* integration, not just a suggestively-named file.
// Three independent proofs, any of which is sufficient:
//   1. a Jira config file committed to the repo,
//   2. a jira-named workflow whose CONTENT calls a real Jira action / API,
//   3. recent commits that reference Jira issue keys (active use).
const JIRA_CONFIG_FILES = ['.jira.yml', 'jira.yml', 'atlassian-ide-plugin.xml', '.jira'];
// Markers that prove a workflow actually talks to Jira (not just named "jira").
const JIRA_ACTION_MARKERS = /atlassian\/gajira|atlassian\/jira|gajira|\.atlassian\.net|JIRA_(API|BASE|TOKEN|USER|URL|HOST)/i;
// Issue key at the start of a commit subject, e.g. "DAC-181 Add ...".
const ISSUE_KEY = /^([A-Z][A-Z0-9]+)-\d+\b/;
// Prefixes that look like issue keys but aren't (UTF-8, SHA-256, CVE-2021, ...).
const KEY_DENYLIST = new Set(['UTF', 'SHA', 'SHA1', 'SHA256', 'ISO', 'CVE', 'RFC', 'HTTP', 'HTTPS', 'IPV', 'IPV4', 'IPV6', 'MD5', 'BASE64', 'UTF8']);

function commitReferencesJira(message) {
  const m = (message || '').trim().match(ISSUE_KEY);
  return Boolean(m) && !KEY_DENYLIST.has(m[1]);
}

async function workflowCallsJira(client, prefix, workflowsList) {
  const named = (workflowsList || []).filter((f) => /jira/i.test(f?.name || ''));
  for (const wf of named) {
    const path = wf.path || `.github/workflows/${wf.name}`;
    const res = await client.get(`${prefix}/contents/${path}`);
    if (res.ok && res.data?.content) {
      const body = Buffer.from(res.data.content, 'base64').toString('utf8');
      if (JIRA_ACTION_MARKERS.test(body)) return true;
    }
  }
  return false;
}

async function detectJira(client, prefix, workflowsList) {
  const configHit = await Promise.all(
    JIRA_CONFIG_FILES.map((f) => pathExists(client, `${prefix}/contents/${f}`))
  );
  if (configHit.some(Boolean)) return true;
  if (await workflowCallsJira(client, prefix, workflowsList)) return true;
  // ponytail: 30 recent commits is enough to tell "actively linked to Jira"
  // from "not". Older history isn't worth the extra paging.
  const commits = await client.get(`${prefix}/commits?per_page=30`);
  if (commits.ok && Array.isArray(commits.data)) {
    return commits.data.some((c) => commitReferencesJira(c?.commit?.message));
  }
  return false;
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
    const [workflowsRes, dockerfile, dockerCompose, runs, tests, coverage] = await Promise.all([
      client.get(`${prefix}/contents/.github/workflows`),
      pathExists(client, `${prefix}/contents/Dockerfile`),
      pathExists(client, `${prefix}/contents/docker-compose.yml`),
      client.get(`${prefix}/actions/runs?per_page=1`),
      detectTests(client, prefix),
      detectCoverage(codecov, owner, name),
    ]);
    const workflowsList = Array.isArray(workflowsRes.data) ? workflowsRes.data : [];
    const jira = await detectJira(client, prefix, workflowsList);
    return {
      ...repo,
      githubActions: workflowsRes.ok,
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

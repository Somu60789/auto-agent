import path from 'node:path';

export function loadConfig(env = process.env) {
  const githubToken = env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }
  const tmlReposPath = env.TML_REPOS_PATH || '/home/somasekhar/Desktop/TML_Repos';
  const epPipelinesPath =
    env.EP_PIPELINES_PATH || path.join(tmlReposPath, 'ep-pipelines');
  const allReposPath =
    env.ALL_REPOS_PATH || path.join(path.dirname(tmlReposPath), 'ALL_Repos');
  const agentStateDir = env.AGENT_STATE_DIR || path.join(allReposPath, '.co-worker');
  const claudeBin = env.CLAUDE_BIN || 'claude';
  // Credential for the spawned `claude` CLI so it authenticates non-interactively
  // (no `~/.claude` login on a deployed host). Either works; API key takes precedence.
  const anthropicApiKey = env.ANTHROPIC_API_KEY || null;
  const claudeCodeOauthToken = env.CLAUDE_CODE_OAUTH_TOKEN || null;
  // Default GitHub org/user used to clone a repo typed by bare name in the agent.
  const githubOwner = env.GITHUB_OWNER || 'tmlconnected';
  return {
    githubToken,
    tmlReposPath,
    epPipelinesPath,
    allReposPath,
    agentStateDir,
    claudeBin,
    anthropicApiKey,
    claudeCodeOauthToken,
    githubOwner,
    // Optional Codecov token — without it, only public repos return coverage.
    codecovToken: env.CODECOV_TOKEN || null,
    port: parseNumber(env.PORT, 4000),
    cacheTtlSeconds: parseNumber(env.CACHE_TTL_SECONDS, 300),
  };
}

// Parse a numeric env var, falling back to the default only when unset/blank/NaN.
// Unlike `Number(x) || default`, this preserves a deliberate 0 (e.g. CACHE_TTL_SECONDS=0).
function parseNumber(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

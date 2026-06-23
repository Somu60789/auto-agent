import path from 'node:path';

export function loadConfig(env = process.env) {
  const githubToken = env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }
  const tmlReposPath = env.TML_REPOS_PATH || '/home/somasekhar/Desktop/TML_Repos';
  const epPipelinesPath =
    env.EP_PIPELINES_PATH || path.join(tmlReposPath, 'ep-pipelines');
  return {
    githubToken,
    tmlReposPath,
    epPipelinesPath,
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

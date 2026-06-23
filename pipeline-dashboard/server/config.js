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
    port: Number(env.PORT) || 4000,
    cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS) || 300,
  };
}

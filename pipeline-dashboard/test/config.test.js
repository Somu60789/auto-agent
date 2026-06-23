import { describe, it, expect } from 'vitest';
import { loadConfig } from '../server/config.js';

describe('loadConfig', () => {
  it('uses defaults when optional env vars are absent', () => {
    const cfg = loadConfig({ GITHUB_TOKEN: 'tok', TML_REPOS_PATH: '/repos' });
    expect(cfg.githubToken).toBe('tok');
    expect(cfg.tmlReposPath).toBe('/repos');
    expect(cfg.epPipelinesPath).toBe('/repos/ep-pipelines');
    expect(cfg.port).toBe(4000);
    expect(cfg.cacheTtlSeconds).toBe(300);
  });

  it('honors explicit EP_PIPELINES_PATH, PORT and CACHE_TTL_SECONDS', () => {
    const cfg = loadConfig({
      GITHUB_TOKEN: 'tok',
      TML_REPOS_PATH: '/repos',
      EP_PIPELINES_PATH: '/custom/ep',
      PORT: '8080',
      CACHE_TTL_SECONDS: '60',
    });
    expect(cfg.epPipelinesPath).toBe('/custom/ep');
    expect(cfg.port).toBe(8080);
    expect(cfg.cacheTtlSeconds).toBe(60);
  });

  it('throws when GITHUB_TOKEN is missing', () => {
    expect(() => loadConfig({ TML_REPOS_PATH: '/repos' })).toThrow(/GITHUB_TOKEN/);
  });
});

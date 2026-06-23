import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadConfig } from '../server/config.js';

const base = { GITHUB_TOKEN: 't', TML_REPOS_PATH: '/home/x/TML_Repos' };

describe('loadConfig agent fields', () => {
  it('defaults allReposPath to a sibling ALL_Repos of TML_REPOS_PATH', () => {
    const c = loadConfig(base);
    expect(c.allReposPath).toBe(path.join('/home/x', 'ALL_Repos'));
  });

  it('defaults agentStateDir under allReposPath and claudeBin to "claude"', () => {
    const c = loadConfig(base);
    expect(c.agentStateDir).toBe(path.join('/home/x', 'ALL_Repos', '.co-worker'));
    expect(c.claudeBin).toBe('claude');
  });

  it('honors explicit overrides', () => {
    const c = loadConfig({ ...base, ALL_REPOS_PATH: '/data/repos', CLAUDE_BIN: '/usr/bin/claude' });
    expect(c.allReposPath).toBe('/data/repos');
    expect(c.agentStateDir).toBe(path.join('/data/repos', '.co-worker'));
    expect(c.claudeBin).toBe('/usr/bin/claude');
  });
});

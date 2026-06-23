import { describe, it, expect } from 'vitest';
import { parseRepoUrl } from '../server/repoList.js';

describe('parseRepoUrl', () => {
  it('parses an https .git url', () => {
    expect(parseRepoUrl('https://github.com/tmlconnected/ep-home-ui.git')).toEqual({
      owner: 'tmlconnected',
      name: 'ep-home-ui',
      fullName: 'tmlconnected/ep-home-ui',
      url: 'https://github.com/tmlconnected/ep-home-ui',
    });
  });

  it('parses an https url without .git suffix', () => {
    expect(parseRepoUrl('https://github.com/tmlconnected/ep-andon-jlr')).toEqual({
      owner: 'tmlconnected',
      name: 'ep-andon-jlr',
      fullName: 'tmlconnected/ep-andon-jlr',
      url: 'https://github.com/tmlconnected/ep-andon-jlr',
    });
  });

  it('parses an ssh git url', () => {
    expect(parseRepoUrl('git@github.com:tmlconnected/ep-eloto.git')).toEqual({
      owner: 'tmlconnected',
      name: 'ep-eloto',
      fullName: 'tmlconnected/ep-eloto',
      url: 'https://github.com/tmlconnected/ep-eloto',
    });
  });

  it('returns null for a non-github url', () => {
    expect(parseRepoUrl('https://example.com/foo/bar.git')).toBeNull();
  });
});

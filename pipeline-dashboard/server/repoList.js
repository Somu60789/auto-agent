const GITHUB_URL_RE =
  /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?(?:\s|$|["'])/;

export function parseRepoUrl(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(GITHUB_URL_RE);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
  };
}

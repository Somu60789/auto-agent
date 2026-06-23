const API_BASE = 'https://api.codecov.io/api/v2';

// Reads line coverage % for a repo from Codecov's public API.
// Returns a number (e.g. 87.5) or null when the repo isn't on Codecov / has no data.
export function createCodecovClient({ token = null, fetchImpl = fetch } = {}) {
  async function coverage(owner, repo) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchImpl(`${API_BASE}/github/${owner}/repos/${repo}/`, { headers });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let data;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    const pct = data?.totals?.coverage;
    return typeof pct === 'number' ? pct : null;
  }
  return { coverage };
}

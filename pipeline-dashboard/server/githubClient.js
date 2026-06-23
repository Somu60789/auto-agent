const API_BASE = 'https://api.github.com';

export function createGithubClient({ token, fetchImpl = fetch }) {
  let lastRemaining = null;

  async function get(pathname) {
    const response = await fetchImpl(`${API_BASE}${pathname}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) lastRemaining = Number(remaining);

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      notFound: response.status === 404,
      forbidden: response.status === 403,
      data,
    };
  }

  return {
    get,
    rateLimitRemaining: () => lastRemaining,
  };
}

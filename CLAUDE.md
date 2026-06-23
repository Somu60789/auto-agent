# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`pipeline-dashboard/` is the only real project: a self-hosted, read-only dashboard that
lists every EP pipeline repository and shows, per repo, whether GitHub Actions / Jenkins
config / a Dockerfile exist plus the latest GitHub Actions build status. It is two separate
npm packages — an Express API (`server/`) and a Vite + React + MUI SPA (`web/`). `docs/`
holds the design spec and plan; `co-worker/` is empty.

## Commands

All commands run from `pipeline-dashboard/`:

```bash
npm install && (cd web && npm install)   # install both packages (separate node_modules)
npm test                                  # run backend tests (vitest)
npm test -- test/enrich.test.js           # run one test file
npm start                                 # backend on :4000 (needs GITHUB_TOKEN in env)
npm run dev                               # backend with --watch
(cd web && npm run dev)                   # frontend dev server on :5173, proxies /api -> :4000
(cd web && npm run build)                 # production frontend build
```

The backend requires `GITHUB_TOKEN` (a PAT with `repo` + `workflow` read scope). Copy
`.env.example` to `.env`, set the token, then `export $(grep -v '^#' .env | xargs)` before
`npm start`. There is no frontend test suite.

## Architecture

The backend builds its repo list from the **union of two local sources**, then enriches each
entry via the GitHub API. The pipeline is a clean chain of pure-ish modules wired together in
`server/index.js`:

- **`repoList.js`** — discovers repos with no network calls. `scanPipelineRepos` walks every
  file under `EP_PIPELINES_PATH` and regex-extracts GitHub URLs (these get `inPipelines:
  true`, treated as Jenkins-managed). `scanLocalRepos` reads each `<TML_REPOS_PATH>/*/.git/config`
  origin URL (`clonedLocally: true`). `buildRepoList` merges both by `fullName`.
- **`enrich.js`** — `enrichRepo` makes 4 parallel GitHub calls per repo (workflows dir,
  Dockerfile, docker-compose, latest run) and never throws — on error it returns the repo
  with `error` set and safe defaults. `enrichAll` runs a fixed worker pool (default
  concurrency 8) over the list.
- **`githubClient.js`** — thin `fetch` wrapper returning `{status, ok, notFound, forbidden,
  data}` (never throws on HTTP errors) and tracking `x-ratelimit-remaining`. `fetchImpl` is
  injectable for tests.
- **`index.js`** — `createApp` holds a single in-memory cache (`/api/repos` serves cached
  data, refreshing only when stale per `CACHE_TTL_SECONDS`; `/api/refresh` forces a rebuild;
  `/api/health` reports rate limit). `createApp` takes its deps as args so tests inject fakes;
  `startServer` is the real wiring.

Frontend: `web/src/App.jsx` owns all state and calls `api.js` (axios → `/api/repos`,
`/api/refresh`). Components (`RepoTable`, `DashboardToolbar`, `StatusChip`) are presentational.

## Conventions

- ES modules everywhere (`"type": "module"`); use `node:` prefix for built-ins.
- The dependency-injection seam (`createApp({config, client, buildRepos})`,
  `createGithubClient({fetchImpl})`) is how everything is tested — preserve it. Tests use fake
  clients keyed by request path (see `test/enrich.test.js`), no network or real filesystem
  beyond `test/fixtures/`.
- GitHub-touching code must not throw on API failure; degrade to `unknown`/`false` + an
  `error` field instead.
- When parsing numeric env vars, use `config.js`'s `parseNumber` (preserves a deliberate `0`).

## Attribution

Per the global instructions: never reference Claude/Anthropic/AI in any commit, PR, comment,
or committed file; no `Co-Authored-By` or "Generated with" trailers. Never push to `main` —
branch (`bot/...`) and open a PR.

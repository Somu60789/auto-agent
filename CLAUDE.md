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
`/api/refresh`). It has two tabs — the dashboard and the Co-Worker page
(`web/src/pages/CoWorker.jsx`). Components (`RepoTable`, `DashboardToolbar`, `StatusChip`) are
presentational.

### Co-Worker agent (`server/agent/`)

A second feature mounted under `/api/agent/*` (SSE for live turn output): a multi-turn coding
agent that wraps the local `claude` CLI to edit repos in `ALL_REPOS_PATH` and ship changes as
a `bot/` branch + PR. Same DI/never-throw conventions as the dashboard. The chain:

- **`claudeRunner.js`** — spawns `claude -p --output-format stream-json --resume <id?>` for one
  turn and parses the line-delimited JSON into events. Injectable `spawnImpl`; never throws.
- **`workspace.js`** — `resolveRepo` maps a repo ref to a working copy under `ALL_REPOS_PATH`
  (bare name → existing clone; `owner/name`/URL → clone on demand with the token). `listRepos`
  enumerates clones.
- **`session.js`** — `createSessionStore` keeps sessions in memory and persists a small JSON
  index (`AGENT_STATE_DIR/sessions.json`) — NOT transcripts (the CLI owns those, replayed via
  `--resume`). One turn per session at a time. `owner` defaults to `"default"` — a seam for
  future multi-user.
- **`publish.js`** — branch/commit/push/PR via `githubClient.post`. Hard guard: refuses
  `main`/`master` (normalized for case/whitespace/`refs/heads/`).
- **`routes.js`** — the `/api/agent` Express router; `index.js` wires the store + router into
  `createApp` (passed as `agentRouter`, mounted only when provided).

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

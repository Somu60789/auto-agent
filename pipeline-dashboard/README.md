# EP Pipeline Visibility Dashboard

Self-hosted, read-only dashboard listing every EP pipeline repository (union of repos
referenced in `ep-pipelines` and repos cloned in `TML_Repos`) with columns showing whether
GitHub Actions / Jenkins config / Dockerfile exist and the latest GitHub Actions build status.

## Prerequisites

- Node 18+
- A GitHub Personal Access Token with `repo` + `workflow` read scope

## Setup

```bash
cd pipeline-dashboard
cp .env.example .env          # then edit .env and set GITHUB_TOKEN
npm install
(cd web && npm install)
```

## Running

Terminal 1 — backend API:

```bash
cd pipeline-dashboard
export $(grep -v '^#' .env | xargs)
npm start
```

Terminal 2 — frontend dev server:

```bash
cd pipeline-dashboard/web
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend on port 4000.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `GITHUB_TOKEN` | (required) | PAT for the GitHub API |
| `TML_REPOS_PATH` | `/home/somasekhar/Desktop/TML_Repos` | Local repos directory |
| `EP_PIPELINES_PATH` | `$TML_REPOS_PATH/ep-pipelines` | ep-pipelines clone |
| `PORT` | `4000` | Backend port |
| `CACHE_TTL_SECONDS` | `300` | Cache lifetime for enriched data (0 = always refresh) |

## Tests

```bash
cd pipeline-dashboard && npm test
```

## Troubleshooting

If `npm run dev` or `npm test` crash with worker/OpenSSL errors, check whether
`NODE_OPTIONS=--openssl-legacy-provider` is set in your shell — it breaks Vite 5
and Vitest worker threads. Clear it for the command:

```bash
NODE_OPTIONS= npm run dev
NODE_OPTIONS= npm test
```

# EP Pipeline Visibility Dashboard

Self-hosted, read-only dashboard listing every EP pipeline repository (union of repos
referenced in `ep-pipelines` and repos cloned in `TML_Repos`) with columns showing whether
GitHub Actions / Jenkins config / Dockerfile exist and the latest GitHub Actions build status.

## Prerequisites

- Node 18+
- A GitHub Personal Access Token with `repo` + `workflow` read scope
- The `claude` CLI on `PATH` (only for the Co-Worker agent tab)

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
| `ALL_REPOS_PATH` | sibling `ALL_Repos` of `TML_REPOS_PATH` | Repos the Co-Worker agent edits; new repos clone here |
| `AGENT_STATE_DIR` | `$ALL_REPOS_PATH/.co-worker` | Co-Worker session index (`sessions.json`) |
| `CLAUDE_BIN` | `claude` | Path to the agent CLI binary |
| `ANTHROPIC_API_KEY` | (none) | Co-Worker auth via API billing — forwarded to the spawned `claude` CLI |
| `CLAUDE_CODE_OAUTH_TOKEN` | (none) | Co-Worker auth via Claude subscription (`claude setup-token`); used if no API key |
| `GITHUB_OWNER` | `tmlconnected` | Org/user for cloning a repo typed by bare name |
| `PORT` | `4000` | Backend port |
| `CACHE_TTL_SECONDS` | `300` | Cache lifetime for enriched data (0 = always refresh) |

## Co-Worker Agent

The **Co-Worker** tab is a browser-based coding agent that edits one or more repositories and
ships the changes as a pull request for you to approve on GitHub. It drives the local `claude`
CLI against working copies under `ALL_REPOS_PATH`.

Prerequisite: the `claude` CLI must be installed and on `PATH` (override with `CLAUDE_BIN`).

**Authentication.** Locally the CLI uses your interactive `claude` login. On a deployed host
there is no interactive login, so set one auth var in `.env` — `ANTHROPIC_API_KEY` (API
billing) or `CLAUDE_CODE_OAUTH_TOKEN` (subscription, from `claude setup-token`). The server
forwards it to the CLI. Without it, Co-Worker turns fail with a login/credentials error.

Usage:

1. Open the **Co-Worker** tab. Enter one or more repos — bare names already cloned in
   `ALL_Repos`, or `owner/name` / GitHub links (pasted links are cloned on demand using
   `GITHUB_TOKEN`).
2. Click **Start**, then chat with the agent. Each turn streams the assistant's output and
   tool calls live; follow-up messages continue the same conversation with full context.
3. Click **Create PR** when you're satisfied. The agent commits the working copy to a `bot/`
   branch, pushes it, and opens a PR. Nothing is ever pushed to `main`/`master`, and nothing
   merges automatically — you review and merge on GitHub.

Past conversations are listed as chips on the start screen; click one to resume it (sessions
survive a server restart — the index lives in `AGENT_STATE_DIR`).

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

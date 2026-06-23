# Pipeline Visibility Dashboard — Design

**Date:** 2026-06-23
**Status:** Approved for planning

## 1. Purpose

A self-hosted web dashboard that gives single-pane visibility across all EP pipeline
repositories. It shows one row per repository and columns indicating whether each build
artifact **exists** and the **latest build status**, fetched **live from the GitHub API**.

The intended audience is engineering leadership (CTO-facing demo) plus the DevSecOps team
who need an at-a-glance view of which repos have CI wired up and which builds are passing.

## 2. Scope

### Repository rows — union of two sources

1. **In Pipelines** — every GitHub repo referenced inside the `ep-pipelines` repo:
   - All `*.git` URLs found across the repo (~72 unique today).
   - All `auto_trigger_repo:` entries in `ci/seed-job/**/config.yaml` (~41 today).
2. **Cloned locally** — every git repository directory directly under
   `/home/somasekhar/Desktop/TML_Repos/` (~80 today).

Rows are the **union** of both sets, keyed by `owner/repo`. Two boolean columns flag which
set(s) each repo belongs to.

### Out of scope

- Live Jenkins build status. The Jenkins column reflects **config presence only** (whether the
  repo is wired into `ep-pipelines` seed-job / Jenkinsfiles), computed locally. No Jenkins API.
- Write actions (no triggering builds, no editing repos). Read-only dashboard.
- Authentication / multi-user accounts. Single-operator tool.

## 3. Architecture

```
┌─────────────┐     HTTP/JSON       ┌──────────────────┐    GitHub REST API
│  React UI   │ ◄─────────────────► │  Node/Express    │ ◄──────────────────►  api.github.com
│  (MUI table)│  /api/repos         │  backend         │    (PAT via env)
└─────────────┘  /api/refresh       └──────────────────┘
                                           │ reads local filesystem
                                           ▼
                                    ep-pipelines clone (parse repo URLs)
                                    TML_Repos dir   (list cloned repos)
```

### Frontend — Vite + React 18 + Material-UI v5

- Single-page app. One main data table plus a top toolbar.
- Fetches `/api/repos` on load; **Refresh** button calls `/api/refresh`.
- Sortable, filterable, searchable table.

### Backend — Node + Express

Three responsibilities:

1. **Build the repo list** (`repoList` module)
   - Parse the local `ep-pipelines` clone (`/home/somasekhar/Desktop/TML_Repos/ep-pipelines`)
     for `*.git` URLs and `auto_trigger_repo` entries → the "in pipelines" set.
   - List immediate subdirectories of `TML_Repos` that contain a `.git` directory and resolve
     each one's `origin` remote → the "cloned locally" set (keyed by `owner/repo`).
   - Union both, keyed by `owner/repo`.

2. **Enrich each repo via GitHub API** (`enrich` module)
   - Workflow present? — `GET /repos/{owner}/{repo}/contents/.github/workflows`
   - Latest build status — `GET /repos/{owner}/{repo}/actions/runs?per_page=1`
     → conclusion mapped to `success | failure | running | none`.
   - Dockerfile present? — `GET /repos/{owner}/{repo}/contents/Dockerfile` (and
     `docker-compose.yml` fallback).
   - Jenkins wired? — derived locally from step 1 (in the `ep-pipelines` set), no API call.
   - Concurrency-capped (~8 in flight), short in-memory TTL cache.

3. **Serve the API**
   - `GET /api/repos` — cached enriched list.
   - `POST /api/refresh` — force re-fetch (busts cache), returns fresh list.
   - `GET /api/health` — liveness + GitHub rate-limit remaining.

### Auth

- PAT supplied to the backend as the `GITHUB_TOKEN` environment variable.
- Stored as a GitHub Actions secret in the deploy environment; injected as the env var on the
  host that runs the backend. Never committed; `.env` is gitignored.

## 4. Data model

`/api/repos` returns:

```json
{
  "generatedAt": "2026-06-23T...Z",
  "rateLimitRemaining": 4873,
  "repos": [
    {
      "name": "ep-home-ui",
      "owner": "tmlconnected",
      "fullName": "tmlconnected/ep-home-ui",
      "url": "https://github.com/tmlconnected/ep-home-ui",
      "inPipelines": true,
      "clonedLocally": true,
      "githubActions": true,
      "jenkins": true,
      "dockerfile": true,
      "latestBuild": { "status": "success", "url": "https://github.com/.../runs/123" },
      "error": null
    }
  ]
}
```

`status` ∈ `success | failure | running | none | unknown`.

## 5. The table (UI)

| Repo | In Pipelines | Cloned | GH Actions | Jenkins | Dockerfile | Latest Build | Link |
|------|:---:|:---:|:---:|:---:|:---:|---|---|
| ep-home-ui | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 success | ↗ |
| ep-andon-jlr | ✅ | ❌ | ❌ | ✅ | ✅ | ⚪ none | ↗ |

- Existence cells: ✅ / ❌ chips.
- Latest Build: colored status chip — green `success`, red `failure`, amber `running`,
  grey `none`, hollow `unknown` (with tooltip on the underlying error).
- Toolbar: total repo count, count by status, free-text search (repo name), column filters,
  **Refresh** button, last-refreshed timestamp, GitHub rate-limit remaining.
- Columns sortable.

## 6. Error handling & rate limits

- ~72–80 repos × ~3 API calls each. Throttle with a concurrency cap (~8) plus in-memory cache
  with a short TTL so repeated `/api/repos` calls don't re-hit GitHub.
- Per-repo failures degrade gracefully: the row still renders, affected cells show `?` with a
  tooltip; the whole table never fails because of one repo.
- Distinguish private-repo `404` (not found / no access) from `403` (rate-limited /
  forbidden) in the cell tooltip.
- Surface remaining rate limit in the toolbar; warn when low.

## 7. Project layout

```
pipeline-dashboard/
  server/
    index.js            # Express app + routes
    repoList.js         # build union repo list from ep-pipelines + TML_Repos
    enrich.js           # GitHub API enrichment, concurrency + cache
    githubClient.js     # thin GitHub REST wrapper using GITHUB_TOKEN
    config.js           # paths (ep-pipelines, TML_Repos), port, TTL
  web/
    (Vite + React 18 + MUI v5 app)
    src/
      App.jsx
      api.js
      components/RepoTable.jsx
      components/Toolbar.jsx
      components/StatusChip.jsx
  .env.example          # GITHUB_TOKEN=, TML_REPOS_PATH=, PORT=
  README.md
```

## 8. Configuration

Env vars (with sensible defaults):

- `GITHUB_TOKEN` (required) — PAT with `repo` + `workflow` read scope.
- `TML_REPOS_PATH` — default `/home/somasekhar/Desktop/TML_Repos`.
- `EP_PIPELINES_PATH` — default `${TML_REPOS_PATH}/ep-pipelines`.
- `PORT` — default `4000` (backend); Vite dev server proxies `/api` to it.
- `CACHE_TTL_SECONDS` — default `300`.

## 9. Testing

- `repoList.js` — unit tests against a fixture `ep-pipelines` tree + fixture `TML_Repos` dir;
  assert correct union, `owner/repo` keying, and dedupe.
- `enrich.js` — unit tests with a mocked GitHub client: status mapping, missing-file → false,
  error → graceful `unknown`.
- `githubClient.js` — mocked HTTP; assert auth header + error classification (404 vs 403).
- A smoke test that boots the Express app and hits `/api/health`.

## 10. Non-goals / future

- Live Jenkins status (would need Jenkins URL + creds).
- Historical trends / build duration charts.
- Scheduled snapshot export to static hosting.

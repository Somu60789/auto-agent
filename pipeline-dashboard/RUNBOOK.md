# Local Demo Runbook

Step-by-step to run the dashboard locally for a live demo.

**Fast path:** `PORT=4100 ./demo.sh` brings up backend + frontend together (Ctrl-C
stops both), then open http://localhost:5173. The manual steps below are for when
you want the two halves in separate terminals.

**Stop everything:** `./stop.sh` — kills the backend and frontend by process name.
Use it when they were started in the background or another shell and Ctrl-C isn't
an option.

## 0. Prerequisites

- Node 18+
- A GitHub Personal Access Token (`repo` + `workflow` read scope)
- Local clones under `TML_REPOS_PATH` (default `/home/somasekhar/Desktop/TML_Repos`)

## 1. Configure `.env` (once)

```bash
cd pipeline-dashboard
cp .env.example .env          # then edit: set GITHUB_TOKEN
```

`.env` is gitignored — never commit it. Use `gh auth token` to grab a token if needed.

## 2. Pick ports

Backend default is `4000`. **If a port is taken, change it — don't fight it.**

```bash
ss -ltn 'sport = :4000'       # empty output = free
```

On this machine `4000` is owned by `nxserver.service`, so the demo uses **4100**:

- `.env` → `PORT=4100`
- The Vite proxy reads `API_PORT` (defaults to 4000), so start the frontend with `API_PORT=4100`.

To use a different port, change `PORT` in `.env` and pass the same value as `API_PORT` to the frontend.

## 3. Start the backend (terminal 1)

```bash
cd pipeline-dashboard
set -a; . ./.env; set +a       # load .env into the environment
export NODE_OPTIONS=           # clear legacy-provider flag (breaks Node otherwise)
node server/index.js
```

Verify:

```bash
curl -s http://localhost:4100/api/health      # -> {"ok":true,...}
```

## 4. Start the frontend (terminal 2)

```bash
cd pipeline-dashboard/web
API_PORT=4100 NODE_OPTIONS= npm run dev
```

Open **http://localhost:5173**. The UI is the Vite app on 5173 — the backend on
4100 serves only `/api/*`, so hitting 4100 in a browser shows nothing.

## 5. Demo flow

1. Table loads the union of pipeline + cloned repos with live GitHub data.
2. Columns: In Pipelines · Cloned · GitHub Actions · Jenkins · Dockerfile · Latest Build · Link.
3. "Refresh" re-fetches live (bypasses the cache).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on start | Port taken — pick another (step 2). |
| Worker / OpenSSL crash in Vite/Vitest | `NODE_OPTIONS=` was not cleared. Prefix the command with `NODE_OPTIONS=`. |
| UI loads but no data | Backend not running, or `API_PORT` ≠ backend `PORT`. |
| `curl localhost:<port>/` empty | Expected — backend only serves `/api/*`. |

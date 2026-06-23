# Co-Worker Agent — Design

**Date:** 2026-06-24
**Status:** Approved, pre-implementation

## Summary

A new page in the existing pipeline-dashboard web app that provides a multi-turn coding
agent — "like the `claude` CLI, but in the browser." It makes changes across one or more
repositories (ep-pipelines, ep-infrastructure, and any other repo on the user's GitHub
profile or pasted as a link), then ships those changes as a branch + pull request for the
user to approve on GitHub.

The agent is the **local `claude` CLI run in headless mode**, driven by the dashboard's
Express backend. The existing dashboard (repo list, status columns) is untouched; this is a
new `agent/` module set in `server/` plus a new page in `web/`.

## Goals

- Multi-turn chat with the agent, context preserved within a conversation (like the CLI).
- Edit one or multiple repos in a single session.
- Resume any past conversation with full context after a server restart.
- Shared long-term memory the agent reads/writes across all conversations.
- All changes leave the system only as a `bot/` branch + PR; nothing auto-merges, nothing
  ever pushes to `main`.

## Non-Goals (now)

- Multi-user / auth / per-user isolation. Designed *for* but not *built* — see "Future:
  Multi-user".
- A database. State is two on-disk things: a small session index we own, and the CLI's own
  durable transcripts/memory.
- Restricting the agent's tools. The agent has full CLI tool access (file edits, shell, git)
  within the `ALL_Repos` sandbox; the branch+PR gate and never-push-to-main rule are the
  safety boundary, not tool limits.

## Engine Choice

Wrap the local `claude` CLI (`claude -p --output-format stream-json`), launched with its
working directory set to a repo (or a parent dir) inside `ALL_Repos`. Capture the
`session_id` from the first response; pass `--resume <id>` on every follow-up turn for
multi-turn context. Each headless turn is a process that exits when the turn ends; `--resume`
continues the conversation, and the CLI persists transcripts to disk so resume works across
server restarts.

Rationale: the CLI already implements the edit/shell/git agent loop, tool permissions, and
durable session memory. Re-implementing that on the raw Anthropic API is work the project
does not need.

## Configuration

New env vars (added to `config.js`, following its `parseNumber`/default pattern):

| Env var | Default | Purpose |
|---------|---------|---------|
| `ALL_REPOS_PATH` | sibling of `TML_REPOS_PATH` (`<dirname>/ALL_Repos`) | Root dir holding all clones the agent edits; new repos are cloned here |
| `AGENT_STATE_DIR` | `<ALL_REPOS_PATH>/.co-worker` | Holds `sessions.json` index |
| `CLAUDE_BIN` | `claude` | Path to the CLI binary |

`GITHUB_TOKEN` (already required by the dashboard) is reused for cloning and PR creation.

## Components

### Backend — `server/agent/`

Each module has one job and is tested behind an injected dependency (mirroring the existing
`githubClient`'s `fetchImpl` and `createApp`'s constructor injection).

- **`claudeRunner.js`** — the only module that knows the CLI's shape.
  `runTurn({cwd, prompt, sessionId, onEvent})` spawns
  `claude -p --output-format stream-json [--resume <sessionId>]` in `cwd`, parses streamed
  JSON lines into events (assistant text, tool-call, result, new session id), and invokes
  `onEvent` per event. Injectable `spawnImpl` for tests. Never throws on CLI failure — a
  missing binary or non-zero exit becomes an `error` event carrying stderr.

- **`workspace.js`** — resolves a repo to a working copy under `ALL_REPOS_PATH`, parameterized
  by an `owner` (today always `"default"`). If the repo is already cloned, returns its path;
  if a pasted link is not present, `git clone`s it using `GITHUB_TOKEN`. Also lists available
  repos in `ALL_Repos`. Injectable git/clone impl for tests.

- **`session.js`** — owns a chat session and the persistent index. In-memory `Map` of live
  sessions keyed by `(owner, id)`; each holds `{id, owner, title, repos, cwd, claudeSessionId,
  status, prUrl, createdAt}`. Persists the index to `<AGENT_STATE_DIR>/sessions.json` on
  create/update and reloads it on startup, so past chats are listable and resumable after a
  restart. Per-conversation transcripts are NOT stored by us — the CLI persists them and
  `--resume` replays them.

- **`publish.js`** — when the user asks to ship: create `bot/<slug>` branch, commit, push,
  open a PR via the existing `githubClient`. Guards against pushing to `main`/`master`.
  Injectable git impl for tests. On git/PR failure, returns the error with the branch and
  working copy left intact for retry.

### Backend — wiring (`server/index.js`)

`createApp` gains the agent dependencies as constructor args (preserving the DI seam so tests
inject fakes). New endpoints, all namespaced `/api/agent`:

- `GET  /api/agent/repos` — list repos available in `ALL_Repos`.
- `GET  /api/agent/sessions` — list past chats from the index.
- `POST /api/agent/sessions` — create a session `{repos}` → `{id}`; resolves/clones working
  copies, sets `cwd`, writes the index.
- `GET  /api/agent/:id/stream` — SSE stream of the session's events (replays held transcript
  on reconnect).
- `POST /api/agent/:id/message` — `{prompt}`; runs a turn via `claudeRunner`, emitting events
  to the SSE stream; updates `claudeSessionId` on first turn.
- `POST /api/agent/:id/publish` — branch/commit/push/PR via `publish.js` → `{prUrl}`.

### Shared memory

A `CLAUDE.md` (plus a memory dir) at the root of `ALL_REPOS_PATH`, passed to every `claude`
run so all conversations share accumulated knowledge and the agent can append facts learned
in one chat for the next. Multi-user later namespaces this per owner; today owner =
`"default"`.

### Frontend — `web/src/pages/CoWorker.jsx`

The dashboard becomes one route/tab, the co-worker page another. The page has:

- a repo picker (select from `ALL_Repos` list, or paste a GitHub link),
- a list of past chats (from `GET /api/agent/sessions`) to reopen and resume,
- a chat transcript rendering streamed assistant text and tool-call lines (SSE),
- a message input for multi-turn follow-ups,
- a "Create PR" action that calls publish and shows the returned PR URL.

`web/src/api.js` gains the `/api/agent/*` calls (axios + an `EventSource` for the stream).

## Data Flow

1. **Start** — user picks repo(s) (or pastes a link → `workspace` clones into `ALL_Repos`).
   Backend creates a session, `cwd` = the repo dir (or `ALL_Repos` for multi-repo work),
   returns `id`, writes the index.
2. **Turn** — `POST /:id/message` → `claudeRunner.runTurn` spawns `claude -p --resume
   <claudeSessionId>` in `cwd` → events stream to the browser via SSE → page renders live.
   The CLI edits files directly in the working copy.
3. **Resume** — opening a past chat from the index resumes its `claudeSessionId`; full context
   is intact because the CLI's transcript is on disk.
4. **Ship** — user clicks "Create PR" → `publish.js` branches/commits/pushes/opens PR →
   returns the URL. User approves on GitHub.

## Error Handling

Follows the dashboard's non-throwing contract.

- `claude` missing or non-zero exit → session `status: error`, captured stderr surfaced in the
  chat; server does not crash.
- Clone failure / bad repo link → error event; session stays usable.
- Git push / PR failure → error returned to the "Create PR" action with the git message;
  branch and working copy left intact for retry.
- SSE disconnect → transcript held server-side in the session; reconnect replays it.

## Testing

Vitest, same fake-injection style as `test/enrich.test.js` (no network, no real CLI, temp
dirs for filesystem):

- `claudeRunner` with a fake `spawnImpl` emitting canned stream-json lines → assert parsed
  events and session-id capture, and that a non-zero exit yields an `error` event.
- `workspace` against a temp dir + fake git → cloned-vs-not-cloned resolution; clone uses the
  token; `owner` namespacing.
- `session` index round-trip through a temp file (create → reload → resume passes the right
  `claudeSessionId`); error-state transitions, fake-runner style.
- `publish` with a fake `githubClient` + fake git → branch/commit/PR calls and the
  never-push-to-main guard.

No frontend tests (matches the current setup).

## Future: Multi-user

Built single-user now, with the seams in place so multi-user does not require tearing code
out:

- **Sessions** already keyed by `(owner, id)`; `owner` defaults to `"default"`. Multi-user
  fills in real user ids. The in-memory index moves to a shared store (SQLite/Redis) — the one
  known upgrade. *(ponytail: single-user in-memory + JSON index; add a store when multi-user
  lands.)*
- **Workspace** takes an `owner` argument today. The real conflict point is a shared
  `ALL_Repos`: two users editing the same clone collide. Multi-user gives each owner an
  isolated working copy (git worktrees off a shared bare clone, or per-owner dirs).
- **Publish** already namespaces branches; later folds the owner into the slug.
- **Shared memory** namespaces per owner.

Auth, per-user isolation, and the session store are explicitly deferred to this phase.

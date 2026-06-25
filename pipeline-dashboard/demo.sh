#!/usr/bin/env bash
# Bring up backend + frontend together for a local demo.
# Usage: ./demo.sh                # backend on .env PORT (default 4000), frontend on 5173
#        PORT=4100 ./demo.sh      # override backend port (proxy follows automatically)
# Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and set GITHUB_TOKEN"; exit 1; }
PORT_OVERRIDE="${PORT:-}"            # CLI override wins over .env
set -a; . ./.env; set +a
export NODE_OPTIONS=                 # legacy-provider flag breaks Vite/Node
export PORT="${PORT_OVERRIDE:-${PORT:-4000}}"
API_PORT="$PORT"

# The Co-Worker agent spawns the `claude` CLI, which needs Bedrock auth. That auth
# lives in a shell function in ~/.bashrc that an interactive login calls — a plain
# `node` launch never sources it. Load it here so the spawned CLI is authenticated.
if [ -z "${CLAUDE_CODE_USE_BEDROCK:-}" ] && [ -f "$HOME/.bashrc" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.bashrc" >/dev/null 2>&1 || true
  if declare -F load_claude_code_config_v2 >/dev/null; then
    load_claude_code_config_v2 >/dev/null 2>&1 || true
  elif declare -F load_claude_code_config >/dev/null; then
    load_claude_code_config >/dev/null 2>&1 || true
  fi
fi

if ss -ltn "sport = :$API_PORT" 2>/dev/null | grep -q LISTEN; then
  echo "Port $API_PORT is busy — set a free one: PORT=4100 ./demo.sh"; exit 1
fi

cleanup() { echo; echo "Stopping..."; kill 0; }
trap cleanup EXIT INT TERM

echo "Backend  -> http://localhost:$API_PORT/api"
node server/index.js &

echo "Frontend -> http://localhost:5173  (open this)"
( cd web && API_PORT="$API_PORT" NODE_OPTIONS= npm run dev ) &

wait

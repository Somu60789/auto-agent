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

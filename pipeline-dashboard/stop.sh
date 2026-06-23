#!/usr/bin/env bash
# Stop the local demo: backend (server/index.js) + frontend (vite).
# Use when you started them in the background or a separate shell and can't Ctrl-C.
set -u
killed=0
for pat in 'server/index.js' 'node_modules/.bin/vite' '[p]ipeline-dashboard/web.*vite'; do
  pids=$(pgrep -f "$pat" || true)
  for pid in $pids; do
    kill "$pid" 2>/dev/null && { echo "stopped pid $pid ($pat)"; killed=1; }
  done
done
[ "$killed" = 0 ] && echo "Nothing to stop — no backend/frontend running."

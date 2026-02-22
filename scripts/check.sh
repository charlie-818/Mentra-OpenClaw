#!/usr/bin/env bash
# Build and verify the bridge health endpoint (no glasses required).
# Uses PORT=3999 so it does not conflict with a bridge already on 3000.
set -e
cd "$(dirname "$0")/.."
npm run build
PORT=3999 node dist/index.js &
PID=$!
sleep 2
curl -sf -o /dev/null -w "Health: %{http_code}\n" http://127.0.0.1:3999/health || { kill $PID 2>/dev/null; exit 1; }
kill $PID 2>/dev/null || true
echo "Configuration check OK."

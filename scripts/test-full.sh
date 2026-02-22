#!/usr/bin/env bash
# Full test: build, health, OpenClaw connectivity (if configured), then print next steps for glasses.
set -e
cd "$(dirname "$0")/.."

echo "=== Step 1: Build and health check ==="
npm run check
echo ""

# Step 2: OpenClaw test only if vars are set
set -a
[ -f .env ] && source .env 2>/dev/null || true
set +a

if [ -n "$OPENCLAW_GATEWAY_URL" ] && [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  echo "=== Step 2: OpenClaw gateway test ==="
  if npm run test:openclaw; then
    echo "OpenClaw: OK"
  else
    echo "OpenClaw: FAIL (gateway unreachable or token invalid)"
  fi
  echo ""
else
  echo "=== Step 2: OpenClaw (skipped - OPENCLAW_GATEWAY_URL/TOKEN not set) ==="
  echo ""
fi

echo "=== Next steps to see output on glasses ==="
echo "1. Terminal 1: npm run dev"
echo "2. Terminal 2: ngrok http 3000"
echo "3. MentraOS console: set Webhook URL to https://<your-ngrok-host>/webhook"
echo "4. On glasses: open your app (MentraOS app list)"
echo ""

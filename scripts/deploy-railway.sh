#!/usr/bin/env bash
# deploy-railway.sh
# One-shot script: builds, links to Railway, pushes env vars, and deploys.
# Run this once from the repo root after setup-cloudflare-tunnel.sh.
#
# Usage:
#   OPENCLAW_GATEWAY_URL=https://<tunnel-id>.cfargotunnel.com \
#   OPENCLAW_GATEWAY_TOKEN=<your-token> \
#   MENTRAOS_API_KEY=<your-key> \
#   PACKAGE_NAME=com.yourname.mentra-openclaw-bridge \
#   bash scripts/deploy-railway.sh

set -euo pipefail

# ── 1. Validate required env vars ────────────────────────────────────────────
REQUIRED_VARS=(OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN MENTRAOS_API_KEY PACKAGE_NAME)
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Error: missing required environment variables:"
  for v in "${MISSING[@]}"; do echo "  $v"; done
  echo ""
  echo "Usage:"
  echo "  OPENCLAW_GATEWAY_URL=https://... \\"
  echo "  OPENCLAW_GATEWAY_TOKEN=... \\"
  echo "  MENTRAOS_API_KEY=... \\"
  echo "  PACKAGE_NAME=com.yourname.mentra-openclaw-bridge \\"
  echo "  bash scripts/deploy-railway.sh"
  exit 1
fi

# ── 2. Check Railway CLI ──────────────────────────────────────────────────────
if ! command -v railway &>/dev/null; then
  echo "Railway CLI not found. Install with:"
  echo "  npm i -g @railway/cli"
  exit 1
fi
echo "✓ Railway CLI: $(railway --version 2>&1 | head -1)"

# ── 3. Login check ────────────────────────────────────────────────────────────
if ! railway whoami &>/dev/null; then
  echo "→ Logging into Railway..."
  railway login
fi
echo "✓ Railway authenticated"

# ── 4. Link or init project ───────────────────────────────────────────────────
if [[ ! -f .railway/config.json ]]; then
  echo "→ Initialising Railway project..."
  railway init
fi
echo "✓ Railway project linked"

# ── 5. Set environment variables ──────────────────────────────────────────────
echo "→ Setting Railway environment variables..."
railway variables set \
  OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL}" \
  OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN}" \
  MENTRAOS_API_KEY="${MENTRAOS_API_KEY}" \
  PACKAGE_NAME="${PACKAGE_NAME}" \
  NODE_ENV="production"

if [[ -n "${OPENCLAW_AGENT_ID:-}" ]]; then
  railway variables set OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID}"
fi
echo "✓ Environment variables set"

# ── 6. Deploy ─────────────────────────────────────────────────────────────────
echo "→ Deploying to Railway..."
railway up --detach

echo ""
echo "✓ Deployment triggered."
echo ""
echo "Get your public URL with:"
echo "  railway domain"
echo ""
echo "Then set that URL as the MentraOS webhook in:"
echo "  https://console.mentra.glass"
echo ""
echo "Watch logs with:"
echo "  railway logs"

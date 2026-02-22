#!/usr/bin/env bash
# setup-cloudflare-tunnel.sh
# Creates a named Cloudflare Tunnel that permanently exposes your local
# OpenClaw gateway (default: localhost:18789) to the internet.
# The tunnel URL is what you set as OPENCLAW_GATEWAY_URL in Railway.
#
# Usage:
#   bash scripts/setup-cloudflare-tunnel.sh [tunnel-name] [local-port]
#
# Defaults:
#   tunnel-name = openclaw
#   local-port  = 18789

set -euo pipefail

TUNNEL_NAME="${1:-openclaw}"
LOCAL_PORT="${2:-18789}"
LOCAL_URL="http://localhost:${LOCAL_PORT}"
TUNNEL_CONFIG_DIR="$HOME/.cloudflared"
PLIST_LABEL="com.cloudflare.tunnel.${TUNNEL_NAME}"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# ── 1. Check cloudflared is installed ────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
  echo "cloudflared not found. Install it with:"
  echo "  brew install cloudflared"
  exit 1
fi
echo "✓ cloudflared $(cloudflared --version 2>&1 | head -1)"

# ── 2. Authenticate (no-op if already done) ──────────────────────────────────
if [[ ! -f "$TUNNEL_CONFIG_DIR/cert.pem" ]]; then
  echo ""
  echo "→ Logging into Cloudflare (browser will open)..."
  cloudflared tunnel login
fi
echo "✓ Authenticated"

# ── 3. Create tunnel (idempotent – skips if name already exists) ─────────────
EXISTING=$(cloudflared tunnel list --output json 2>/dev/null \
  | python3 -c "import sys,json; ts=json.load(sys.stdin); \
    match=[t for t in ts if t.get('name')=='${TUNNEL_NAME}']; \
    print(match[0]['id'] if match else '')" 2>/dev/null || true)

if [[ -n "$EXISTING" ]]; then
  TUNNEL_ID="$EXISTING"
  echo "✓ Tunnel '${TUNNEL_NAME}' already exists (id: ${TUNNEL_ID})"
else
  echo "→ Creating tunnel '${TUNNEL_NAME}'..."
  TUNNEL_ID=$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1 \
    | grep -o '[0-9a-f-]\{36\}' | head -1)
  echo "✓ Tunnel created (id: ${TUNNEL_ID})"
fi

# ── 4. Write tunnel config ────────────────────────────────────────────────────
CONFIG_FILE="$TUNNEL_CONFIG_DIR/${TUNNEL_NAME}.yml"
cat > "$CONFIG_FILE" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${TUNNEL_CONFIG_DIR}/${TUNNEL_ID}.json

ingress:
  - service: ${LOCAL_URL}
EOF
echo "✓ Config written to ${CONFIG_FILE}"

# ── 5. Derive the public tunnel URL ──────────────────────────────────────────
TUNNEL_URL="https://${TUNNEL_ID}.cfargotunnel.com"
echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Tunnel URL (set this in Railway as OPENCLAW_GATEWAY_URL):"
echo "  ${TUNNEL_URL}"
echo "══════════════════════════════════════════════════════════════"
echo ""

# ── 6. Create launchd plist so the tunnel starts on login (macOS) ────────────
mkdir -p "$(dirname "$PLIST_PATH")"
CLOUDFLARED_BIN="$(command -v cloudflared)"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CLOUDFLARED_BIN}</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>${CONFIG_FILE}</string>
    <string>run</string>
    <string>${TUNNEL_NAME}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/cloudflared-${TUNNEL_NAME}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cloudflared-${TUNNEL_NAME}.log</string>
</dict>
</plist>
EOF

# Load (or reload) the plist
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "✓ Tunnel registered as a login item (auto-starts on boot)"
echo "  Logs: /tmp/cloudflared-${TUNNEL_NAME}.log"

# ── 7. Next steps ─────────────────────────────────────────────────────────────
echo ""
echo "Next steps:"
echo "  1. Make sure your OpenClaw gateway is running on ${LOCAL_URL}"
echo "  2. In Railway, set:"
echo "       OPENCLAW_GATEWAY_URL=${TUNNEL_URL}"
echo "       OPENCLAW_GATEWAY_TOKEN=<your token>"
echo "  3. Deploy the bridge to Railway:"
echo "       railway up"
echo "  4. Set the Railway app URL as the MentraOS webhook."
echo ""
echo "To view tunnel status:  cloudflared tunnel info ${TUNNEL_NAME}"
echo "To stop tunnel now:     launchctl unload ${PLIST_PATH}"
echo "To start tunnel now:    launchctl load ${PLIST_PATH}"

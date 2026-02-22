#!/usr/bin/env bash
# Run HexMentraBridge using env from this repo's .env.
# Clone HexMentraBridge to ../HexMentraBridge or ./hex-bridge, or set HEX_BRIDGE_DIR.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
HEX_BRIDGE_DIR="${HEX_BRIDGE_DIR:-}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env at $ENV_FILE. Copy .env.example to .env and set OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, PACKAGE_NAME, MENTRAOS_API_KEY."
  exit 1
fi

# Load .env (split on first = so values may contain =)
set -a
while IFS= read -r line; do
  case "$line" in
    ""|\#*) ;;
    *=*)
      key="${line%%=*}"
      value="${line#*=}"
      export "$key=$value"
      ;;
  esac
done < "$ENV_FILE"
set +a

# Derive OPENCLAW_WS_URL from OPENCLAW_GATEWAY_URL (http -> ws, same host/port)
if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then
  OPENCLAW_WS_URL="${OPENCLAW_GATEWAY_URL}"
  OPENCLAW_WS_URL="${OPENCLAW_WS_URL#https://}"
  OPENCLAW_WS_URL="${OPENCLAW_WS_URL#http://}"
  OPENCLAW_WS_URL="${OPENCLAW_WS_URL%%/*}"
  OPENCLAW_WS_URL="ws://${OPENCLAW_WS_URL}"
  export OPENCLAW_WS_URL
fi
export OPENCLAW_GW_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

# Resolve HexMentraBridge dir
if [ -z "$HEX_BRIDGE_DIR" ]; then
  if [ -d "$REPO_ROOT/hex-bridge" ]; then
    HEX_BRIDGE_DIR="$REPO_ROOT/hex-bridge"
  elif [ -d "$REPO_ROOT/../HexMentraBridge" ]; then
    HEX_BRIDGE_DIR="$REPO_ROOT/../HexMentraBridge"
  else
    echo "HexMentraBridge not found. Clone it to $REPO_ROOT/hex-bridge or $REPO_ROOT/../HexMentraBridge, or set HEX_BRIDGE_DIR."
    exit 1
  fi
fi
if [ ! -f "$HEX_BRIDGE_DIR/package.json" ]; then
  echo "Not a HexMentraBridge root (no package.json): $HEX_BRIDGE_DIR"
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun not found. Install from https://bun.sh or run HexMentraBridge manually with:"
  echo "  OPENCLAW_WS_URL=$OPENCLAW_WS_URL OPENCLAW_GW_TOKEN=... PACKAGE_NAME=$PACKAGE_NAME MENTRAOS_API_KEY=... PORT=${PORT:-3000} PUSH_PORT=${PUSH_PORT:-3001} bun run start"
  exit 1
fi

cd "$HEX_BRIDGE_DIR"
exec bun run start

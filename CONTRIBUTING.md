# Contributing

Thanks for your interest in the Mentra OpenClaw Bridge. This document explains how to run the project, run checks, and submit changes.

## Running the project

1. Clone the repo and install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template and set your values (see [README](README.md#setup)):
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your `PACKAGE_NAME`, `MENTRAOS_API_KEY`, `OPENCLAW_GATEWAY_URL`, and `OPENCLAW_GATEWAY_TOKEN` (and any optional vars). Never commit `.env` or real secrets—see [SECURITY.md](SECURITY.md).

3. Start the bridge in development (watch mode):
   ```bash
   npm run dev
   ```

For testing Mentra without OpenClaw first, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Checks and tests

- **Configuration and health check:** `npm run check` — builds and verifies the health endpoint (no glasses required).
- **OpenClaw connectivity:** `npm run test:openclaw` — tests gateway reachability and auth using `.env` (no glasses required).
- **Full test:** `npm run test:full` — runs the full test script (`scripts/test-full.sh`).

Run these before submitting changes to avoid regressions.

## Repository structure

- **`src/`** — Bridge application: `index.ts` (server, webhook, Mentra SDK), `openclaw.ts` (OpenClaw HTTP client).
- **`scripts/`** — Shell and Node scripts: check, tests, deploy (Railway), Cloudflare tunnel setup, HexMentraBridge launcher.
- **`docs/`** — OpenClaw and gateway debugging/setup guides. See [docs/README.md](docs/README.md) for an index.

Key config at the repo root: `package.json`, `tsconfig.json`, `.env.example`, `railway.json`, `nixpacks.toml`.

## Submitting changes

1. Open an issue to discuss larger changes, or open a pull request for smaller fixes and features.
2. Keep pull requests focused: one logical change per PR when possible.
3. Ensure `npm run check` (and, if relevant, `npm run test:openclaw`) pass.
4. Do not commit `.env` or any real API keys or tokens. Use environment variables only; see [SECURITY.md](SECURITY.md).

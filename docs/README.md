# Documentation

Guides for setting up and troubleshooting the bridge and OpenClaw gateway.

| Document | Description |
|----------|-------------|
| [OPENCLAW_DEBUG.md](OPENCLAW_DEBUG.md) | Troubleshooting when the glasses show "Connected" but no AI reply: verify OpenClaw from the bridge, interpret logs, trigger words, remote hosts, and common fixes (e.g. OpenRouter 402). |
| [PROMPT_OPENCLAW_COMPUTER_DESIGN.md](PROMPT_OPENCLAW_COMPUTER_DESIGN.md) | Copy-paste prompt for Claude to design or verify the OpenClaw gateway for Mentra: API contract, config, firewall, and a report for the bridge operator. |
| [TWO_SIDED_TEST.md](TWO_SIDED_TEST.md) | Two-sided test between the OpenClaw host and the bridge host: exchange reports until `npm run test:openclaw` passes. |

For testing Mentra **without** OpenClaw (SDK and glasses only), see the root [README](../README.md) and [DEVELOPMENT.md](../DEVELOPMENT.md).

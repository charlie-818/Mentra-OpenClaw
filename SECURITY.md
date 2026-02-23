# Security

## Reporting vulnerabilities

If you believe you have found a security vulnerability, please report it responsibly. Open a GitHub Security Advisory (recommended) or contact the maintainers privately. Do not open a public issue for sensitive security issues.

## Secrets and environment variables

- **Never commit secrets.** API keys, gateway tokens, and any other credentials must only be provided via environment variables (or your platform’s secret store), never in the repository.
- The file [.env.example](.env.example) is the only environment template. It contains placeholders only—do not put real values in `.env.example`. Copy it to `.env` locally and set your real values there; `.env` is gitignored and must stay that way.
- In production (e.g. Railway), set all required variables in the platform’s environment (dashboard or CLI). The application reads from the environment at runtime; the repo does not hold production secrets.

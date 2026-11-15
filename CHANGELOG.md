# Changelog

All notable changes to `expense-bridge` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/) (while in `0.x`, a minor version may change command shapes; such changes are called out).

## [Unreleased]

## [0.1.0] - 2026-11-15

First public release.

### Added

- CLI `expense-bridge` with `init`, `scan`, `review`, `send`, `sync-feedback` and `resolve`; `--dry-run` on every command prints the exact outbound request with credentials masked and sends and writes nothing.
- Closed Digest schema (eight fields) in zod and as `schema/digest.schema.json`, with a test that keeps them in agreement.
- Redaction gate over every outbound string (credential shapes, paths and file names, code fences and inline code, identifier density, foreign URLs, e-mail addresses); hits are held locally until `review --approve`.
- Bring-your-own-model providers: Anthropic (Messages API, structured output), OpenAI (strict `json_schema`), Ollama (local hosts only).
- Calls to the Expense Tracker `bridge-digests`, `bridge-feedback` and `bridge-resolutions` Edge Functions with idempotency keys and retries; one failed resolution never blocks the rest.
- Composite GitHub Action in `action/`.
- Guard tests: only `src/outbound.ts` talks to the Expense Tracker API, every URL literal is on an allow-list, `zod` is the only runtime dependency.
- Release tooling: `scripts/smoke-pack.sh` (installs the packed tarball and runs the CLI, also a CI job), `prepublishOnly` checks, a manual trusted-publishing workflow (off until configured), `SECURITY.md`, `CONTRIBUTING.md`, `docs/release.md`.

[Unreleased]: https://github.com/jre-coder/expense-tracker-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jre-coder/expense-tracker-bridge/releases/tag/v0.1.0

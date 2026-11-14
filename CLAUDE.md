# expense-bridge — Working Guidelines

## What this is

The self-hosted Bridge for Expense Tracker (`../expense-tracker/docs/decisions.md` §2 and §6 are binding; read them first). A Node 20+ TypeScript CLI (`expense-bridge`) that reads a developer's merged pull requests with their GitHub token, asks their own LLM for a functional digest, runs a redaction gate, and sends only the closed-schema digest to the Expense Tracker API. Designed to be open-sourced under Apache-2.0: nothing here may rely on secrecy.

## Stack

- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`), ESM, `NodeNext`.
- Runtime dependency: `zod` only. Providers and GitHub use raw `fetch` so the wire shape is readable in one file each.
- Vitest with v8 coverage; thresholds are 100% for statements, branches, functions and lines on `src/` (`src/bin.ts` and the type-only `src/providers/types.ts` excluded).
- ESLint (`typescript-eslint` recommended).
- `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`; `.githooks/pre-commit` runs typecheck then tests; `.github/workflows/test.yml` runs all four.

## Key files

| File | Role |
|---|---|
| `src/cli.ts` | commands `init`, `scan`, `review`, `send`, `sync-feedback`, `resolve`; `--dry-run` everywhere; `main(argv, deps)` with injected fetch/env/stdout |
| `src/config.ts` | zod config; env var NAMES only; refuses credential-shaped values |
| `src/github.ts` | merged PRs since cursor, files, bounded diff (local only) |
| `src/prompt.ts` | stable system prompts + user-message builders (no `cache_control`; see header) |
| `src/providers/{anthropic,openai,ollama}.ts` | one `Provider` interface, raw HTTP, structured JSON output |
| `src/providers/shared.ts` | `BaseProvider`, JSON extraction, draft/match validation, header masking |
| `src/schema.ts` | the closed Digest schema (decisions.md §6), `external_ref` hash, model-facing JSON schemas |
| `src/redaction.ts` | the gate: `scanText`, `scanDigest`, pattern classes |
| `src/outbound.ts` | the ONLY module that names the `/bridge/*` endpoints; idempotent retries; `describeRequest` |
| `src/held.ts` | local queue (`ready`/`held`/`approved`/`rejected`/`sent`) |
| `src/cursor.ts` | last merged_at cursor |
| `schema/digest.schema.json` | JSON Schema mirror of `DigestSchema`; `test/schema-json.test.ts` asserts agreement |
| `action/` | composite GitHub Action wrapper |
| `docs/` | threat model, what-leaves-your-machine, roadmap |

## TDD rule (non-negotiable)

Tests first, then the minimum implementation, then refactor. No change lands with coverage below 100% on `src/`, a red `tsc --noEmit`, or a lint error. A bug fix ships with the test that reproduces it. Never loosen a threshold, add `as any`, or `@ts-ignore` to get green.

## Privacy invariants (numbered; each has a test)

1. **Closed schema.** Only the eight fields of decisions.md §6 are ever serialised. `parseDigest` strips unknown keys then validates `.strict()`; `outbound.ts` re-validates immediately before send. (`test/schema.test.ts`, `test/outbound.test.ts`, `test/guards.test.ts`)
2. **Gate before queue, review before send.** Every free-text field is scanned by `scanDigest`; a hit makes the item `held`. `send` sends `ready` and `approved` only; approval is an explicit `review --approve` recorded in the queue. Nothing held is sent silently. (`test/redaction.test.ts`, `test/held.test.ts`, `test/cli.test.ts`)
3. **One outbound module.** `/bridge/digests|feedback|resolutions` may appear only in `src/outbound.ts` (plus the one `--dry-run` explanatory line in `cli.ts`). `fetch(` is called only from `outbound.ts`, `github.ts`, `providers/shared.ts` and the `bin.ts` wiring. (`test/guards.test.ts`)
4. **No telemetry, no third parties.** Every URL literal in `src/` points at `api.github.com`, `api.anthropic.com`, `api.openai.com` or `localhost`; each host is referenced only by its own module; `zod` is the only runtime dependency. (`test/guards.test.ts`)
5. **Secrets from env only, never to disk, never to stdout.** Config holds env var names and rejects credential-shaped values. `--dry-run` and `review` print headers through `maskHeaders`. Error messages name the variable, not the value. The GitHub token never enters provider or outbound modules; the bridge key never enters providers or github. (`test/config.test.ts`, `test/guards.test.ts`, `test/providers.test.ts`)
6. **`external_ref` is opaque.** First 16 hex chars of `sha256(repo_full_name + '#' + pr_number + merged_at)`; never a PR number or URL. (`test/schema.test.ts`)
7. **Feedback ids are server-issued.** `addresses_feedback` and resolution matches are filtered against ids received from `GET /bridge/feedback`; anything the model invents is dropped. (`test/providers.test.ts`)
8. **`--dry-run` is the real code path minus the network call.** It prints the exact request and performs no fetch and no state write. (`test/outbound.test.ts`, `test/cli.test.ts`)
9. **Ollama is local-only in v1.** A non-local `provider_base_url` is rejected at construction. (`test/providers.test.ts`)
10. **Cursor never skips a failed PR.** `scan` stops at the first provider error and writes the cursor at the last success. (`test/cli.test.ts`)

When adding a field, host, endpoint or dependency, update the matching guard test and this list in the same commit — the guard failing is the intended signal.

## Provider notes

- Anthropic: Messages API, `anthropic-version: 2026-10-21`, `output_config.format` (json_schema), no `temperature`/`top_p`/`top_k`, `thinking` omitted (adaptive default), `fallbacks: "default"` + `anthropic-beta: server-side-fallback-2026-07-01` only on models that accept it (`supportsServerSideFallback`). Default model `claude-opus-5-5`. Load the `claude-api` skill before changing this file.
- Prompt caching is intentionally off (`cache_control` absent): one call per PR rarely reaches the ~4-calls-per-5-minutes break-even and the prompt is below the 4,096-token minimum for Opus 4.5+. Revisit with batched backlog scans (roadmap).
- OpenAI and Ollama request shapes were written from the public API docs as understood at authoring time and not re-verified against the live services; tests pin what the Bridge sends.

## Contract details beyond decisions.md §6 (mirror these in the backend)

See the "Contract additions" section of `docs/what-leaves-your-machine.md`.

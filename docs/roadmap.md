# Roadmap

## v1 (this release)

- [x] CLI: `init`, `scan`, `review`, `send`, `sync-feedback`, `resolve`, `--dry-run` everywhere
- [x] Closed Digest schema (decisions.md §6) in zod and JSON Schema, agreement test
- [x] Redaction gate with 13 pattern classes, masked findings, held/approve/reject queue
- [x] Providers: Anthropic (Messages API, structured output), OpenAI (strict json_schema), Ollama (local-only)
- [x] GitHub REST reader with cursor, bounded diff, pagination caps
- [x] Idempotent outbound with retries; `outbound.ts` is the only API caller (guard test)
- [x] No-telemetry guard, hygiene guards, 100% coverage thresholds
- [x] GitHub Action wrapper; README, threat model, what-leaves-your-machine
- [ ] Publish to npm as `expense-bridge`; tag `action@v1` (waits on the product name — decisions.md open item 1)
- [ ] Backend `bridge-*` functions implement the contract additions listed in `docs/what-leaves-your-machine.md`

## v1.1

- [ ] **GitLab and Bitbucket** readers behind the same `PullRequest` shape (`src/github.ts` becomes `src/sources/`)
- [ ] **Linear / Jira feedback sync**: pull tracker issues as feedback, post resolutions back as comments, all from the developer's own tokens
- [ ] **Local-only mode with Ollama by default**: `init --local` selects Ollama, refuses non-local provider hosts, and adds a `--no-send` queue-only flow for teams that review digests before any network write
- [ ] Per-project salt for `external_ref` (threat model #7)
- [ ] `review --diff <ref>`: show the PR title and files locally beside the held digest so approvals are informed without opening a browser
- [ ] Batched backlog scans: when a run has 5+ PRs, enable prompt caching on the Anthropic provider (threshold and break-even per `~/.claude/CLAUDE.md`) and measure `cache_read_input_tokens`

## Later

- [ ] Release-based digests (tag to tag) in addition to per-PR
- [ ] Signed digests (developer-held key) so the server can prove provenance without identity
- [ ] A `verify` command that replays the guard tests against an installed build

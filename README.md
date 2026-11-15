# expense-bridge

[![npm](https://img.shields.io/npm/v/expense-bridge.svg)](https://www.npmjs.com/package/expense-bridge)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![test](https://github.com/jre-coder/expense-tracker-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/jre-coder/expense-tracker-bridge/actions/workflows/test.yml)

The self-hosted bridge between your pull requests and Expense Tracker's field-testing loop.

It runs **in your environment** (laptop, CI, or a GitHub Action in your own repo), reads merged pull requests with **your** GitHub token, asks **your** model (Anthropic, OpenAI, or a local Ollama) to write a *Functional Digest* in plain user-facing language, runs a **redaction gate**, and sends only the closed-schema digest to the Expense Tracker API. Testers then see "what to try" without anyone outside your team ever seeing code.

The whole repository is Apache-2.0 so you can audit exactly what leaves your machine. Nothing in it assumes secrecy.

## 60-second install

```sh
npm install --global expense-bridge          # Node 20+
cd your-repo
expense-bridge init --repo you/your-app \
  --api-base-url https://<project>.supabase.co/functions/v1 \
  --project-ref <project-ref-from-the-app> \
  --provider anthropic                      # or openai | ollama

export GITHUB_TOKEN=...          # read access to pull requests
export EXPENSE_BRIDGE_KEY=...    # per-project bridge key from the app
export ANTHROPIC_API_KEY=...     # your model key (not needed for ollama)

expense-bridge scan --dry-run    # shows exactly what would be asked of your model; sends nothing
expense-bridge scan              # asks your model, runs the gate, queues digests locally
expense-bridge send --dry-run    # prints the exact payload for the Expense Tracker API
expense-bridge send              # sends it
```

`init` needs `--repo`, `--api-base-url` and `--project-ref`; `--provider` defaults to `anthropic`. It writes `expense-bridge.config.json`, which contains environment-variable **names**, never values; the Bridge refuses a config that holds anything shaped like a credential. Commit it.

The three secrets are read from the environment only: `GITHUB_TOKEN` (a token that can read the repository's pull requests), `EXPENSE_BRIDGE_KEY` (the bridge key, `etb_…`) and your model key (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; none for Ollama). Run the `--dry-run` commands first and read what they print: that is everything that would leave your machine. The full list, in plain language, is in **[docs/what-leaves-your-machine.md](docs/what-leaves-your-machine.md)**.

No global install? Every command also works as `npx expense-bridge <command>` (the app shows the global-install form).

## Connecting from the app

1. **Create a bridge key in the app.** Open the project and tap **Connect repo** (or Settings › Integrations › **Connect your code** and pick the project), then create a key in step 1 of the guide. The key is shown **once**: copy it now. The screen also shows the setup command with your project's `--api-base-url` and `--project-ref` already filled in.
2. **Install the Bridge** on the machine or CI runner that can see your repository: `npm install --global expense-bridge` (Node 20+), or use `npx expense-bridge`.
3. **Run `init`** in your repository with the values from the app: `expense-bridge init --repo you/your-app --api-base-url <from the app> --project-ref <from the app> --provider anthropic|openai|ollama`. Commit the resulting `expense-bridge.config.json`.
4. **Export the secrets**: `GITHUB_TOKEN`, `EXPENSE_BRIDGE_KEY` (the key from step 1) and your model key.
5. **Dry-run**: `expense-bridge scan --dry-run`, then `expense-bridge scan` and `expense-bridge send --dry-run`. Read what would be sent; nothing has left your machine yet.
6. **Send**: `expense-bridge send`. Digests appear in the app's What's new for that project. From then on, each merged pull request becomes a digest the next time `scan` and `send` run — by hand, or automatically on every push to your main branch with the [GitHub Action](#github-action).

A revoked key stops the Bridge at its next call (`401 invalid_bridge_key`); create a new key and update `EXPENSE_BRIDGE_KEY`.

## What leaves your machine, and what never does

| Goes to | What | Why |
|---|---|---|
| `api.github.com` | your GitHub token (as a bearer header) | to list merged PRs, their files and diff |
| your model provider (`api.anthropic.com`, `api.openai.com`, or `localhost:11434`) | your model key; the PR title, body, labels, changed-file list and a bounded diff; the open-feedback list | to write the digest — this is **your** key and **your** vendor relationship |
| the Expense Tracker API host you configured (`api_base_url`, ending in `/functions/v1`) | your bridge key (bearer); the **Digest** below; feedback→digest resolutions | the only thing our servers receive — three Edge Functions: `bridge-digests`, `bridge-feedback`, `bridge-resolutions` |

Never sent to the Expense Tracker API: your GitHub token, your model key, any diff, file path, file name, commit message, branch name, PR number, URL, identifier or code. The schema below is **closed**: anything not listed is dropped before send, and every string that is sent passes the redaction gate first.

```
Digest {
  external_ref: string           // opaque: first 16 hex chars of sha256(repo + '#' + pr_number + merged_at)
  change_type: 'feature' | 'fix' | 'enhancement' | 'chore'
  title: string (<= 120)         // user-facing, no identifiers
  summary: string (<= 1000)      // what changed for the user
  test_items: { title, steps[], expected, priority: 'high'|'medium'|'low' }[]  (<= 20)
  addresses_feedback: string[]   // only feedback ids the API itself issued
  shipped_at: ISO date | null    // day precision
  bridge_version: string
}
```

The machine-readable version is [`schema/digest.schema.json`](schema/digest.schema.json); a test asserts it agrees with the runtime validator. `external_ref` is a hash the server cannot reverse — it is used only to make re-sends idempotent. See [docs/what-leaves-your-machine.md](docs/what-leaves-your-machine.md) for an example payload and [docs/threat-model.md](docs/threat-model.md) for the threat table.

### The redaction gate

Every string in a digest is scanned before it can be queued for sending. A hit holds the item; nothing held is ever sent silently.

| Class | Catches |
|---|---|
| `secret:aws`, `secret:github`, `secret:stripe`, `secret:jwt`, `secret:private_key`, `secret:slack`, `secret:generic_token` | credential shapes (AKIA…, ghp_/gho_/github_pat_, sk_/pk_, eyJ…, `-----BEGIN … PRIVATE KEY-----`, xox…/Slack webhooks, 32+ char hex or base64 runs) |
| `path` | directory paths (`src/services/receiptService.ts`) and bare file names with code extensions (`App.tsx`) |
| `code_fence`, `inline_code` | ``` blocks and `backticks` |
| `identifier_density` | camelCase / snake_case / dotted tokens above 3 per 100 words (configurable) |
| `url` | any URL whose host is not your configured API host |
| `email` | e-mail addresses |

`expense-bridge review` shows each held digest in full, with a **masked** copy of what tripped the gate. `--approve <ref>` sends it on the next `send`; `--reject <ref>` never sends it. The approval is recorded in the local queue.

## Verifying with `--dry-run`

Every command accepts `--dry-run`. It prints the exact outbound request — method, URL, headers with credentials masked, and the full JSON body — then sends nothing and writes nothing. `scan --dry-run` shows the request to your model; `send --dry-run` shows the payload for `POST <api_base_url>/bridge-digests`; `sync-feedback --dry-run` and `resolve --dry-run` show theirs. The dry-run output is the same code path as the real send, with the network call replaced by printing.

Two more guards run in the test suite and fail the build if violated: only `src/outbound.ts` may name the Expense Tracker functions (`bridge-digests`, `bridge-feedback`, `bridge-resolutions`), and every URL literal in `src/` must point at `api.github.com`, `api.anthropic.com`, `api.openai.com` or `localhost`. The only runtime dependency is `zod`.

## Commands

| Command | What it does |
|---|---|
| `init` | write the config (`--repo`, `--api-base-url`, `--project-ref`, `--provider`, `--model`, `--force`) |
| `scan` | read merged PRs since the cursor (`--since`, `--limit`), ask your model, run the gate, queue results |
| `review` | show held digests; `--approve <ref>`, `--reject <ref>`, `--json` |
| `send` | `POST /bridge-digests` for ready and approved items, in batches of 50 |
| `sync-feedback` | `GET /bridge-feedback?status=open` into `.expense-bridge/feedback.json` (used by `scan` so your model can reference feedback ids) |
| `resolve` | ask your model which open feedback the digests address; `POST /bridge-resolutions` for each match at or above `--min-confidence` (default 0.6) whose note passes the gate. A rejected resolution (e.g. `feedback_not_found`) is reported at the end and does not stop the others; the exit code is non-zero only if every post failed |

State lives in `.expense-bridge/` (cursor, queue, feedback cache). It is git-ignored by default and never leaves your machine.

## Bring your own model

| `provider` | Default `model` | Key env var | Endpoint |
|---|---|---|---|
| `anthropic` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` (structured output, no sampling params, server-side refusal fallback on supported models) |
| `openai` | `gpt-4.1` | `OPENAI_API_KEY` | `https://api.openai.com/v1/chat/completions` (strict `json_schema` response format) |
| `ollama` | `llama3.1` | none | `http://localhost:11434/api/chat` (schema passed as `format`); **local hosts only** in v1 |

All three share one prompt (`src/prompt.ts`) that demands user-facing language, forbids identifiers, file names, code, URLs and secrets, asks for test items with steps, and requires strict JSON. The model's output is validated against the schema; feedback ids it did not receive from the API are dropped. Set `provider_base_url` in the config to point at a proxy or another Ollama port.

## GitHub Action

```yaml
on:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: read
jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jre-coder/expense-tracker-bridge/action@v1
        with:
          bridge-key: ${{ secrets.EXPENSE_BRIDGE_KEY }}
          provider-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The secrets are resolved by the Actions runtime on your runner and reach only the hosts above. Details and the held-digest workflow in [action/README.md](action/README.md).

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest, 100% coverage thresholds on src/
npm run lint
npm run build
git config core.hooksPath .githooks   # typecheck + tests before every commit
```

Tests are written first. The privacy invariants are enforced by tests in `test/guards.test.ts`, not by convention; see [CLAUDE.md](CLAUDE.md) for the numbered rules and [docs/roadmap.md](docs/roadmap.md) for what comes next. `npm run smoke:pack` installs the packed tarball into a temp directory and runs the CLI (also a CI job). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Releases: [docs/release.md](docs/release.md). Changes: [CHANGELOG.md](CHANGELOG.md).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. Copyright 2026 Norevia Group LLC.

# expense-bridge

The self-hosted bridge between your pull requests and [Expense Tracker](https://github.com/jre-coder/expense-tracker)'s field-testing loop.

It runs **in your environment** (laptop, CI, or a GitHub Action in your own repo), reads merged pull requests with **your** GitHub token, asks **your** model (Anthropic, OpenAI, or a local Ollama) to write a *Functional Digest* in plain user-facing language, runs a **redaction gate**, and sends only the closed-schema digest to the Expense Tracker API. Testers then see "what to try" without anyone outside your team ever seeing code.

The whole repository is Apache-2.0 so you can audit exactly what leaves your machine. Nothing in it assumes secrecy.

## 60-second install

```sh
npm install --global expense-bridge          # Node 20+
cd your-repo
expense-bridge init --repo you/your-app \
  --api-base-url https://<your-expense-tracker-api> \
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

`init` writes `expense-bridge.config.json`. It contains environment-variable **names**, never values; the Bridge refuses a config that holds anything shaped like a credential. Commit it.

## What leaves your machine, and what never does

| Goes to | What | Why |
|---|---|---|
| `api.github.com` | your GitHub token (as a bearer header) | to list merged PRs, their files and diff |
| your model provider (`api.anthropic.com`, `api.openai.com`, or `localhost:11434`) | your model key; the PR title, body, labels, changed-file list and a bounded diff; the open-feedback list | to write the digest — this is **your** key and **your** vendor relationship |
| the Expense Tracker API host you configured | your bridge key (bearer); the **Digest** below; feedback→digest resolutions | the only thing our servers receive |

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

Every command accepts `--dry-run`. It prints the exact outbound request — method, URL, headers with credentials masked, and the full JSON body — then sends nothing and writes nothing. `scan --dry-run` shows the request to your model; `send --dry-run` shows the payload for `POST /bridge/digests`; `sync-feedback --dry-run` and `resolve --dry-run` show theirs. The dry-run output is the same code path as the real send, with the network call replaced by printing.

Two more guards run in the test suite and fail the build if violated: only `src/outbound.ts` may name the Expense Tracker endpoints, and every URL literal in `src/` must point at `api.github.com`, `api.anthropic.com`, `api.openai.com` or `localhost`. The only runtime dependency is `zod`.

## Commands

| Command | What it does |
|---|---|
| `init` | write the config (`--repo`, `--api-base-url`, `--project-ref`, `--provider`, `--model`, `--force`) |
| `scan` | read merged PRs since the cursor (`--since`, `--limit`), ask your model, run the gate, queue results |
| `review` | show held digests; `--approve <ref>`, `--reject <ref>`, `--json` |
| `send` | `POST /bridge/digests` for ready and approved items, in batches of 50 |
| `sync-feedback` | `GET /bridge/feedback?status=open` into `.expense-bridge/feedback.json` (used by `scan` so your model can reference feedback ids) |
| `resolve` | ask your model which open feedback the digests address; `POST /bridge/resolutions` for matches at or above `--min-confidence` (default 0.6) whose note passes the gate |

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

Tests are written first. The privacy invariants are enforced by tests in `test/guards.test.ts`, not by convention; see [CLAUDE.md](CLAUDE.md) for the numbered rules and [docs/roadmap.md](docs/roadmap.md) for what comes next.

## License

Apache-2.0. Copyright 2026 Norevia Group LLC.

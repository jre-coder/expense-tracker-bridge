# Expense Bridge GitHub Action

Runs `expense-bridge scan && expense-bridge send` inside **your** repository's
Actions runner whenever a pull request merges to your default branch.

## What stays on the runner

- Your `GITHUB_TOKEN`, your bridge key and your model key are resolved from
  this repository's own secrets by the Actions runtime. The Bridge reads them
  from environment variables, never writes them to disk, and sends each one
  only to the host it is for: the GitHub token to `api.github.com`, the model
  key to your configured provider, the bridge key to the Expense Tracker API.
  No step echoes a secret; `--dry-run` masks them.
- The pull request title, body, labels, changed-file list and bounded diff go
  to your model and nowhere else.
- Only the closed-schema digest (see `../schema/digest.schema.json`) goes to
  the Expense Tracker API. Anything the redaction gate flags is held in the
  `.expense-bridge/queue.json` cache for `expense-bridge review` and is never
  sent silently.

## Usage

```yaml
# .github/workflows/expense-bridge.yml
name: Expense Bridge
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

Commit `expense-bridge.config.json` (created by `expense-bridge init`) to the
repository. It contains env var **names** only; the Bridge refuses a config
that holds anything shaped like a credential.

Set `dry-run: 'true'` on the first run and read the job log: it prints the
exact request that would go to your model and the exact payload that would go
to the Expense Tracker API, with credentials masked, and sends nothing.

## Held digests in CI

When the gate holds a digest, the job still succeeds and the item waits in the
cached queue. Review it locally (`expense-bridge review`) from a checkout with
the same `.expense-bridge/queue.json`, or add a workflow step that uploads the
queue file as an artifact. Approvals are explicit; CI never auto-approves.

# What leaves your machine

One page, plain language. The Bridge is open source so you can check every statement here against the code; the file names are given so you can.

## Three destinations, three different things

**1. GitHub (`api.github.com`)** — your GitHub token, to list the pull requests merged since the last run and read their title, description, labels, changed files and diff. This is a read. The data comes *to* your machine. (`src/github.ts`)

**2. Your model provider** — your own Anthropic or OpenAI key, or nothing for a local Ollama. The Bridge sends your model the pull request title, description, labels, the list of changed files, a bounded diff (60,000 characters by default), and the list of open tester feedback (ids and text) so it can say which feedback a change addresses. Your model writes the digest. This is the same relationship you already have with that vendor; the Bridge adds no party to it. (`src/providers/`, `src/prompt.ts`)

**3. The Expense Tracker API host you configured** — `api_base_url`, which ends in `/functions/v1` because the API is three Supabase Edge Functions: `bridge-digests`, `bridge-feedback` and `bridge-resolutions`. They receive your per-project bridge key and the **digest** below. That is all our servers ever receive from the Bridge. (`src/outbound.ts`)

## What is never sent to Expense Tracker

Your GitHub token. Your model key. Any diff, file path, file name, directory, commit message, branch name, PR number, URL, identifier or code. Your repository name. Who merged what.

Two mechanisms enforce this, and both are tested:

- **A closed schema.** The digest has exactly eight fields. Before anything is sent, every key not in the schema is deleted and the result must pass a strict validator. There is no field in which a diff or a token could travel. (`src/schema.ts`, `schema/digest.schema.json`)
- **A redaction gate.** Every sentence that is about to be sent is scanned for credential shapes, file paths, file names, code fences, backticks, URLs that are not our API, e-mail addresses, and code-like identifiers. If anything matches, the digest is held on your machine and shown to you with the match masked. It is sent only if you type `expense-bridge review --approve <ref>`. (`src/redaction.ts`, `src/held.ts`)

## Example payload

This is the entire body of a `POST /bridge-digests` request, as `expense-bridge send --dry-run` prints it:

```http
POST https://<project>.supabase.co/functions/v1/bridge-digests
authorization: Bearer ****
accept: application/json
user-agent: expense-bridge/0.1.0
content-type: application/json
idempotency-key: 3f0c…(sha256 of this body)

{
  "project_ref": "6f1c2a7e-3b9d-4e5a-8c21-0d4f7a9b1e33",
  "digests": [
    {
      "change_type": "fix",
      "title": "Receipt scanning now reads faded thermal paper",
      "summary": "Scanning a receipt that has faded over a couple of weeks now extracts the merchant, date and total instead of asking you to type them in.",
      "test_items": [
        {
          "title": "Scan a faded receipt",
          "steps": [
            "Find a receipt that is at least two weeks old",
            "Open the scanner and photograph it"
          ],
          "expected": "Merchant, date and total are filled in without prompting",
          "priority": "high"
        }
      ],
      "addresses_feedback": ["fb_01HZX3Y6K8Q9R2T4V7W8X9Y0Z1"],
      "external_ref": "0123456789abcdef",
      "shipped_at": "2026-11-13",
      "bridge_version": "0.1.0"
    }
  ]
}
```

`external_ref` is the first 16 hex characters of `sha256(repo_full_name + '#' + pr_number + merged_at)`. The server stores it only to recognise the same digest if you send it twice. It cannot recover the repository, the PR number or the merge time from it, and the Bridge never sends those in clear.

`addresses_feedback` can only contain ids that the API itself handed to the Bridge in `GET /bridge-feedback`; anything else the model writes there is dropped.

## The other two requests

- `GET <api_base_url>/bridge-feedback?status=open` — carries your bridge key and nothing else. Returns tester feedback so your model can match fixes to it.
- `POST <api_base_url>/bridge-resolutions` — `{ feedback_id, digest_external_ref, confidence, note }`, one per request. The `note` is one plain sentence for the tester and goes through the same redaction gate; if it trips, that resolution is skipped and reported, not sent. A resolution the server rejects (for example `feedback_not_found`) is reported at the end of the run and does not stop the others.

## How to check for yourself

```sh
expense-bridge scan --dry-run            # the exact request to your model, key masked
expense-bridge send --dry-run            # the exact payload to Expense Tracker, key masked
expense-bridge sync-feedback --dry-run
expense-bridge resolve --dry-run
```

The dry-run output is produced by the same code that performs the real send, with the network call replaced by printing (`src/outbound.ts`, `sendRequest`). The test suite additionally fails if any file other than `src/outbound.ts` names an Expense Tracker function (`bridge-digests`, `bridge-feedback`, `bridge-resolutions`), or if any URL in the source points anywhere other than GitHub, your provider, or localhost (`test/guards.test.ts`).

## Contract additions beyond decisions.md §6

These are details the Bridge had to pin down that §6 leaves open. The backend's `bridge-*` functions should mirror them.

| Topic | Bridge behaviour |
|---|---|
| Endpoints | Flat Supabase Edge Function names under `api_base_url` (which ends in `/functions/v1`): `POST <api_base_url>/bridge-digests`, `GET <api_base_url>/bridge-feedback`, `POST <api_base_url>/bridge-resolutions`. No nested paths. |
| Request headers | `authorization: Bearer <bridge_key>`, `accept: application/json`, `user-agent: expense-bridge/<version>`; on POST also `content-type: application/json` and `idempotency-key: <sha256 hex of the body>` (same key across retries). |
| `POST …/bridge-digests` body | `{ project_ref: string, digests: Digest[] }`, 1–50 digests per request. `project_ref` is the project uuid the key is scoped to (the app fills it into the setup command it shows); the server rejects a mismatch with `project_mismatch`. |
| `POST …/bridge-digests` response | `{ accepted: [{ external_ref, digest_id }], duplicates: [external_ref], rejected: [{ external_ref, code, message }] }`. Accepted and duplicate refs are marked sent; rejected ones stay in the queue and are printed. Any other 2xx body marks the whole batch sent. |
| `GET …/bridge-feedback` | query `status=open`, optional `cursor`. Response `{ feedback: [{ id, text, severity, status, created_at }], next_cursor: string \| null }`. The Bridge follows `next_cursor` up to 20 pages. `id` must match `^[A-Za-z0-9_-]{1,64}$` (uuids qualify). |
| `POST …/bridge-resolutions` body | `{ feedback_id, digest_external_ref, confidence: 0..1, note: string (<= 500) }`, one resolution per request. Idempotent on `(feedback_id, digest_external_ref)`. |
| `POST …/bridge-resolutions` response | `201 { resolution, feedback_status, created: true }` on create, `200 { …, created: false }` on repeat (the CLI prints "already recorded"). `404 feedback_not_found` when `feedback_id` is not a uuid or not in the project; `404 digest_not_found` when the `external_ref` is unknown. The Bridge continues past a failed resolution, lists failures at the end, and exits non-zero only if every post failed. |
| Error body | `{ error: { code: string, message: string } }`. Codes the CLI surfaces verbatim: `invalid_bridge_key`, `project_mismatch`, `invalid_json`, `invalid_request`, `invalid_cursor`, `invalid_digest`, `feedback_not_found`, `digest_not_found`, `lookup_failed`, `method_not_allowed`, `rate_limited`, `payload_too_large`. Unknown shapes become `http_<status>`. |
| Retries | 429 and 5xx and network errors are retried (3 attempts, 250 ms exponential backoff) with the same `idempotency-key`; other 4xx are not retried. |
| Field limits | `title` ≤ 120, `summary` ≤ 1000, ≤ 20 `test_items`; per item `title` ≤ 120, 1–10 `steps` each ≤ 300, `expected` ≤ 300; `addresses_feedback` ≤ 50 ids; `shipped_at` is `YYYY-MM-DD` or null; `bridge_version` ≤ 32; `external_ref` matches `^[0-9a-f]{16}$`. |
| Transport | `api_base_url` must be `https://` (plain `http://` is allowed only for `localhost` / `127.0.0.1` during development). |

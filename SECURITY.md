# Security policy

The Bridge exists to keep code and credentials on the developer's machine, so a flaw in what it sends, stores or prints is treated as a security issue even when no secret is involved.

## Reporting a vulnerability

Report privately through GitHub: **[Report a vulnerability](https://github.com/jre-coder/expense-tracker-bridge/security/advisories/new)** (repository › Security › Advisories). Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Include the Bridge version (`expense-bridge --version`), the command you ran, and what reached a place it should not have (or could have). Mask real keys and tokens; a redacted reproduction is enough.

We aim to acknowledge a report within 5 business days and to give a status update at least every 14 days until it is resolved. Fixes are released as a new npm version and credited in `CHANGELOG.md` and the advisory unless you ask otherwise.

## In scope

- Anything other than the closed-schema digest, feedback resolutions and the bridge key reaching the Expense Tracker API (see [docs/what-leaves-your-machine.md](docs/what-leaves-your-machine.md)).
- A GitHub token, model key or bridge key written to disk, printed unmasked, or sent to a host other than the one it is for.
- A way past the redaction gate that a reasonable digest could trigger (a credential shape, path, code or identifier that is sent instead of held).
- A held digest being sent without `review --approve`.
- The published npm package differing from the tagged source.

The threat table in [docs/threat-model.md](docs/threat-model.md) lists the accepted residual risks; reports that sharpen one of them are welcome.

## Out of scope

- The Expense Tracker backend and app (report those through the app's support channel).
- Compromise of the developer's own machine, CI runner, GitHub account or model vendor account.
- The data-retention policy of the model vendor you configure.

## Supported versions

Only the latest published `0.x` release receives fixes.

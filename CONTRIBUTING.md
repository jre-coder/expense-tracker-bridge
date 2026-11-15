# Contributing

Thanks for looking. The Bridge is small on purpose and its privacy guarantees are enforced by tests, so contributions follow a few fixed rules.

## Setup

```sh
npm ci
git config core.hooksPath .githooks   # typecheck + tests before every commit
```

Node 20 or later.

## Rules

- **Tests first.** Write the failing test, then the minimum code. Coverage on `src/` is held at 100% (statements, branches, functions, lines); a pull request that lowers it fails CI.
- **`npm run typecheck`, `npm test`, `npm run lint` and `npm run build` all green.** Strict TypeScript; no `as any`, no `@ts-ignore`, no loosened compiler flags or thresholds.
- **Never bypass the hook** (`--no-verify`). Fix the failure instead.
- **The privacy invariants in [CLAUDE.md](CLAUDE.md) are numbered and each has a test.** Adding a field, host, endpoint or runtime dependency means updating the matching guard in `test/guards.test.ts` and the invariant list in the same pull request — the guard failing is the intended signal, not an obstacle.
- **One runtime dependency (`zod`).** New runtime dependencies are very unlikely to be accepted.
- **Docs in the same pull request.** README, `docs/` and `CHANGELOG.md` (under "Unreleased") move with the code.
- `npm run smoke:pack` installs the packed tarball and runs the CLI; run it when you touch `package.json`, `bin/` or the build.

## Reporting security issues

Not in public issues — see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)), as described in its section 5.

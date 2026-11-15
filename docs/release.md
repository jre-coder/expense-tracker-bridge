# Releasing `expense-bridge`

Two paths. **Path A** (a terminal, with your npm account and 2FA) is the one to use for 0.1.0 and needs nothing set up beforehand. **Path B** (GitHub Actions trusted publishing, no token anywhere, provenance attached) is optional and can only be switched on after the package exists on npm.

Everything that can go wrong is checked before anything is uploaded: `npm publish` runs `prepublishOnly` (typecheck, lint, the full suite with its 100% coverage thresholds) and then `prepack` (a clean rebuild of `dist/`). If any step fails, nothing is published.

## Before every release

1. On `main`, up to date, clean tree:

   ```sh
   cd ~/projects/expense-tracker-bridge
   git switch main && git pull --ff-only
   git status            # must say "nothing to commit, working tree clean"
   npm ci
   ```

2. The version in `package.json` and `src/version.ts` is the one you are releasing (a test fails if they differ), and `CHANGELOG.md` has a section for it with today's date. For a later release: bump both, move "Unreleased" into a new section, commit through the hook.
3. Rehearse:

   ```sh
   npm run smoke:pack        # packs, installs into a temp dir, runs --help / --version, uninstalls
   npm publish --dry-run     # full prepublishOnly + prepack, prints the file list, uploads nothing
   ```

   The dry-run file list must be exactly: `action/`, `bin/expense-bridge.js`, `dist/**/*.js`, `docs/*.md`, `schema/digest.schema.json`, `CHANGELOG.md`, `LICENSE`, `README.md`, `SECURITY.md`, `package.json`. No `src/`, `test/`, `.github/`, `.claude/` or coverage. `test/package.test.ts` pins the whitelist.

## Path A — publish from your terminal (use this for 0.1.0)

```sh
cd ~/projects/expense-tracker-bridge
git switch main && git pull --ff-only && git status
npm ci

npm login                       # opens the browser; sign in with 2FA
npm whoami                      # prints your npm username

npm publish                     # runs typecheck, lint, tests, clean build; asks for your 2FA code
npm view expense-bridge version # 0.1.0

git tag -a v0.1.0 -m "expense-bridge 0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "expense-bridge 0.1.0" --notes-file <(awk '/^## \[0.1.0\]/{f=1;next} /^\[Unreleased\]:/{f=0} f' CHANGELOG.md) --verify-tag

npm install --global expense-bridge && expense-bridge --version   # 0.1.0, from the registry
```

Notes:

- `npm login` uses web login by default; if your account has 2FA set to "authorization and publishing", `npm publish` prompts for a one-time code (or opens the browser). Nothing else is needed: the package is unscoped, so it is public by default.
- `gh release create --generate-notes` also works; the command above uses the CHANGELOG section instead because the first release has no previous tag to compare against, which makes generated notes say only "Full Changelog".
- If `npm publish` fails, nothing was uploaded; fix the cause and run it again. If it succeeded but a later step failed, do **not** re-publish — the version is taken forever (npm never allows reusing a version, even after unpublish). Finish the tag and release by hand.
- Afterwards, recommended: npmjs.com › your avatar › Account › Two-Factor Authentication is on for "authorization and publishing".

### The GitHub Action tag

The README's Action example uses `jre-coder/expense-tracker-bridge/action@v1`, which needs a `v1` tag in the repository. The Action installs `expense-bridge@latest` from npm, so tag it only after the npm publish:

```sh
git tag -a v1 -m "Action v1 (installs expense-bridge from npm)" v0.1.0
git push origin v1
```

For later releases, move it with `git tag -fa v1 -m "…" vX.Y.Z && git push --force origin v1` only when the release is backwards compatible for Action users.

## Path B (optional) — publish from GitHub Actions with trusted publishing

npm trusted publishing lets the workflow `.github/workflows/publish.yml` publish using a short-lived OIDC token from GitHub: no npm token is created or stored, and npm attaches a provenance attestation linking the tarball to the exact commit and workflow run (shown as a badge on npmjs.com). Requirements per [docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers): npm CLI 11.5.1+ and Node 22.14.0+ in the workflow (it pins both), `id-token: write` (it has it), a public repository (it is).

The workflow is **manual only** (`workflow_dispatch`) and its first step fails with an explanation until you have done the one-time setup.

### One-time setup (after 0.1.0 is on npm via Path A)

1. npmjs.com › Packages › `expense-bridge` › **Settings** › **Trusted Publisher** › **GitHub Actions**, and fill in:
   - Organization or user: `jre-coder`
   - Repository: `expense-tracker-bridge`
   - Workflow filename: `publish.yml`
   - Environment name: leave empty

   Save. npm says a new trusted publisher must complete its first publish within 2 days or the configuration expires, so do this when the next release is ready (or re-add it later).
2. GitHub: repository › Settings › Secrets and variables › Actions › **Variables** › New repository variable: `NPM_TRUSTED_PUBLISHING` = `configured`. (Or: `gh variable set NPM_TRUSTED_PUBLISHING --body configured --repo jre-coder/expense-tracker-bridge`.)
3. Recommended once a CI publish has succeeded: npmjs.com › `expense-bridge` › Settings › **Publishing access** › "Require two-factor authentication and disallow tokens". Trusted publishing keeps working (it is not a token); a stolen npm token can no longer publish.

### Releasing with Path B

```sh
# version bumped, CHANGELOG updated, merged to main
gh workflow run publish.yml --ref main --repo jre-coder/expense-tracker-bridge
gh run watch --repo jre-coder/expense-tracker-bridge
git tag -a vX.Y.Z -m "expense-bridge X.Y.Z" && git push origin vX.Y.Z
gh release create vX.Y.Z --generate-notes --verify-tag
```

The workflow refuses to run if the version is already on npm, runs the tarball smoke test, then `npm publish --provenance --access public` (which runs `prepublishOnly` and `prepack` as in Path A).

To switch Path B off again: delete the repository variable (the workflow stops at step one) and remove the trusted publisher on npmjs.com.

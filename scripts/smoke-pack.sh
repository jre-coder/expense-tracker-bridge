#!/bin/sh
# Install the real npm tarball into a throwaway prefix and run the installed CLI.
# Catches what unit tests cannot: a missing file in `files`, a broken bin shim,
# a dist that was not built, an ESM/CJS mismatch. Publishes nothing, touches no
# global install: everything lives under a temp directory removed on exit.
#
# Usage: npm run smoke:pack   (CI job `smoke-pack` in .github/workflows/test.yml)
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
EXPECTED_VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/expense-bridge-smoke.XXXXXX")
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT INT TERM

echo "Packing $NAME@$EXPECTED_VERSION (prepack rebuilds dist)..."
TARBALL=$(npm pack --silent --pack-destination "$SCRATCH" | tail -n 1)
TARBALL_PATH="$SCRATCH/$TARBALL"
[ -f "$TARBALL_PATH" ] || { echo "smoke-pack: npm pack produced no tarball"; exit 1; }

echo "Checking the tarball contents..."
LISTING=$(tar -tzf "$TARBALL_PATH")
for required in package/bin/expense-bridge.js package/dist/bin.js package/dist/cli.js package/schema/digest.schema.json package/action/action.yml package/README.md package/LICENSE package/docs/what-leaves-your-machine.md package/CHANGELOG.md package/SECURITY.md; do
  echo "$LISTING" | grep -qx "$required" || { echo "smoke-pack: $required missing from the tarball"; exit 1; }
done
for forbidden in package/src/ package/test/ package/.claude/ package/.github/ package/coverage/ package/node_modules/; do
  if echo "$LISTING" | grep -q "^$forbidden"; then echo "smoke-pack: ${forbidden} must not ship"; exit 1; fi
done

PREFIX="$SCRATCH/prefix"
echo "Installing the tarball into $PREFIX..."
(cd "$SCRATCH" && npm install --global --prefix "$PREFIX" --no-audit --no-fund --loglevel=error "$TARBALL_PATH")
BIN="$PREFIX/bin/expense-bridge"
[ -x "$BIN" ] || { echo "smoke-pack: $BIN is not an executable"; exit 1; }

echo "Running expense-bridge --help..."
HELP=$(cd "$SCRATCH" && "$BIN" --help)
echo "$HELP" | grep -q "^Usage: expense-bridge <command>" || { echo "smoke-pack: unexpected --help output:"; echo "$HELP"; exit 1; }
for cmd in init scan review send sync-feedback resolve; do
  echo "$HELP" | grep -q "^  $cmd " || { echo "smoke-pack: --help does not list $cmd"; exit 1; }
done

echo "Running expense-bridge --version..."
VERSION=$(cd "$SCRATCH" && "$BIN" --version)
[ "$VERSION" = "$EXPECTED_VERSION" ] || { echo "smoke-pack: --version printed '$VERSION', expected '$EXPECTED_VERSION'"; exit 1; }

echo "Checking that scan without a config exits non-zero..."
(cd "$SCRATCH" && "$BIN" scan --dry-run >/dev/null 2>&1) && { echo "smoke-pack: scan without a config should fail"; exit 1; }

echo "Uninstalling..."
(cd "$SCRATCH" && npm uninstall --global --prefix "$PREFIX" --loglevel=error "$NAME")
[ ! -e "$BIN" ] || { echo "smoke-pack: uninstall left $BIN behind"; exit 1; }

echo "smoke-pack: OK — $TARBALL installs, --help lists every command, --version is $VERSION."
cd "$ROOT"

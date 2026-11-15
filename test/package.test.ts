/**
 * Release hygiene. The npm tarball is what users install, so its shape is
 * pinned here: what ships, how the CLI starts, and what must run before a
 * publish. `scripts/smoke-pack.sh` (CI job `smoke-pack`) installs the real
 * tarball; this file guards the manifest that produces it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

interface Pkg {
  name: string;
  type: string;
  license: string;
  engines: { node: string };
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  keywords: string[];
  main?: string;
  exports?: unknown;
  publishConfig?: { provenance?: boolean; access?: string };
}
const pkg = JSON.parse(read('package.json')) as Pkg;
const REPO = 'github.com/jre-coder/expense-tracker-bridge';

describe('package.json: release metadata', () => {
  it('names the public repository, homepage and issue tracker', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: `git+https://${REPO}.git` });
    expect(pkg.homepage).toBe(`https://${REPO}#readme`);
    expect(pkg.bugs).toEqual({ url: `https://${REPO}/issues` });
  });

  it('carries search keywords and the Apache-2.0 licence that LICENSE holds', () => {
    expect(pkg.keywords).toEqual(expect.arrayContaining(['expense', 'receipts', 'github', 'digests', 'privacy']));
    expect(pkg.license).toBe('Apache-2.0');
    expect(read('LICENSE')).toContain('Apache License');
  });

  it('requires Node 20 or later', () => {
    expect(pkg.engines.node).toBe('>=20');
  });

  it('does not ask for provenance on a local publish (npm refuses provenance outside a supported CI; the CI workflow passes --provenance itself)', () => {
    expect(pkg.publishConfig?.provenance).toBeUndefined();
  });
});

describe('package.json: what ships', () => {
  it('whitelists exactly the runtime, the schema, the Action, the docs and the legal files', () => {
    expect([...pkg.files].sort()).toEqual(['CHANGELOG.md', 'LICENSE', 'README.md', 'SECURITY.md', 'action', 'bin', 'dist', 'docs', 'schema'].sort());
    expect(pkg.files).not.toContain('src');
    expect(pkg.files).not.toContain('test');
  });

  it('every whitelisted path exists in the repository (dist is produced by prepack)', () => {
    for (const entry of pkg.files.filter((f) => f !== 'dist')) expect(existsSync(join(ROOT, entry)), entry).toBe(true);
  });

  it('is a CLI only: ESM, no library entry point', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBeUndefined();
    expect(pkg.exports).toBeUndefined();
  });

  it('the build emits neither source maps nor declarations (src/ is not shipped, so maps would point nowhere)', () => {
    const build = JSON.parse(read('tsconfig.build.json')) as { compilerOptions: Record<string, unknown> };
    expect(build.compilerOptions['sourceMap']).toBe(false);
    expect(build.compilerOptions['declaration']).toBe(false);
  });
});

describe('package.json: the expense-bridge command', () => {
  it('maps the expense-bridge command to the committed shim', () => {
    expect(pkg.bin).toEqual({ 'expense-bridge': 'bin/expense-bridge.js' });
  });

  it('the shim has a node shebang, is executable, and starts the built entry compiled from src/bin.ts', () => {
    const shim = read('bin/expense-bridge.js');
    expect(shim.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(join(ROOT, 'bin/expense-bridge.js')).mode & 0o111).not.toBe(0);
    expect(shim).toContain("from '../dist/bin.js'");
    expect(existsSync(join(ROOT, 'src/bin.ts'))).toBe(true);
  });
});

describe('package.json: nothing is published unverified', () => {
  it('prepublishOnly runs typecheck, lint and the suite (with its coverage thresholds), in that order', () => {
    expect(pkg.scripts['prepublishOnly']).toBe('npm run typecheck && npm run lint && npm test');
  });

  it('prepack rebuilds dist from a clean directory so no stale file can ship (runs on npm pack and npm publish)', () => {
    expect(pkg.scripts['prepack']).toBe('npm run build');
    expect(pkg.scripts['build']).toMatch(/^npm run clean && tsc -p tsconfig\.build\.json$/);
    expect(pkg.scripts['clean']).toContain("rmSync('dist'");
  });

  it('exposes the tarball smoke test as an npm script', () => {
    expect(pkg.scripts['smoke:pack']).toBe('sh scripts/smoke-pack.sh');
    expect(existsSync(join(ROOT, 'scripts/smoke-pack.sh'))).toBe(true);
  });
});

describe('CI: release workflows', () => {
  it('the test workflow installs the packed tarball on every push and pull request', () => {
    const wf = read('.github/workflows/test.yml');
    expect(wf).toMatch(/smoke-pack:/);
    expect(wf).toContain('npm run smoke:pack');
  });

  it('the publish workflow is manual only and refuses to run until trusted publishing is configured', () => {
    const wf = read('.github/workflows/publish.yml');
    expect(wf).toMatch(/on:\s*\n\s*workflow_dispatch:/);
    expect(wf).not.toMatch(/^\s*(push|pull_request|release):/m);
    expect(wf).toContain('id-token: write');
    expect(wf).toContain("vars.NPM_TRUSTED_PUBLISHING != 'configured'");
    expect(wf).toContain('npm publish --provenance --access public');
    expect(wf).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN/);
  });
});

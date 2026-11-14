/**
 * Structural guards. They grep the source tree so that a refactor cannot
 * quietly widen what the Bridge talks to or what it sends.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BRIDGE_VERSION } from '../src/version.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const sources = walk(SRC).map((path) => {
  const text = readFileSync(path, 'utf8');
  return { rel: relative(ROOT, path), text, code: stripComments(text) };
});

describe('guard: only outbound.ts talks to the Expense Tracker API', () => {
  it('the bridge-digests|bridge-feedback|bridge-resolutions function names appear in outbound.ts only (cli.ts may print the resolutions name in --dry-run help text)', () => {
    const ENDPOINT = /bridge-(digests|feedback|resolutions)/; // no /g: .test() with a global regex keeps lastIndex across files
    const offenders = sources.filter((s) => ENDPOINT.test(s.code) && s.rel !== 'src/outbound.ts');
    expect(offenders.map((o) => o.rel)).toEqual(['src/cli.ts']);
    const cli = sources.find((s) => s.rel === 'src/cli.ts')!.code;
    expect(cli.match(new RegExp(ENDPOINT.source, 'g'))).toEqual(['bridge-resolutions']);
  });

  it('fetch( is called only from the modules whose job is to talk to a network host', () => {
    // bin.ts only forwards globalThis.fetch into main(); it never builds a request.
    const allowed = new Set(['src/outbound.ts', 'src/github.ts', 'src/providers/shared.ts', 'src/bin.ts']);
    const callers = sources.filter((s) => /\bfetch\(/.test(s.code)).map((s) => s.rel);
    for (const c of callers) expect(allowed, `${c} calls fetch()`).toContain(c);
  });

  it('the bridge key is handled only by config (reading), outbound (sending) and cli (passing through)', () => {
    const allowed = new Set(['src/config.ts', 'src/outbound.ts', 'src/cli.ts']);
    const users = sources.filter((s) => /bridgeKey|bridge_key/.test(s.text)).map((s) => s.rel);
    for (const u of users) expect(allowed, `${u} touches the bridge key`).toContain(u);
  });

  it('the GitHub token never reaches the provider or outbound modules', () => {
    for (const s of sources.filter((s) => s.rel.startsWith('src/providers/') || s.rel === 'src/outbound.ts')) {
      expect(s.text, s.rel).not.toMatch(/githubToken|github_token/);
    }
  });
});

describe('guard: no telemetry', () => {
  const ALLOWED_HOSTS = new Set(['api.github.com', 'api.anthropic.com', 'api.openai.com', 'localhost']);

  it('every URL literal in src/ points at an allow-listed host', () => {
    for (const s of sources) {
      const hosts = Array.from(s.text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/g), (m) => m[1] as string);
      for (const host of hosts) expect(ALLOWED_HOSTS, `${s.rel} references ${host}`).toContain(host);
    }
  });

  it('each third-party host is referenced only by its own module', () => {
    const owner: Record<string, string> = {
      'api.github.com': 'src/github.ts',
      'api.anthropic.com': 'src/providers/anthropic.ts',
      'api.openai.com': 'src/providers/openai.ts',
    };
    for (const [host, file] of Object.entries(owner)) {
      const users = sources.filter((s) => s.text.includes(host)).map((s) => s.rel);
      expect(users, host).toEqual([file]);
    }
  });

  it('no analytics, crash-reporting or tracking packages are depended on', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
  });
});

describe('guard: hygiene', () => {
  it('BRIDGE_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(BRIDGE_VERSION).toBe(pkg.version);
  });

  it('no `as any` and no @ts-ignore in src/', () => {
    for (const s of sources) {
      expect(s.text, s.rel).not.toMatch(/as any\b/);
      expect(s.text, s.rel).not.toMatch(/@ts-ignore/);
    }
  });

  it('the Digest wire schema has exactly the eight fields of decisions.md §6', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schema/digest.schema.json'), 'utf8')) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['addresses_feedback', 'bridge_version', 'change_type', 'external_ref', 'shipped_at', 'summary', 'test_items', 'title'].sort(),
    );
  });
});

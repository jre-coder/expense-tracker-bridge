import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, defaultConfig, loadConfig, writeConfig, resolveSecrets, CONFIG_FILENAME } from '../src/config.js';

const base = {
  repo: 'jre-coder/corvago',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  provider_key_env: 'ANTHROPIC_API_KEY',
  api_base_url: 'https://api.expensetracker.example',
  project_ref: 'corvago',
};

describe('ConfigSchema', () => {
  it('accepts a minimal config and fills defaults', () => {
    const parsed = ConfigSchema.parse(base);
    expect(parsed.github_token_env).toBe('GITHUB_TOKEN');
    expect(parsed.bridge_key_env).toBe('EXPENSE_BRIDGE_KEY');
    expect(parsed.cursor_file).toBe('.expense-bridge/cursor.json');
    expect(parsed.queue_file).toBe('.expense-bridge/queue.json');
    expect(parsed.feedback_file).toBe('.expense-bridge/feedback.json');
    expect(parsed.max_diff_chars).toBeGreaterThan(1000);
    expect(parsed.resolution_min_confidence).toBe(0.6);
  });

  it('rejects unknown keys (there is no field in which a secret could be stored)', () => {
    expect(ConfigSchema.safeParse({ ...base, github_token: 'ghp_x' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, bridge_key: 'x' }).success).toBe(false);
  });

  it('rejects env var fields that are not env var NAMES', () => {
    expect(ConfigSchema.safeParse({ ...base, github_token_env: 'ghp_' + 'a'.repeat(36) }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, bridge_key_env: 'lower-case' }).success).toBe(false);
  });

  it('rejects any string value that looks like a credential', () => {
    const r = ConfigSchema.safeParse({ ...base, project_ref: 'sk_live_' + 'a'.repeat(24) });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/secret|credential/i);
  });

  it('requires provider_key_env for anthropic and openai but not for ollama', () => {
    const { provider_key_env: _k, ...noKey } = base;
    expect(ConfigSchema.safeParse(noKey).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...noKey, provider: 'openai' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...noKey, provider: 'ollama', model: 'llama3.1' }).success).toBe(true);
  });

  it('rejects a malformed repo or a non-URL api_base_url', () => {
    expect(ConfigSchema.safeParse({ ...base, repo: 'corvago' }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...base, api_base_url: 'not a url' }).success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(ConfigSchema.safeParse({ ...base, provider: 'gemini' }).success).toBe(false);
  });
});

describe('defaultConfig', () => {
  it('produces a valid config per provider with sensible model defaults', () => {
    const a = defaultConfig({ repo: 'o/r', provider: 'anthropic', api_base_url: 'https://x.example', project_ref: 'p' });
    expect(a.model).toBe('claude-opus-5-5');
    expect(a.provider_key_env).toBe('ANTHROPIC_API_KEY');
    const o = defaultConfig({ repo: 'o/r', provider: 'openai', api_base_url: 'https://x.example', project_ref: 'p' });
    expect(o.provider_key_env).toBe('OPENAI_API_KEY');
    const l = defaultConfig({ repo: 'o/r', provider: 'ollama', api_base_url: 'https://x.example', project_ref: 'p' });
    expect(l.provider_key_env).toBeUndefined();
    expect(l.provider_base_url).toBe('http://localhost:11434');
    for (const c of [a, o, l]) expect(ConfigSchema.safeParse(c).success).toBe(true);
  });

  it('honours an explicit model', () => {
    const c = defaultConfig({ repo: 'o/r', provider: 'ollama', model: 'qwen2.5', api_base_url: 'https://x.example', project_ref: 'p' });
    expect(c.model).toBe('qwen2.5');
  });
});

describe('loadConfig / writeConfig', () => {
  it('round-trips through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const path = join(dir, CONFIG_FILENAME);
    writeConfig(path, ConfigSchema.parse(base));
    const loaded = loadConfig(path);
    expect(loaded.repo).toBe('jre-coder/corvago');
    expect(readFileSync(path, 'utf8')).not.toMatch(/ghp_|sk_/);
  });

  it('tells the user to run init when the file is missing', () => {
    expect(() => loadConfig(join(tmpdir(), 'nope', CONFIG_FILENAME))).toThrow(/expense-bridge init/);
  });

  it('reports JSON and validation errors with the file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const path = join(dir, CONFIG_FILENAME);
    writeFileSync(path, '{');
    expect(() => loadConfig(path)).toThrow(/not valid JSON/);
    writeFileSync(path, JSON.stringify({ ...base, provider: 'nope' }));
    expect(() => loadConfig(path)).toThrow(/provider/);
    writeFileSync(path, '[]');
    expect(() => loadConfig(path)).toThrow(/<root>/);
  });
});

describe('resolveSecrets', () => {
  const cfg = ConfigSchema.parse(base);

  it('reads every secret from the environment by the configured names', () => {
    const s = resolveSecrets(cfg, { GITHUB_TOKEN: 'gh', EXPENSE_BRIDGE_KEY: 'bk', ANTHROPIC_API_KEY: 'ak' });
    expect(s).toEqual({ githubToken: 'gh', bridgeKey: 'bk', providerKey: 'ak' });
  });

  it('names the missing env var without printing any value', () => {
    expect(() => resolveSecrets(cfg, { GITHUB_TOKEN: 'gh', ANTHROPIC_API_KEY: 'ak' })).toThrow(/EXPENSE_BRIDGE_KEY/);
    expect(() => resolveSecrets(cfg, { EXPENSE_BRIDGE_KEY: 'bk', ANTHROPIC_API_KEY: 'ak' })).toThrow(/GITHUB_TOKEN/);
    expect(() => resolveSecrets(cfg, { GITHUB_TOKEN: 'gh', EXPENSE_BRIDGE_KEY: 'bk' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('treats an empty string as missing', () => {
    expect(() => resolveSecrets(cfg, { GITHUB_TOKEN: '', EXPENSE_BRIDGE_KEY: 'bk', ANTHROPIC_API_KEY: 'ak' })).toThrow(/GITHUB_TOKEN/);
  });

  it('allows a missing provider key for ollama', () => {
    const ollama = ConfigSchema.parse({ ...base, provider: 'ollama', model: 'llama3.1', provider_key_env: undefined });
    const s = resolveSecrets(ollama, { GITHUB_TOKEN: 'gh', EXPENSE_BRIDGE_KEY: 'bk' });
    expect(s.providerKey).toBeNull();
  });

  it('can skip secrets that a particular command does not need', () => {
    const s = resolveSecrets(cfg, { GITHUB_TOKEN: 'gh' }, { need: ['github'] });
    expect(s.githubToken).toBe('gh');
    expect(s.bridgeKey).toBeNull();
    expect(s.providerKey).toBeNull();
  });
});

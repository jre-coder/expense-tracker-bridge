import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliDeps } from '../src/cli.js';
import { CONFIG_FILENAME } from '../src/config.js';
import { QueueStore } from '../src/held.js';
import { computeExternalRef } from '../src/schema.js';
import { BRIDGE_VERSION } from '../src/version.js';
import { mockFetch, jsonResponse, textResponse, type Responder } from './helpers.js';
import { validDigest, minimalDigest } from './fixtures/digests.js';

const API = 'https://api.expensetracker.example';
const MERGED = '2026-11-13T09:30:00Z';

const pull = (number: number, mergedAt: string | null = MERGED) => ({
  number,
  title: `Handle faded thermal receipts ${number}`,
  body: 'Closes the faded-receipt bug.',
  labels: [{ name: 'bug' }],
  merged_at: mergedAt,
  updated_at: mergedAt ?? '2026-11-13T00:00:00Z',
});
const prFiles = [{ filename: 'src/services/receiptService.ts', status: 'modified', additions: 3, deletions: 1, patch: '+x' }];

const cleanDraft = {
  change_type: 'fix',
  title: 'Receipt scanning now reads faded thermal paper',
  summary: 'Faded receipts are extracted correctly now.',
  test_items: [{ title: 'Scan a faded receipt', steps: ['Scan an old receipt'], expected: 'Fields fill in', priority: 'high' }],
  addresses_feedback: ['fb_1', 'fb_not_ours'],
};
const dirtyDraft = { ...cleanDraft, summary: 'Changed src/services/receiptService.ts so faded receipts parse.' };

const anthropicReply = (draft: unknown) => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(draft) }] });

interface Harness {
  dir: string;
  deps: CliDeps;
  out: string[];
  err: string[];
  calls: ReturnType<typeof mockFetch>['calls'];
  run: (...argv: string[]) => Promise<number>;
}

function harness(responder: Responder, env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const out: string[] = [];
  const err: string[] = [];
  const { fetch, calls } = mockFetch(responder);
  const deps: CliDeps = {
    fetch,
    env: { GITHUB_TOKEN: 'ghp_token', EXPENSE_BRIDGE_KEY: 'brk_key', ANTHROPIC_API_KEY: 'sk-ant', ...env },
    cwd: dir,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    now: () => new Date('2026-11-14T12:00:00Z'),
    sleep: async () => undefined,
  };
  return { dir, deps, out, err, calls, run: (...argv) => main(argv, deps) };
}

async function withConfig(h: Harness, extra: string[] = []): Promise<void> {
  const code = await h.run('init', '--repo', 'jre-coder/corvago', '--api-base-url', API, '--project-ref', 'corvago', ...extra);
  expect(code).toBe(0);
  h.out.length = 0;
}

/** Default router: GitHub lists one merged PR; Anthropic returns a clean draft; the API accepts everything. */
const defaultResponder: Responder = (url, init) => {
  if (url.startsWith('https://api.github.com/repos/jre-coder/corvago/pulls?')) return jsonResponse([pull(12)]);
  if (url.includes('/pulls/12/files')) return jsonResponse(prFiles);
  if (url.startsWith('https://api.anthropic.com/')) return anthropicReply(cleanDraft);
  if (url === `${API}/bridge/digests`) {
    const body = JSON.parse(init.body as string) as { digests: Array<{ external_ref: string }> };
    return jsonResponse({ accepted: body.digests.map((d) => ({ external_ref: d.external_ref, digest_id: 'd_' + d.external_ref })), duplicates: [], rejected: [] });
  }
  if (url.startsWith(`${API}/bridge/feedback`)) {
    return jsonResponse({ feedback: [{ id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: '2026-11-01T00:00:00Z' }], next_cursor: null });
  }
  if (url === `${API}/bridge/resolutions`) return jsonResponse({ resolution_id: 'r1', feedback_id: 'fb_1', status: 'proposed' });
  return textResponse(`unrouted ${url}`, 500);
};

describe('cli: global behaviour', () => {
  it('prints usage with --help and on no command, exit 0', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('--help')).toBe(0);
    expect(h.out.join('\n')).toMatch(/Usage: expense-bridge/);
    expect(h.out.join('\n')).toMatch(/--dry-run/);
    expect(await h.run()).toBe(0);
  });

  it('prints the version', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('--version')).toBe(0);
    expect(h.out).toContain(BRIDGE_VERSION);
  });

  it('rejects an unknown command with exit 2 and usage on stderr', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('frobnicate')).toBe(2);
    expect(h.err.join('\n')).toMatch(/Unknown command/);
  });

  it('reports a missing config with exit 1', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('scan')).toBe(1);
    expect(h.err.join('\n')).toMatch(/expense-bridge init/);
  });

  it('rejects a flag given without a value and unknown flags', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('scan', '--since')).toBe(2);
    expect(h.err.join('\n')).toMatch(/--since/);
    expect(await h.run('scan', '--bogus')).toBe(2);
  });

  it('rejects a second positional argument and accepts --flag=value syntax', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('scan', 'extra')).toBe(2);
    expect(h.err.join('\n')).toMatch(/Unexpected argument/);
    await withConfig(h);
    expect(await h.run('scan', '--since=2026-11-14T00:00:00Z', '--limit=1')).toBe(0);
    expect(h.out.join('\n')).toMatch(/No merged pull requests since 2026-11-14T00:00:00Z/);
    expect(await h.run('scan', '--limit', '0')).toBe(2);
    expect(h.err.join('\n')).toMatch(/--limit/);
  });

  it('honours --config for a custom config path', async () => {
    const h = harness(defaultResponder);
    const custom = join(h.dir, 'custom.json');
    expect(await h.run('init', '--config', custom, '--repo', 'o/r', '--api-base-url', API, '--project-ref', 'p')).toBe(0);
    expect(existsSync(custom)).toBe(true);
    expect(await h.run('review', '--config', custom)).toBe(0);
  });
});

describe('cli: init', () => {
  it('writes a config holding env var names only and prints next steps', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    const written = JSON.parse(readFileSync(join(h.dir, CONFIG_FILENAME), 'utf8'));
    expect(written.repo).toBe('jre-coder/corvago');
    expect(written.provider).toBe('anthropic');
    expect(written.provider_key_env).toBe('ANTHROPIC_API_KEY');
    expect(JSON.stringify(written)).not.toMatch(/ghp_|brk_|sk-ant/);
    expect(await h.run('init', '--repo', 'o/r', '--api-base-url', API, '--project-ref', 'p')).toBe(1);
    expect(h.err.join('\n')).toMatch(/--force/);
    expect(await h.run('init', '--repo', 'o/r', '--api-base-url', API, '--project-ref', 'p', '--force', '--provider', 'ollama', '--model', 'qwen2.5')).toBe(0);
    const again = JSON.parse(readFileSync(join(h.dir, CONFIG_FILENAME), 'utf8'));
    expect(again.provider).toBe('ollama');
    expect(again.model).toBe('qwen2.5');
    expect(h.out.join('\n')).toMatch(/GITHUB_TOKEN/);
  });

  it('requires --repo, --api-base-url and --project-ref and a known provider', async () => {
    const h = harness(defaultResponder);
    expect(await h.run('init', '--repo', 'o/r')).toBe(1);
    expect(h.err.join('\n')).toMatch(/--api-base-url/);
    expect(await h.run('init', '--repo', 'o/r', '--api-base-url', API, '--project-ref', 'p', '--provider', 'gemini')).toBe(1);
    expect(h.err.join('\n')).toMatch(/provider/);
    expect(await h.run('init', '--repo', 'o/r', '--api-base-url', 'not-a-url', '--project-ref', 'p')).toBe(1);
  });
});

describe('cli: scan', () => {
  it('names a missing env var and exits 1 without calling anything', async () => {
    const h = harness(defaultResponder, { GITHUB_TOKEN: '' });
    await withConfig(h);
    expect(await h.run('scan')).toBe(1);
    expect(h.err.join('\n')).toMatch(/GITHUB_TOKEN/);
    expect(h.calls).toHaveLength(0);
  });

  it('--dry-run prints the exact provider request with the key masked, calls no model and writes no state', async () => {
    const h = harness(defaultResponder, { ANTHROPIC_API_KEY: '' });
    await withConfig(h);
    expect(await h.run('scan', '--dry-run')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toMatch(/\[dry-run\]/);
    expect(text).toContain('https://api.anthropic.com/v1/messages');
    expect(text).toContain('Handle faded thermal receipts 12');
    expect(text).not.toContain('sk-ant');
    expect(h.calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(existsSync(join(h.dir, '.expense-bridge/queue.json'))).toBe(false);
    expect(existsSync(join(h.dir, '.expense-bridge/cursor.json'))).toBe(false);
  });

  it('queues a clean digest as ready, advances the cursor, and keeps only known feedback ids', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    mkdirSync(join(h.dir, '.expense-bridge'), { recursive: true });
    writeFileSync(
      join(h.dir, '.expense-bridge/feedback.json'),
      JSON.stringify({ fetched_at: 'x', feedback: [{ id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: 'x' }] }),
    );
    expect(await h.run('scan')).toBe(0);
    const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    const items = queue.list('ready');
    expect(items).toHaveLength(1);
    expect(items[0]!.digest.external_ref).toBe(computeExternalRef('jre-coder/corvago', 12, MERGED));
    expect(items[0]!.digest.addresses_feedback).toEqual(['fb_1']);
    expect(items[0]!.digest.shipped_at).toBe('2026-11-13');
    expect(items[0]!.digest.bridge_version).toBe(BRIDGE_VERSION);
    expect(items[0]!.source).toBe('jre-coder/corvago#12');
    const cursor = JSON.parse(readFileSync(join(h.dir, '.expense-bridge/cursor.json'), 'utf8'));
    expect(cursor.last_merged_at).toBe(MERGED);
    expect(h.out.join('\n')).toMatch(/1 ready/);
    const anthropicCall = h.calls.find((c) => c.url.startsWith('https://api.anthropic.com/'))!;
    expect(JSON.stringify(anthropicCall.body)).toContain('fb_1');
  });

  it('uses a 30-day default window when there is no cursor, and the cursor afterwards', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    expect(await h.run('scan')).toBe(0);
    expect(h.out.join('\n')).toMatch(/2026-10-15/);
    h.out.length = 0;
    h.calls.length = 0;
    expect(await h.run('scan')).toBe(0);
    expect(h.out.join('\n')).toMatch(/No merged pull requests since 2026-11-13T09:30:00Z/);
    expect(h.calls.some((c) => c.url.startsWith('https://api.anthropic.com/'))).toBe(false);
  });

  it('honours --since and --limit', async () => {
    const h = harness((url, init) => {
      if (url.startsWith('https://api.github.com/repos/jre-coder/corvago/pulls?')) return jsonResponse([pull(13, '2026-11-13T10:00:00Z'), pull(12), pull(11, '2026-11-12T00:00:00Z')]);
      if (url.includes('/files')) return jsonResponse(prFiles);
      return defaultResponder(url, init, 0);
    });
    await withConfig(h);
    expect(await h.run('scan', '--since', '2026-11-12T12:00:00Z', '--limit', '1')).toBe(0);
    const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    expect(queue.list().map((i) => i.source)).toEqual(['jre-coder/corvago#12']);
    expect(h.out.join('\n')).toMatch(/limit/);
  });

  it('holds a digest that trips the redaction gate and says so', async () => {
    const h = harness((url, init, n) => (url.startsWith('https://api.anthropic.com/') ? anthropicReply(dirtyDraft) : defaultResponder(url, init, n)));
    await withConfig(h);
    expect(await h.run('scan')).toBe(0);
    const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    expect(queue.list('held')).toHaveLength(1);
    expect(queue.list('held')[0]!.findings[0]!.class).toBe('path');
    expect(h.out.join('\n')).toMatch(/1 held/);
    expect(h.out.join('\n')).toMatch(/expense-bridge review/);
  });

  it('stops at the first provider failure, keeps the cursor at the last success, exits 1', async () => {
    const h = harness((url, init, n) => {
      if (url.startsWith('https://api.github.com/repos/jre-coder/corvago/pulls?')) return jsonResponse([pull(13, '2026-11-13T10:00:00Z'), pull(12)]);
      if (url.includes('/files')) return jsonResponse(prFiles);
      if (url.startsWith('https://api.anthropic.com/')) {
        const body = init.body as string;
        return body.includes('receipts 13') ? jsonResponse({ error: { message: 'overloaded' } }, 529) : anthropicReply(cleanDraft);
      }
      return defaultResponder(url, init, n);
    });
    await withConfig(h);
    expect(await h.run('scan')).toBe(1);
    expect(h.err.join('\n')).toMatch(/529/);
    const cursor = JSON.parse(readFileSync(join(h.dir, '.expense-bridge/cursor.json'), 'utf8'));
    expect(cursor.last_merged_at).toBe(MERGED);
    expect(new QueueStore(join(h.dir, '.expense-bridge/queue.json')).list()).toHaveLength(1);
  });

  it('reports a schema failure from the model as an error without queueing', async () => {
    const h = harness((url, init, n) => (url.startsWith('https://api.anthropic.com/') ? anthropicReply({ ...cleanDraft, title: 'x'.repeat(500) }) : defaultResponder(url, init, n)));
    await withConfig(h);
    expect(await h.run('scan')).toBe(1);
    expect(h.err.join('\n')).toMatch(/title/);
    expect(existsSync(join(h.dir, '.expense-bridge/queue.json'))).toBe(false);
  });

  it('ignores a corrupt feedback cache with a warning', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    mkdirSync(join(h.dir, '.expense-bridge'), { recursive: true });
    writeFileSync(join(h.dir, '.expense-bridge/feedback.json'), '{nope');
    expect(await h.run('scan')).toBe(0);
    expect(h.err.join('\n')).toMatch(/feedback cache/i);
  });

  it('works with the key-less ollama provider against localhost', async () => {
    const h = harness((url, init, n) =>
      url.startsWith('http://localhost:11434/')
        ? jsonResponse({ message: { role: 'assistant', content: JSON.stringify(cleanDraft) }, done: true })
        : defaultResponder(url, init, n),
    );
    await withConfig(h, ['--provider', 'ollama']);
    expect(await h.run('scan')).toBe(0);
    expect(new QueueStore(join(h.dir, '.expense-bridge/queue.json')).list('ready')).toHaveLength(1);
    const ollamaCall = h.calls.find((c) => c.url.startsWith('http://localhost:11434/'))!;
    expect(JSON.stringify(ollamaCall.init.headers)).not.toMatch(/authorization/i);
  });

  it('surfaces GitHub errors', async () => {
    const h = harness(() => jsonResponse({ message: 'Bad credentials' }, 401));
    await withConfig(h);
    expect(await h.run('scan')).toBe(1);
    expect(h.err.join('\n')).toMatch(/401/);
  });
});

describe('cli: review', () => {
  function seeded(): Promise<Harness> {
    const h = harness(defaultResponder);
    return withConfig(h).then(() => {
      const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
      queue.add({ digest: validDigest, status: 'ready', findings: [], source: 'jre-coder/corvago#1' });
      queue.add({ digest: minimalDigest, status: 'held', findings: [{ class: 'path', field: 'summary', masked: 'src/s*******s' }], source: 'jre-coder/corvago#2' });
      return h;
    });
  }

  it('prints held items with their findings and the full digest, and the queue summary', async () => {
    const h = await seeded();
    expect(await h.run('review')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain(minimalDigest.external_ref);
    expect(text).toContain('path');
    expect(text).toContain('src/s*******s');
    expect(text).toContain('"summary"');
    expect(text).toMatch(/1 ready/);
    expect(text).toMatch(/--approve/);
  });

  it('prints JSON with --json', async () => {
    const h = await seeded();
    expect(await h.run('review', '--json')).toBe(0);
    const parsed = JSON.parse(h.out.join('\n'));
    expect(parsed.held).toHaveLength(1);
  });

  it('says so when nothing is held', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    expect(await h.run('review')).toBe(0);
    expect(h.out.join('\n')).toMatch(/Nothing held/);
  });

  it('approves and rejects by external_ref, failing on unknown refs', async () => {
    const h = await seeded();
    expect(await h.run('review', '--approve', minimalDigest.external_ref)).toBe(0);
    expect(new QueueStore(join(h.dir, '.expense-bridge/queue.json')).get(minimalDigest.external_ref)?.status).toBe('approved');
    expect(h.out.join('\n')).toMatch(/Approved/);
    expect(await h.run('review', '--reject', minimalDigest.external_ref)).toBe(1);
    expect(h.err.join('\n')).toMatch(/not held/);
    expect(await h.run('review', '--approve', 'ffffffffffffffff')).toBe(1);
    const h2 = await seeded();
    expect(await h2.run('review', '--reject', minimalDigest.external_ref)).toBe(0);
    expect(new QueueStore(join(h2.dir, '.expense-bridge/queue.json')).get(minimalDigest.external_ref)?.status).toBe('rejected');
  });
});

describe('cli: send', () => {
  async function seeded(responder: Responder = defaultResponder, count = 1): Promise<Harness> {
    const h = harness(responder);
    await withConfig(h);
    const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    for (let i = 0; i < count; i++) {
      queue.add({ digest: { ...validDigest, external_ref: i.toString(16).padStart(16, '0') }, status: 'ready', findings: [], source: `s#${i}` });
    }
    return h;
  }

  it('says when there is nothing to send and makes no request', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    expect(await h.run('send')).toBe(0);
    expect(h.out.join('\n')).toMatch(/Nothing to send/);
    expect(h.calls).toHaveLength(0);
  });

  it('--dry-run prints the exact payload, sends nothing and marks nothing', async () => {
    const h = await seeded();
    expect(await h.run('send', '--dry-run')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain(`POST ${API}/bridge/digests`);
    expect(text).toContain('"project_ref": "corvago"');
    expect(text).toContain('Bearer ****');
    expect(text).not.toContain('brk_key');
    expect(h.calls).toHaveLength(0);
    expect(new QueueStore(join(h.dir, '.expense-bridge/queue.json')).list('sent')).toHaveLength(0);
  });

  it('sends ready and approved items, marks accepted and duplicate items sent, reports rejected ones', async () => {
    const h = await seeded((url, init) => {
      if (url === `${API}/bridge/digests`) {
        const body = JSON.parse(init.body as string) as { digests: Array<{ external_ref: string }> };
        const refs = body.digests.map((d) => d.external_ref);
        return jsonResponse({
          accepted: [{ external_ref: refs[0], digest_id: 'd1' }, ...(refs[3] ? [{ external_ref: refs[3], digest_id: 'd4' }] : [])],
          duplicates: [refs[1]],
          rejected: [{ external_ref: refs[2], code: 'invalid_digest', message: 'summary too long' }],
        });
      }
      return textResponse('unrouted', 500);
    }, 3);
    const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    queue.add({ digest: minimalDigest, status: 'held', findings: [], source: 'held' });
    queue.approve(minimalDigest.external_ref, 'now');
    expect(await h.run('send')).toBe(1);
    const after = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    expect(after.list('sent').map((i) => i.digest.external_ref).sort()).toEqual(['0000000000000000', '0000000000000001', minimalDigest.external_ref].sort());
    expect(after.get('0000000000000002')?.status).toBe('ready');
    expect(h.err.join('\n')).toMatch(/invalid_digest/);
    expect(h.out.join('\n')).toMatch(/Sent 3/);
    expect(h.out.join('\n')).toMatch(/1 rejected/);
  });

  it('marks everything sent when the server returns no structured body', async () => {
    const h = await seeded(() => new Response(null, { status: 204 }), 2);
    expect(await h.run('send')).toBe(0);
    expect(new QueueStore(join(h.dir, '.expense-bridge/queue.json')).list('sent')).toHaveLength(2);
  });

  it('batches at 50 digests per request', async () => {
    const h = await seeded(defaultResponder, 51);
    expect(await h.run('send')).toBe(0);
    expect(h.calls.filter((c) => c.url === `${API}/bridge/digests`)).toHaveLength(2);
  });

  it('surfaces an API error with its code and exits 1 without marking sent', async () => {
    const h = await seeded(() => jsonResponse({ error: { code: 'invalid_bridge_key', message: 'revoked' } }, 401));
    expect(await h.run('send')).toBe(1);
    expect(h.err.join('\n')).toMatch(/invalid_bridge_key/);
    expect(new QueueStore(join(h.dir, '.expense-bridge/queue.json')).list('sent')).toHaveLength(0);
  });
});

describe('cli: sync-feedback', () => {
  it('--dry-run prints the GET request and writes nothing', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    expect(await h.run('sync-feedback', '--dry-run')).toBe(0);
    expect(h.out.join('\n')).toContain(`GET ${API}/bridge/feedback?status=open`);
    expect(h.calls).toHaveLength(0);
    expect(existsSync(join(h.dir, '.expense-bridge/feedback.json'))).toBe(false);
  });

  it('writes the feedback cache', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    expect(await h.run('sync-feedback')).toBe(0);
    const cache = JSON.parse(readFileSync(join(h.dir, '.expense-bridge/feedback.json'), 'utf8'));
    expect(cache.feedback[0].id).toBe('fb_1');
    expect(cache.fetched_at).toBe('2026-11-14T12:00:00.000Z');
    expect(h.out.join('\n')).toMatch(/1 open feedback/);
  });
});

describe('cli: resolve', () => {
  const matches = (list: unknown[]) => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ matches: list }) }] });

  async function seeded(responder: Responder): Promise<Harness> {
    const h = harness(responder);
    await withConfig(h);
    const queue = new QueueStore(join(h.dir, '.expense-bridge/queue.json'));
    queue.add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    queue.markSent([validDigest.external_ref], 'now');
    return h;
  }

  it('says so when there are no digests or no open feedback', async () => {
    const h = harness(defaultResponder);
    await withConfig(h);
    expect(await h.run('resolve')).toBe(0);
    expect(h.out.join('\n')).toMatch(/No digests/);
    const h2 = await seeded((url, init, n) => (url.startsWith(`${API}/bridge/feedback`) ? jsonResponse({ feedback: [], next_cursor: null }) : defaultResponder(url, init, n)));
    expect(await h2.run('resolve')).toBe(0);
    expect(h2.out.join('\n')).toMatch(/No open feedback/);
  });

  it('--dry-run uses the cached feedback, prints the provider request and the resolution endpoint, posts nothing', async () => {
    const h = await seeded(defaultResponder);
    mkdirSync(join(h.dir, '.expense-bridge'), { recursive: true });
    writeFileSync(join(h.dir, '.expense-bridge/feedback.json'), JSON.stringify({ fetched_at: 'x', feedback: [{ id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: 'x' }] }));
    expect(await h.run('resolve', '--dry-run')).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('https://api.anthropic.com/v1/messages');
    expect(text).toContain('fb_1');
    expect(text).toContain('/bridge/resolutions');
    expect(h.calls).toHaveLength(0);
  });

  it('--dry-run with no cached feedback explains how to get some', async () => {
    const h = await seeded(defaultResponder);
    expect(await h.run('resolve', '--dry-run')).toBe(0);
    expect(h.out.join('\n')).toMatch(/sync-feedback/);
  });

  it('posts confident matches, skips weak ones and ones whose note trips the gate', async () => {
    const h = await seeded((url, init, n) => {
      if (url.startsWith('https://api.anthropic.com/')) {
        return matches([
          { feedback_id: 'fb_1', digest_external_ref: validDigest.external_ref, confidence: 0.9, note: 'The faded-receipt fix should cover this; try scanning an old receipt again.' },
          { feedback_id: 'fb_2', digest_external_ref: validDigest.external_ref, confidence: 0.3, note: 'Weak.' },
          { feedback_id: 'fb_3', digest_external_ref: validDigest.external_ref, confidence: 0.95, note: 'Fixed in src/services/receiptService.ts.' },
        ]);
      }
      if (url.startsWith(`${API}/bridge/feedback`)) {
        return jsonResponse({
          feedback: ['fb_1', 'fb_2', 'fb_3'].map((id) => ({ id, text: 'something', severity: 'low', status: 'open', created_at: 'x' })),
          next_cursor: null,
        });
      }
      return defaultResponder(url, init, n);
    });
    expect(await h.run('resolve')).toBe(0);
    const posts = h.calls.filter((c) => c.url === `${API}/bridge/resolutions`);
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { feedback_id: string }).feedback_id).toBe('fb_1');
    expect(h.err.join('\n')).toMatch(/fb_3/);
    expect(h.err.join('\n')).toMatch(/path/);
    expect(h.out.join('\n')).toMatch(/Posted 1 resolution/);
    expect(h.out.join('\n')).toMatch(/1 below confidence/);
    expect(existsSync(join(h.dir, '.expense-bridge/feedback.json'))).toBe(true);
  });

  it('honours --min-confidence', async () => {
    const h = await seeded((url, init, n) =>
      url.startsWith('https://api.anthropic.com/')
        ? matches([{ feedback_id: 'fb_1', digest_external_ref: validDigest.external_ref, confidence: 0.65, note: 'Likely covered by the faded-receipt fix.' }])
        : defaultResponder(url, init, n),
    );
    expect(await h.run('resolve', '--min-confidence', '0.9')).toBe(0);
    expect(h.calls.filter((c) => c.url === `${API}/bridge/resolutions`)).toHaveLength(0);
    expect(await h.run('resolve', '--min-confidence', 'abc')).toBe(2);
  });

  it('surfaces provider errors with exit 1', async () => {
    const h = await seeded((url, init, n) => (url.startsWith('https://api.anthropic.com/') ? textResponse('down', 503) : defaultResponder(url, init, n)));
    expect(await h.run('resolve')).toBe(1);
    expect(h.err.join('\n')).toMatch(/503/);
  });
});

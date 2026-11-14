import { describe, it, expect } from 'vitest';
import {
  buildDigestsRequest,
  buildFeedbackRequest,
  buildResolutionRequest,
  describeRequest,
  sendRequest,
  fetchAllFeedback,
  OutboundError,
  MAX_DIGESTS_PER_REQUEST,
  defaultSleep,
} from '../src/outbound.js';
import { mockFetch, jsonResponse, textResponse, headerOf } from './helpers.js';
import { validDigest, minimalDigest } from './fixtures/digests.js';

const api = { apiBaseUrl: 'https://api.expensetracker.example/', bridgeKey: 'brk_secret_value' };

describe('request builders', () => {
  it('POST /bridge/digests carries the bearer key, project_ref and digests, with an idempotency key derived from the body', () => {
    const req = buildDigestsRequest({ ...api, projectRef: 'corvago', digests: [validDigest, minimalDigest] });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.expensetracker.example/bridge/digests');
    expect(req.headers['authorization']).toBe('Bearer brk_secret_value');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['user-agent']).toMatch(/^expense-bridge\//);
    expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(req.body!);
    expect(body).toEqual({ project_ref: 'corvago', digests: [validDigest, minimalDigest] });
    const again = buildDigestsRequest({ ...api, projectRef: 'corvago', digests: [validDigest, minimalDigest] });
    expect(again.headers['idempotency-key']).toBe(req.headers['idempotency-key']);
  });

  it('re-validates every digest through the closed schema and refuses to build on a violation', () => {
    expect(() => buildDigestsRequest({ ...api, projectRef: 'p', digests: [{ ...validDigest, title: 'x'.repeat(200) }] })).toThrow(/title/);
    const req = buildDigestsRequest({ ...api, projectRef: 'p', digests: [{ ...validDigest, pr_url: 'https://github.com/x' } as never] });
    expect(req.body).not.toContain('pr_url');
  });

  it('refuses more than MAX_DIGESTS_PER_REQUEST digests and an empty list', () => {
    expect(() => buildDigestsRequest({ ...api, projectRef: 'p', digests: [] })).toThrow(/at least one/i);
    const many = Array.from({ length: MAX_DIGESTS_PER_REQUEST + 1 }, (_, i) => ({ ...validDigest, external_ref: i.toString(16).padStart(16, '0') }));
    expect(() => buildDigestsRequest({ ...api, projectRef: 'p', digests: many })).toThrow(/at most/i);
  });

  it('GET /bridge/feedback?status=open with optional cursor', () => {
    const req = buildFeedbackRequest({ ...api });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://api.expensetracker.example/bridge/feedback?status=open');
    expect(req.body).toBeUndefined();
    expect(buildFeedbackRequest({ ...api, cursor: 'abc def' }).url).toBe('https://api.expensetracker.example/bridge/feedback?status=open&cursor=abc+def');
  });

  it('POST /bridge/resolutions validates the resolution shape', () => {
    const req = buildResolutionRequest({
      ...api,
      resolution: { feedback_id: 'fb_1', digest_external_ref: validDigest.external_ref, confidence: 0.9, note: 'Covered by the faded-receipt fix.' },
    });
    expect(req.url).toBe('https://api.expensetracker.example/bridge/resolutions');
    expect(JSON.parse(req.body!)).toEqual({ feedback_id: 'fb_1', digest_external_ref: validDigest.external_ref, confidence: 0.9, note: 'Covered by the faded-receipt fix.' });
    expect(() => buildResolutionRequest({ ...api, resolution: { feedback_id: 'fb_1', digest_external_ref: 'x', confidence: 0.9, note: '' } })).toThrow(/digest_external_ref/);
  });

  it('rejects an api base URL that is not https (except localhost for development)', () => {
    expect(() => buildFeedbackRequest({ apiBaseUrl: 'http://api.example', bridgeKey: 'k' })).toThrow(/https/);
    expect(buildFeedbackRequest({ apiBaseUrl: 'http://localhost:54321/functions/v1', bridgeKey: 'k' }).url).toBe('http://localhost:54321/functions/v1/bridge/feedback?status=open');
  });
});

describe('describeRequest', () => {
  it('masks the bearer key and pretty-prints the body', () => {
    const req = buildDigestsRequest({ ...api, projectRef: 'p', digests: [validDigest] });
    const text = describeRequest(req);
    expect(text).not.toContain('brk_secret_value');
    expect(text).toContain('Bearer ****');
    expect(text).toContain('POST https://api.expensetracker.example/bridge/digests');
    expect(text).toContain('"external_ref": "0123456789abcdef"');
  });
  it('handles a body-less request', () => {
    expect(describeRequest(buildFeedbackRequest(api))).toContain('(no body)');
  });
});

describe('sendRequest', () => {
  const req = () => buildDigestsRequest({ ...api, projectRef: 'p', digests: [validDigest] });

  it('dry-run prints the exact payload and performs no fetch', async () => {
    const out: string[] = [];
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const result = await sendRequest(req(), { fetch, dryRun: true, out: (s) => out.push(s) });
    expect(result).toEqual({ dryRun: true });
    expect(calls).toHaveLength(0);
    expect(out.join('\n')).toContain('/bridge/digests');
    expect(out.join('\n')).not.toContain('brk_secret_value');
  });

  it('sends with the built headers and returns the parsed JSON body', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ accepted: [{ external_ref: validDigest.external_ref, digest_id: 'd1' }], duplicates: [], rejected: [] }));
    const result = await sendRequest(req(), { fetch, dryRun: false, out: () => undefined });
    expect(result).toEqual({ dryRun: false, status: 200, body: { accepted: [{ external_ref: validDigest.external_ref, digest_id: 'd1' }], duplicates: [], rejected: [] } });
    expect(headerOf(calls[0]!.init, 'authorization')).toBe('Bearer brk_secret_value');
    expect(headerOf(calls[0]!.init, 'idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('retries on 429 and 5xx and network errors with the same idempotency key, then succeeds', async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = mockFetch((_u, _i, n) => {
      if (n === 0) return jsonResponse({ error: { code: 'rate_limited', message: 'slow down' } }, 429);
      if (n === 1) return new Error('ECONNRESET');
      if (n === 2) return textResponse('bad gateway', 502);
      return jsonResponse({ ok: true });
    });
    const result = await sendRequest(req(), { fetch, dryRun: false, out: () => undefined, sleep: async (ms) => { sleeps.push(ms); }, maxAttempts: 4 });
    expect(result.dryRun).toBe(false);
    expect(calls).toHaveLength(4);
    const keys = new Set(calls.map((c) => headerOf(c.init, 'idempotency-key')));
    expect(keys.size).toBe(1);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it('gives up after maxAttempts with an OutboundError carrying the last status', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ error: { code: 'rate_limited', message: 'slow down' } }, 429));
    const err = await sendRequest(req(), { fetch, dryRun: false, out: () => undefined, sleep: async () => undefined, maxAttempts: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundError);
    expect((err as OutboundError).status).toBe(429);
    expect((err as OutboundError).code).toBe('rate_limited');
    expect(calls).toHaveLength(2);
  });

  it('surfaces a network failure after exhausting retries', async () => {
    const { fetch } = mockFetch(() => new Error('ENOTFOUND'));
    await expect(sendRequest(req(), { fetch, dryRun: false, out: () => undefined, sleep: async () => undefined, maxAttempts: 2 })).rejects.toThrow(/ENOTFOUND/);
  });

  it('does not retry 4xx other than 429 and reports the server error code', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ error: { code: 'invalid_bridge_key', message: 'revoked' } }, 401));
    const err = (await sendRequest(req(), { fetch, dryRun: false, out: () => undefined }).catch((e: unknown) => e)) as OutboundError;
    expect(err).toBeInstanceOf(OutboundError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid_bridge_key');
    expect(err.message).toContain('revoked');
    expect(calls).toHaveLength(1);
  });

  it('handles a non-JSON error body and an empty success body', async () => {
    const f1 = mockFetch(() => textResponse('forbidden', 403)).fetch;
    const err = (await sendRequest(req(), { fetch: f1, dryRun: false, out: () => undefined }).catch((e: unknown) => e)) as OutboundError;
    expect(err.code).toBe('http_403');
    const f2 = mockFetch(() => new Response(null, { status: 204 })).fetch;
    const result = await sendRequest(req(), { fetch: f2, dryRun: false, out: () => undefined });
    expect(result).toEqual({ dryRun: false, status: 204, body: null });
  });
});

describe('fetchAllFeedback', () => {
  it('follows next_cursor until null and validates items', async () => {
    const item = (id: string) => ({ id, text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: '2026-11-01T00:00:00Z' });
    const { fetch, calls } = mockFetch((url) =>
      url.includes('cursor=') ? jsonResponse({ feedback: [item('fb_2')], next_cursor: null }) : jsonResponse({ feedback: [item('fb_1')], next_cursor: 'c2' }),
    );
    const all = await fetchAllFeedback({ ...api, fetch, out: () => undefined });
    expect(all.map((f) => f.id)).toEqual(['fb_1', 'fb_2']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('cursor=c2');
  });

  it('rejects an unexpected response shape', async () => {
    const { fetch } = mockFetch(() => jsonResponse({ items: [] }));
    await expect(fetchAllFeedback({ ...api, fetch, out: () => undefined })).rejects.toThrow(/feedback/i);
  });

  it('stops after a hard page cap to avoid a runaway loop', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ feedback: [], next_cursor: 'again' }));
    await fetchAllFeedback({ ...api, fetch, out: () => undefined, maxPages: 3 });
    expect(calls).toHaveLength(3);
  });
});

describe('sendRequest edge cases', () => {
  const req = () => buildDigestsRequest({ ...api, projectRef: 'p', digests: [validDigest] });

  it('uses an empty message when the server error has a code but no message, and http_<status> when the JSON has no error.code', async () => {
    const f1 = mockFetch(() => jsonResponse({ error: { code: 'project_mismatch' } }, 403)).fetch;
    const e1 = (await sendRequest(req(), { fetch: f1, dryRun: false, out: () => undefined }).catch((e: unknown) => e)) as OutboundError;
    expect(e1.code).toBe('project_mismatch');
    const f2 = mockFetch(() => jsonResponse({ unexpected: true }, 400)).fetch;
    const e2 = (await sendRequest(req(), { fetch: f2, dryRun: false, out: () => undefined }).catch((e: unknown) => e)) as OutboundError;
    expect(e2.code).toBe('http_400');
  });

  it('wraps a non-Error rejection from fetch', async () => {
    const fetch = (async () => {
      throw 'socket hang up';
    }) as unknown as typeof globalThis.fetch;
    await expect(sendRequest(req(), { fetch, dryRun: false, out: () => undefined, sleep: async () => undefined, maxAttempts: 1 })).rejects.toThrow(/socket hang up/);
  });

  it('defaultSleep resolves after the given time', async () => {
    const started = Date.now();
    await defaultSleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3);
  });
});

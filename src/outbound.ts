/**
 * The ONLY module that talks to the Expense Tracker API (a test greps src/ to
 * enforce it). Three Supabase Edge Functions, decisions.md §6; `api_base_url`
 * ends in `/functions/v1` and the functions cannot serve nested paths, so the
 * names are flat:
 *
 *   POST <api_base_url>/bridge-digests      { project_ref, digests: Digest[] }
 *   GET  <api_base_url>/bridge-feedback?status=open[&cursor=…]
 *   POST <api_base_url>/bridge-resolutions  { feedback_id, digest_external_ref, confidence, note }
 *
 * Every digest passes through the closed schema again here, so nothing
 * outside it can be serialised even if a caller forgets the earlier gate.
 * Retries are idempotent: the `idempotency-key` header is the sha256 of the
 * body and stays the same across attempts.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseDigest, ResolutionMatchSchema, type Digest, type ResolutionMatch } from './schema.js';
import { BRIDGE_VERSION } from './version.js';
import { maskHeaders } from './providers/shared.js';
import type { FeedbackItem, FetchLike } from './providers/types.js';

export const MAX_DIGESTS_PER_REQUEST = 50;

export interface OutboundRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export class OutboundError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OutboundError';
  }
}

interface ApiTarget {
  apiBaseUrl: string;
  bridgeKey: string;
}

function baseUrl(apiBaseUrl: string): string {
  const url = new URL(apiBaseUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) throw new Error(`api_base_url must use https (got ${url.protocol}//${url.host})`);
  return apiBaseUrl.replace(/\/+$/, '');
}

function headers(target: ApiTarget, body?: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${target.bridgeKey}`,
    accept: 'application/json',
    'user-agent': `expense-bridge/${BRIDGE_VERSION}`,
  };
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    h['idempotency-key'] = createHash('sha256').update(body).digest('hex');
  }
  return h;
}

export function buildDigestsRequest(opts: ApiTarget & { projectRef: string; digests: Digest[] }): OutboundRequest {
  if (opts.digests.length === 0) throw new Error('At least one digest is required.');
  if (opts.digests.length > MAX_DIGESTS_PER_REQUEST) throw new Error(`At most ${MAX_DIGESTS_PER_REQUEST} digests per request.`);
  const digests = opts.digests.map((d) => {
    const result = parseDigest(d);
    if (!result.ok) throw new Error(`Digest failed the closed schema: ${result.issues.join('; ')}`);
    return result.digest;
  });
  const body = JSON.stringify({ project_ref: opts.projectRef, digests });
  return { method: 'POST', url: `${baseUrl(opts.apiBaseUrl)}/bridge-digests`, headers: headers(opts, body), body };
}

export function buildFeedbackRequest(opts: ApiTarget & { cursor?: string }): OutboundRequest {
  const params = new URLSearchParams({ status: 'open' });
  if (opts.cursor) params.set('cursor', opts.cursor);
  return { method: 'GET', url: `${baseUrl(opts.apiBaseUrl)}/bridge-feedback?${params.toString()}`, headers: headers(opts) };
}

export function buildResolutionRequest(opts: ApiTarget & { resolution: ResolutionMatch }): OutboundRequest {
  const parsed = ResolutionMatchSchema.safeParse(opts.resolution);
  if (!parsed.success) throw new Error(`Resolution failed the schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const body = JSON.stringify(parsed.data);
  return { method: 'POST', url: `${baseUrl(opts.apiBaseUrl)}/bridge-resolutions`, headers: headers(opts, body), body };
}

/** Exactly what would go over the wire, with the key masked. */
export function describeRequest(req: OutboundRequest): string {
  const lines = [`${req.method} ${req.url}`];
  for (const [k, v] of Object.entries(maskHeaders(req.headers))) lines.push(`${k}: ${v}`);
  lines.push('');
  lines.push(req.body === undefined ? '(no body)' : JSON.stringify(JSON.parse(req.body), null, 2));
  return lines.join('\n');
}

export interface SendOptions {
  fetch: FetchLike;
  dryRun: boolean;
  out: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export type SendResult = { dryRun: true } | { dryRun: false; status: number; body: unknown };

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseError(status: number, text: string): { code: string; message: string } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (parsed.error?.code) return { code: parsed.error.code, message: parsed.error.message ?? '' };
  } catch {
    /* fall through */
  }
  return { code: `http_${status}`, message: text.slice(0, 200) };
}

export async function sendRequest(req: OutboundRequest, options: SendOptions): Promise<SendResult> {
  if (options.dryRun) {
    options.out(`[dry-run] would send:\n${describeRequest(req)}`);
    return { dryRun: true };
  }
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: Error = new Error('unreachable');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
    let response: Response;
    try {
      const init: RequestInit = { method: req.method, headers: req.headers };
      if (req.body !== undefined) init.body = req.body;
      response = await options.fetch(req.url, init);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
    const text = await response.text();
    if (response.ok) return { dryRun: false, status: response.status, body: text === '' ? null : JSON.parse(text) };
    const { code, message } = parseError(response.status, text);
    lastError = new OutboundError(`Expense Tracker API returned ${response.status} (${code}): ${message}`, response.status, code);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) throw lastError;
  }
  throw lastError;
}

const FeedbackItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  severity: z.string(),
  status: z.string(),
  created_at: z.string(),
});
const FeedbackResponseSchema = z.object({ feedback: z.array(FeedbackItemSchema), next_cursor: z.string().nullable() });

export async function fetchAllFeedback(opts: ApiTarget & { fetch: FetchLike; out: (line: string) => void; maxPages?: number }): Promise<FeedbackItem[]> {
  const all: FeedbackItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 20); page++) {
    const req = buildFeedbackRequest(cursor ? { ...opts, cursor } : opts);
    const result = await sendRequest(req, { fetch: opts.fetch, dryRun: false, out: opts.out });
    const parsed = FeedbackResponseSchema.safeParse((result as { body: unknown }).body);
    if (!parsed.success) throw new Error('Unexpected feedback response shape from the Expense Tracker API.');
    all.push(...parsed.data.feedback);
    if (parsed.data.next_cursor === null) break;
    cursor = parsed.data.next_cursor;
  }
  return all;
}

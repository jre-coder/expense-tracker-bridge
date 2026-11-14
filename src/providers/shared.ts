import {
  parseDigestDraft,
  ResolutionMatchSchema,
  DIGEST_DRAFT_MODEL_SCHEMA,
  RESOLUTION_MATCH_MODEL_SCHEMA,
  type Digest,
  type DigestDraft,
  type ResolutionMatch,
} from '../schema.js';
import { DIGEST_SYSTEM_PROMPT, RESOLUTION_SYSTEM_PROMPT, buildDigestUserMessage, buildResolutionUserMessage } from '../prompt.js';
import type { DescribedRequest, DigestInput, FeedbackItem, FetchLike, Provider } from './types.js';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);

/** Credentials never reach stdout: --dry-run prints headers through this. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? (v.startsWith('Bearer ') ? 'Bearer ****' : '****') : v;
  }
  return out;
}

/** Find the first JSON object in a model reply (tolerates code fences and stray prose). */
export function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new ProviderError(
      text.trimStart().startsWith('[') ? 'Model reply was a JSON array, expected an object' : 'Model reply did not contain a JSON object',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ProviderError('Model reply was not valid JSON');
  }
  return parsed as Record<string, unknown>;
}

/** Validate a draft and keep only feedback ids the server actually issued. */
export function draftFromModelOutput(raw: unknown, knownFeedbackIds: Set<string>): DigestDraft {
  const result = parseDigestDraft(raw);
  if (!result.ok) throw new ProviderError(`Model output failed the digest schema: ${result.issues.join('; ')}`);
  return { ...result.digest, addresses_feedback: result.digest.addresses_feedback.filter((id) => knownFeedbackIds.has(id)) };
}

export function matchesFromModelOutput(raw: unknown, knownFeedbackIds: Set<string>, knownRefs: Set<string>): ResolutionMatch[] {
  const matches = (raw as Record<string, unknown>)['matches'];
  if (!Array.isArray(matches)) throw new ProviderError('Model output has no "matches" array');
  const out: ResolutionMatch[] = [];
  for (const item of matches) {
    const parsed = ResolutionMatchSchema.safeParse(item);
    if (!parsed.success) {
      throw new ProviderError(`Model output match failed the schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    if (knownFeedbackIds.has(parsed.data.feedback_id) && knownRefs.has(parsed.data.digest_external_ref)) out.push(parsed.data);
  }
  return out;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  json: Record<string, unknown> | null;
  text: string;
}

export async function postJson(fetch: FetchLike, url: string, headers: Record<string, string>, body: string): Promise<HttpResult> {
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text };
}

export function httpError(name: string, result: HttpResult): ProviderError {
  const detail = result.json ? JSON.stringify(result.json).slice(0, 300) : result.text.slice(0, 300);
  return new ProviderError(`${name} returned HTTP ${result.status}: ${detail}`, result.status);
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

/**
 * Template shared by the three providers: build request → POST → extract the
 * model's text → parse JSON → validate against our schema.
 */
export abstract class BaseProvider implements Provider {
  abstract readonly name: Provider['name'];

  protected constructor(
    protected readonly model: string,
    protected readonly fetchImpl: FetchLike,
  ) {}

  /** Build the exact request; `headers` are REAL and must be masked before display. */
  protected abstract buildRequest(system: string, user: string, schema: object): DescribedRequest;
  protected abstract extractText(result: HttpResult): string;

  private async complete(system: string, user: string, schema: object): Promise<Record<string, unknown>> {
    const request = this.buildRequest(system, user, schema);
    const result = await postJson(this.fetchImpl, request.url, request.headers, request.body);
    if (!result.ok) throw httpError(this.name, result);
    if (result.json === null) throw new ProviderError(`${this.name} returned a non-JSON body`, result.status);
    return extractJsonObject(this.extractText(result));
  }

  async generateDigest(input: DigestInput): Promise<DigestDraft> {
    const raw = await this.complete(DIGEST_SYSTEM_PROMPT, buildDigestUserMessage(input), DIGEST_DRAFT_MODEL_SCHEMA);
    return draftFromModelOutput(raw, new Set(input.openFeedback.map((f) => f.id)));
  }

  async matchResolutions(feedback: FeedbackItem[], digests: Digest[]): Promise<ResolutionMatch[]> {
    const raw = await this.complete(RESOLUTION_SYSTEM_PROMPT, buildResolutionUserMessage(feedback, digests), RESOLUTION_MATCH_MODEL_SCHEMA);
    return matchesFromModelOutput(raw, new Set(feedback.map((f) => f.id)), new Set(digests.map((d) => d.external_ref)));
  }

  private describe(request: DescribedRequest): DescribedRequest {
    return { ...request, headers: maskHeaders(request.headers) };
  }

  describeDigestRequest(input: DigestInput): DescribedRequest {
    return this.describe(this.buildRequest(DIGEST_SYSTEM_PROMPT, buildDigestUserMessage(input), DIGEST_DRAFT_MODEL_SCHEMA));
  }

  describeResolutionRequest(feedback: FeedbackItem[], digests: Digest[]): DescribedRequest {
    return this.describe(this.buildRequest(RESOLUTION_SYSTEM_PROMPT, buildResolutionUserMessage(feedback, digests), RESOLUTION_MATCH_MODEL_SCHEMA));
  }
}

/**
 * The closed Digest schema — decisions.md §6, verbatim.
 *
 * This is an allow-list: `parseDigest` first strips every key that is not in
 * the schema, then validates with `.strict()`. Anything the model (or a bug)
 * adds beyond these fields never reaches the wire.
 *
 * `external_ref` is OPAQUE TO THE SERVER. It is the first 16 hex characters of
 * sha256(repo_full_name + '#' + pr_number + merged_at). The server uses it only
 * as an idempotency key per project; it cannot recover the repo, the PR number
 * or the merge time from it, and the Bridge never sends those in clear.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LIMITS = {
  title: 120,
  summary: 1000,
  testItems: 20,
  testItemTitle: 120,
  steps: 10,
  step: 300,
  expected: 300,
  feedbackIds: 50,
  feedbackId: 64,
  bridgeVersion: 32,
  resolutionNote: 500,
} as const;

export const CHANGE_TYPES = ['feature', 'fix', 'enhancement', 'chore'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;

const EXTERNAL_REF = /^[0-9a-f]{16}$/;
const DAY_PRECISION_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FEEDBACK_ID = /^[A-Za-z0-9_-]+$/;

export const TestItemSchema = z
  .object({
    title: z.string().min(1).max(LIMITS.testItemTitle),
    steps: z.array(z.string().min(1).max(LIMITS.step)).min(1).max(LIMITS.steps),
    expected: z.string().min(1).max(LIMITS.expected),
    priority: z.enum(PRIORITIES),
  })
  .strict();

/** What the developer's model produces. The Bridge fills in the rest. */
export const DigestDraftSchema = z
  .object({
    change_type: z.enum(CHANGE_TYPES),
    title: z.string().min(1).max(LIMITS.title),
    summary: z.string().min(1).max(LIMITS.summary),
    test_items: z.array(TestItemSchema).max(LIMITS.testItems),
    addresses_feedback: z.array(z.string().min(1).max(LIMITS.feedbackId).regex(FEEDBACK_ID)).max(LIMITS.feedbackIds),
  })
  .strict();

export const DigestSchema = DigestDraftSchema.extend({
  external_ref: z.string().regex(EXTERNAL_REF),
  shipped_at: z.string().regex(DAY_PRECISION_DATE).nullable(),
  bridge_version: z.string().min(1).max(LIMITS.bridgeVersion),
}).strict();

export type TestItem = z.infer<typeof TestItemSchema>;
export type DigestDraft = z.infer<typeof DigestDraftSchema>;
export type Digest = z.infer<typeof DigestSchema>;

export const ResolutionMatchSchema = z
  .object({
    feedback_id: z.string().min(1).max(LIMITS.feedbackId).regex(FEEDBACK_ID),
    digest_external_ref: z.string().regex(EXTERNAL_REF),
    confidence: z.number().min(0).max(1),
    note: z.string().max(LIMITS.resolutionNote),
  })
  .strict();
export type ResolutionMatch = z.infer<typeof ResolutionMatchSchema>;

export type ParseResult<T> = { ok: true; digest: T } | { ok: false; issues: string[] };

const DIGEST_KEYS = Object.keys(DigestSchema.shape) as Array<keyof Digest>;
const TEST_ITEM_KEYS = Object.keys(TestItemSchema.shape) as Array<keyof TestItem>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in value) out[key] = value[key];
  return out;
}

/** Drop every key that is not in the closed schema (top level and test items). */
export function stripUnknownKeys(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const top = pick(value, DIGEST_KEYS);
  if (Array.isArray(top['test_items'])) {
    top['test_items'] = top['test_items'].map((item: unknown) => (isRecord(item) ? pick(item, TEST_ITEM_KEYS) : item));
  }
  return top;
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
}

/** Strip unknown keys, then validate strictly. The only way a Digest is built for sending. */
export function parseDigest(value: unknown): ParseResult<Digest> {
  const result = DigestSchema.safeParse(stripUnknownKeys(value));
  return result.success ? { ok: true, digest: result.data } : { ok: false, issues: formatIssues(result.error) };
}

export function parseDigestDraft(value: unknown): ParseResult<DigestDraft> {
  const stripped = stripUnknownKeys(value);
  const result = DigestDraftSchema.safeParse(stripped);
  return result.success ? { ok: true, digest: result.data } : { ok: false, issues: formatIssues(result.error) };
}

/** sha256(repo_full_name + '#' + pr_number + merged_at), first 16 hex chars. Opaque to the server. */
export function computeExternalRef(repoFullName: string, prNumber: number, mergedAt: string): string {
  return createHash('sha256').update(`${repoFullName}#${prNumber}${mergedAt}`).digest('hex').slice(0, 16);
}

export interface DraftContext {
  repoFullName: string;
  prNumber: number;
  mergedAt: string | null;
  bridgeVersion: string;
}

export function digestFromDraft(draft: DigestDraft, ctx: DraftContext): Digest {
  return {
    ...draft,
    external_ref: computeExternalRef(ctx.repoFullName, ctx.prNumber, ctx.mergedAt ?? ''),
    shipped_at: ctx.mergedAt ? ctx.mergedAt.slice(0, 10) : null,
    bridge_version: ctx.bridgeVersion,
  };
}

/**
 * JSON Schema handed to the model as the structured-output format. Structured
 * outputs reject length constraints, so those are enforced client-side by zod
 * above; every object is closed with additionalProperties:false.
 */
export const DIGEST_DRAFT_MODEL_SCHEMA = {
  type: 'object',
  properties: {
    change_type: { type: 'string', enum: [...CHANGE_TYPES] },
    title: { type: 'string', description: 'User-facing, at most 120 characters, no identifiers.' },
    summary: { type: 'string', description: 'What changed for the user, at most 1000 characters.' },
    test_items: {
      type: 'array',
      description: 'At most 20 items.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'string' },
          priority: { type: 'string', enum: [...PRIORITIES] },
        },
        required: ['title', 'steps', 'expected', 'priority'],
        additionalProperties: false,
      },
    },
    addresses_feedback: {
      type: 'array',
      description: 'Only ids copied verbatim from the open feedback list; empty if none apply.',
      items: { type: 'string' },
    },
  },
  required: ['change_type', 'title', 'summary', 'test_items', 'addresses_feedback'],
  additionalProperties: false,
} as const;

export const RESOLUTION_MATCH_MODEL_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feedback_id: { type: 'string' },
          digest_external_ref: { type: 'string' },
          confidence: { type: 'number', description: 'Between 0 and 1.' },
          note: { type: 'string', description: 'One plain-language sentence, at most 500 characters.' },
        },
        required: ['feedback_id', 'digest_external_ref', 'confidence', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
} as const;

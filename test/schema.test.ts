import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  DigestSchema,
  parseDigest,
  computeExternalRef,
  LIMITS,
  DIGEST_DRAFT_MODEL_SCHEMA,
  RESOLUTION_MATCH_MODEL_SCHEMA,
  DigestDraftSchema,
  ResolutionMatchSchema,
  digestFromDraft,
} from '../src/schema.js';
import { validDigest, minimalDigest } from './fixtures/digests.js';

describe('Digest schema (decisions.md §6)', () => {
  it('accepts a fully valid digest unchanged', () => {
    const result = parseDigest(validDigest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.digest).toEqual(validDigest);
  });

  it('accepts the minimal digest with null shipped_at and empty arrays', () => {
    const result = parseDigest(minimalDigest);
    expect(result.ok).toBe(true);
  });

  it('strips unknown top-level keys before the strict check (allow-list, not block-list)', () => {
    const polluted = { ...validDigest, pr_url: 'https://github.com/x/y/pull/1', diff: '+++ b/src/a.ts' };
    const result = parseDigest(polluted);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.digest).toEqual(validDigest);
      expect('pr_url' in result.digest).toBe(false);
      expect('diff' in result.digest).toBe(false);
    }
  });

  it('strips unknown keys inside test items', () => {
    const polluted = {
      ...validDigest,
      test_items: [{ ...validDigest.test_items[0], file: 'src/a.ts' }],
    };
    const result = parseDigest(polluted);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.digest.test_items[0]).not.toHaveProperty('file');
  });

  it('leaves non-object test items alone for the validator to reject', () => {
    expect(parseDigest({ ...validDigest, test_items: ['not an item'] }).ok).toBe(false);
  });

  it('the exported zod schema itself is strict (rejects unknown keys when used directly)', () => {
    const direct = DigestSchema.safeParse({ ...validDigest, extra: 1 });
    expect(direct.success).toBe(false);
  });

  it('rejects a title over 120 characters', () => {
    const result = parseDigest({ ...validDigest, title: 'x'.repeat(LIMITS.title + 1) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toMatch(/title/);
  });

  it('rejects a summary over 1000 characters', () => {
    const result = parseDigest({ ...validDigest, summary: 'x'.repeat(LIMITS.summary + 1) });
    expect(result.ok).toBe(false);
  });

  it('rejects more than 20 test items', () => {
    const items = Array.from({ length: LIMITS.testItems + 1 }, () => validDigest.test_items[0]);
    const result = parseDigest({ ...validDigest, test_items: items });
    expect(result.ok).toBe(false);
  });

  it('accepts exactly 20 test items', () => {
    const items = Array.from({ length: LIMITS.testItems }, () => validDigest.test_items[0]);
    expect(parseDigest({ ...validDigest, test_items: items }).ok).toBe(true);
  });

  it('rejects an unknown change_type', () => {
    expect(parseDigest({ ...validDigest, change_type: 'refactor' }).ok).toBe(false);
  });

  it('rejects an unknown priority', () => {
    const items = [{ ...validDigest.test_items[0], priority: 'urgent' }];
    expect(parseDigest({ ...validDigest, test_items: items }).ok).toBe(false);
  });

  it('rejects a test item with no steps or too many steps', () => {
    const none = [{ ...validDigest.test_items[0], steps: [] }];
    expect(parseDigest({ ...validDigest, test_items: none }).ok).toBe(false);
    const many = [{ ...validDigest.test_items[0], steps: Array(LIMITS.steps + 1).fill('step') }];
    expect(parseDigest({ ...validDigest, test_items: many }).ok).toBe(false);
  });

  it('rejects shipped_at that is not a day-precision ISO date', () => {
    expect(parseDigest({ ...validDigest, shipped_at: '2026-11-13T10:00:00Z' }).ok).toBe(false);
    expect(parseDigest({ ...validDigest, shipped_at: 'yesterday' }).ok).toBe(false);
  });

  it('rejects an external_ref that is not 16 lowercase hex characters', () => {
    expect(parseDigest({ ...validDigest, external_ref: 'abc' }).ok).toBe(false);
    expect(parseDigest({ ...validDigest, external_ref: 'ABCDEF0123456789' }).ok).toBe(false);
    expect(parseDigest({ ...validDigest, external_ref: 'https://github.com/x/y/pull/1' }).ok).toBe(false);
  });

  it('rejects addresses_feedback entries that are not plain ids', () => {
    expect(parseDigest({ ...validDigest, addresses_feedback: ['https://example.com/fb/1'] }).ok).toBe(false);
    expect(parseDigest({ ...validDigest, addresses_feedback: [''] }).ok).toBe(false);
  });

  it('rejects a non-object input', () => {
    expect(parseDigest('not a digest').ok).toBe(false);
    expect(parseDigest(null).ok).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { summary: _summary, ...noSummary } = validDigest;
    expect(parseDigest(noSummary).ok).toBe(false);
  });
});

describe('computeExternalRef', () => {
  it('is the first 16 hex chars of sha256(repo + "#" + pr_number + merged_at)', () => {
    const expected = createHash('sha256')
      .update('jre-coder/corvago#42' + '2026-11-13T09:30:00Z')
      .digest('hex')
      .slice(0, 16);
    expect(computeExternalRef('jre-coder/corvago', 42, '2026-11-13T09:30:00Z')).toBe(expected);
  });

  it('is deterministic', () => {
    const a = computeExternalRef('jre-coder/corvago', 42, '2026-11-13T09:30:00Z');
    const b = computeExternalRef('jre-coder/corvago', 42, '2026-11-13T09:30:00Z');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when any input changes', () => {
    const base = computeExternalRef('jre-coder/corvago', 42, '2026-11-13T09:30:00Z');
    expect(computeExternalRef('jre-coder/other', 42, '2026-11-13T09:30:00Z')).not.toBe(base);
    expect(computeExternalRef('jre-coder/corvago', 43, '2026-11-13T09:30:00Z')).not.toBe(base);
    expect(computeExternalRef('jre-coder/corvago', 42, '2026-11-13T09:30:01Z')).not.toBe(base);
  });

  it('does not contain the repo name or PR number in clear text', () => {
    const ref = computeExternalRef('jre-coder/corvago', 42, '2026-11-13T09:30:00Z');
    expect(ref).not.toContain('corvago');
    expect(ref).not.toContain('42');
  });
});

describe('digestFromDraft', () => {
  it('adds external_ref, shipped_at (day precision) and bridge_version to a model draft', () => {
    const draft = DigestDraftSchema.parse({
      change_type: 'feature',
      title: 'Receipts can be forwarded by email',
      summary: 'Forward a receipt to your personal address and it shows up in the app.',
      test_items: [],
      addresses_feedback: [],
    });
    const digest = digestFromDraft(draft, {
      repoFullName: 'jre-coder/corvago',
      prNumber: 7,
      mergedAt: '2026-11-13T09:30:00Z',
      bridgeVersion: '0.1.0',
    });
    expect(digest.external_ref).toBe(computeExternalRef('jre-coder/corvago', 7, '2026-11-13T09:30:00Z'));
    expect(digest.shipped_at).toBe('2026-11-13');
    expect(digest.bridge_version).toBe('0.1.0');
    expect(parseDigest(digest).ok).toBe(true);
  });

  it('uses null shipped_at when the merge date is absent', () => {
    const draft = DigestDraftSchema.parse({
      change_type: 'chore',
      title: 'Housekeeping',
      summary: 'No visible change.',
      test_items: [],
      addresses_feedback: [],
    });
    const digest = digestFromDraft(draft, {
      repoFullName: 'jre-coder/corvago',
      prNumber: 7,
      mergedAt: null,
      bridgeVersion: '0.1.0',
    });
    expect(digest.shipped_at).toBeNull();
  });
});

describe('model output schemas (what the LLM is asked to emit)', () => {
  it('draft schema has no string-length or array-length constraints (structured outputs reject them) and closes every object', () => {
    const json = JSON.stringify(DIGEST_DRAFT_MODEL_SCHEMA);
    expect(json).not.toMatch(/maxLength|minLength|maxItems|minItems/);
    const objects = json.match(/"type":"object"/g) ?? [];
    const closed = json.match(/"additionalProperties":false/g) ?? [];
    expect(closed.length).toBe(objects.length);
    expect(DIGEST_DRAFT_MODEL_SCHEMA.required).toEqual([
      'change_type',
      'title',
      'summary',
      'test_items',
      'addresses_feedback',
    ]);
  });

  it('resolution match schema closes every object and requires confidence', () => {
    const json = JSON.stringify(RESOLUTION_MATCH_MODEL_SCHEMA);
    expect(json).not.toMatch(/maxLength|minLength|maxItems|minItems|minimum|maximum/);
    const match = ResolutionMatchSchema.safeParse({
      feedback_id: 'fb_1',
      digest_external_ref: '0123456789abcdef',
      confidence: 0.9,
      note: 'Addressed by the faded-receipt fix.',
    });
    expect(match.success).toBe(true);
    expect(ResolutionMatchSchema.safeParse({ feedback_id: 'fb_1', digest_external_ref: 'x', confidence: 2, note: '' }).success).toBe(false);
  });
});

describe('schema/digest.schema.json agrees with the zod schema', () => {
  it('exists and is strict about additional properties', () => {
    const raw = JSON.parse(readFileSync(new URL('../schema/digest.schema.json', import.meta.url), 'utf8'));
    expect(raw.additionalProperties).toBe(false);
    expect(raw.properties.test_items.maxItems).toBe(LIMITS.testItems);
    expect(raw.properties.title.maxLength).toBe(LIMITS.title);
    expect(raw.properties.summary.maxLength).toBe(LIMITS.summary);
  });
});

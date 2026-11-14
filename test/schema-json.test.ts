import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import * as addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS; under NodeNext the callable plugin sits on `.default`.
const addFormats = (addFormatsModule as unknown as { default: (ajv: Ajv) => Ajv }).default;
import { parseDigest, LIMITS } from '../src/schema.js';
import { validDigest, minimalDigest } from './fixtures/digests.js';

const schema = JSON.parse(readFileSync(new URL('../schema/digest.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validateJson = ajv.compile(schema);

/** Both validators must agree on every fixture: accept the same, reject the same. */
const fixtures: Array<{ name: string; value: unknown; expectValid: boolean }> = [
  { name: 'valid digest', value: validDigest, expectValid: true },
  { name: 'minimal digest', value: minimalDigest, expectValid: true },
  { name: 'title too long', value: { ...validDigest, title: 'x'.repeat(LIMITS.title + 1) }, expectValid: false },
  { name: 'summary too long', value: { ...validDigest, summary: 'x'.repeat(LIMITS.summary + 1) }, expectValid: false },
  {
    name: 'too many test items',
    value: { ...validDigest, test_items: Array(LIMITS.testItems + 1).fill(validDigest.test_items[0]) },
    expectValid: false,
  },
  { name: 'bad change_type', value: { ...validDigest, change_type: 'refactor' }, expectValid: false },
  { name: 'bad priority', value: { ...validDigest, test_items: [{ ...validDigest.test_items[0], priority: 'urgent' }] }, expectValid: false },
  { name: 'bad external_ref', value: { ...validDigest, external_ref: 'nope' }, expectValid: false },
  { name: 'timestamp shipped_at', value: { ...validDigest, shipped_at: '2026-11-13T00:00:00Z' }, expectValid: false },
  { name: 'empty steps', value: { ...validDigest, test_items: [{ ...validDigest.test_items[0], steps: [] }] }, expectValid: false },
  { name: 'missing summary', value: (() => { const { summary: _s, ...rest } = validDigest; return rest; })(), expectValid: false },
  { name: 'feedback id with slash', value: { ...validDigest, addresses_feedback: ['a/b'] }, expectValid: false },
];

describe('JSON Schema and zod agree on the fixture set', () => {
  for (const f of fixtures) {
    it(`${f.name}: ${f.expectValid ? 'accepted' : 'rejected'} by both`, () => {
      const zodOk = parseDigest(f.value).ok;
      const jsonOk = validateJson(f.value) as boolean;
      expect(zodOk).toBe(f.expectValid);
      expect(jsonOk).toBe(f.expectValid);
    });
  }

  it('JSON Schema rejects unknown keys (zod strips them first, so this is the server-facing contract)', () => {
    expect(validateJson({ ...validDigest, extra: 1 })).toBe(false);
  });
});

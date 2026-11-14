import { describe, it, expect } from 'vitest';
import {
  DIGEST_SYSTEM_PROMPT,
  RESOLUTION_SYSTEM_PROMPT,
  buildDigestUserMessage,
  buildResolutionUserMessage,
} from '../src/prompt.js';
import type { DigestInput, FeedbackItem } from '../src/providers/types.js';
import { validDigest } from './fixtures/digests.js';

const input: DigestInput = {
  repoFullName: 'jre-coder/corvago',
  prNumber: 12,
  title: 'Handle faded thermal receipts',
  body: 'Closes the faded-receipt bug.\n\nTested on a 2-week-old receipt.',
  labels: ['bug', 'scanner'],
  mergedAt: '2026-11-13T09:30:00Z',
  files: [{ filename: 'src/services/receiptService.ts', status: 'modified', additions: 10, deletions: 2 }],
  diff: '--- src/services/receiptService.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;',
  openFeedback: [{ id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: '2026-11-01T00:00:00Z' }],
};

describe('DIGEST_SYSTEM_PROMPT', () => {
  it('instructs user-facing functional language only', () => {
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/user-facing|what changed for the user/i);
  });
  it('forbids identifiers, file names, code, URLs and secrets', () => {
    for (const word of ['identifier', 'file name', 'code', 'URL', 'secret']) {
      expect(DIGEST_SYSTEM_PROMPT.toLowerCase()).toContain(word.toLowerCase());
    }
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/never|do not|must not/i);
  });
  it('asks for test items with steps and expected outcome, at most 20', () => {
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/steps/i);
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/expected/i);
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/20/);
  });
  it('demands strict JSON and nothing else', () => {
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/JSON/);
    expect(DIGEST_SYSTEM_PROMPT).toMatch(/only|nothing else|no prose/i);
  });
  it('is a byte-stable constant with no per-request interpolation', () => {
    expect(DIGEST_SYSTEM_PROMPT).not.toContain('${');
    expect(DIGEST_SYSTEM_PROMPT).not.toMatch(/jre-coder|corvago/);
  });
  it('names the change types and priorities the schema allows', () => {
    for (const w of ['feature', 'fix', 'enhancement', 'chore', 'high', 'medium', 'low']) {
      expect(DIGEST_SYSTEM_PROMPT).toContain(w);
    }
  });
});

describe('buildDigestUserMessage', () => {
  it('carries the PR facts the model needs (these stay on the developer side)', () => {
    const msg = buildDigestUserMessage(input);
    expect(msg).toContain('Handle faded thermal receipts');
    expect(msg).toContain('Closes the faded-receipt bug.');
    expect(msg).toContain('bug, scanner');
    expect(msg).toContain('src/services/receiptService.ts');
    expect(msg).toContain('+const a = 2;');
  });
  it('lists open feedback by id so the model can reference ids verbatim', () => {
    const msg = buildDigestUserMessage(input);
    expect(msg).toContain('fb_1');
    expect(msg).toContain('Old receipts never scan');
  });
  it('says so when there is no open feedback or no body', () => {
    const msg = buildDigestUserMessage({ ...input, openFeedback: [], body: '', labels: [] });
    expect(msg).toMatch(/no open feedback/i);
    expect(msg).toMatch(/\(none\)/);
  });
  it('says "unknown" when the merge date is missing', () => {
    expect(buildDigestUserMessage({ ...input, mergedAt: null })).toMatch(/Merged at\nunknown/);
  });
  it('does not include the token or any secret-shaped value', () => {
    expect(buildDigestUserMessage(input)).not.toMatch(/ghp_|Bearer/);
  });
});

describe('resolution prompt', () => {
  const feedback: FeedbackItem[] = [
    { id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: '2026-11-01T00:00:00Z' },
  ];
  it('system prompt asks for matches with confidence and plain-language notes, JSON only', () => {
    expect(RESOLUTION_SYSTEM_PROMPT).toMatch(/confidence/i);
    expect(RESOLUTION_SYSTEM_PROMPT).toMatch(/JSON/);
    expect(RESOLUTION_SYSTEM_PROMPT).toMatch(/identifier|file name|code/i);
    expect(RESOLUTION_SYSTEM_PROMPT).not.toContain('${');
  });
  it('user message lists feedback and digests by id / external_ref only', () => {
    const msg = buildResolutionUserMessage(feedback, [validDigest]);
    expect(msg).toContain('fb_1');
    expect(msg).toContain(validDigest.external_ref);
    expect(msg).toContain(validDigest.title);
    expect(msg).toContain(validDigest.summary);
  });
});

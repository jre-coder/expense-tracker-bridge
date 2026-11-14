import { describe, it, expect } from 'vitest';
import { scanText, scanDigest, PATTERN_CLASSES } from '../src/redaction.js';
import { validDigest } from './fixtures/digests.js';

const opts = { allowedHosts: ['api.expensetracker.example'] };

function classes(text: string): string[] {
  return scanText(text, opts).findings.map((f) => f.class);
}

describe('redaction gate — secret patterns', () => {
  it('AWS access key id', () => {
    expect(classes('key AKIAIOSFODNN7EXAMPLE used')).toContain('secret:aws');
  });
  it('GitHub classic token ghp_', () => {
    expect(classes('token ghp_' + 'a'.repeat(36))).toContain('secret:github');
  });
  it('GitHub OAuth token gho_', () => {
    expect(classes('gho_' + 'b'.repeat(36))).toContain('secret:github');
  });
  it('GitHub fine-grained token github_pat_', () => {
    expect(classes('github_pat_' + 'c'.repeat(22) + '_' + 'd'.repeat(59))).toContain('secret:github');
  });
  it('Stripe secret and publishable keys', () => {
    expect(classes('sk_live_' + 'e'.repeat(24))).toContain('secret:stripe');
    expect(classes('pk_test_' + 'f'.repeat(24))).toContain('secret:stripe');
  });
  it('Supabase / JWT (eyJ...)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(classes(`uses ${jwt} to sign in`)).toContain('secret:jwt');
  });
  it('private key blocks', () => {
    expect(classes('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----')).toContain('secret:private_key');
    expect(classes('-----BEGIN PRIVATE KEY-----')).toContain('secret:private_key');
  });
  it('Slack tokens and webhooks', () => {
    expect(classes('xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx')).toContain('secret:slack');
    expect(classes('https://hooks.slack.com/services/T000/B000/XXXX')).toContain('secret:slack');
  });
  it('generic long hex token (32+)', () => {
    expect(classes('id ' + 'a1b2c3d4'.repeat(4))).toContain('secret:generic_token');
  });
  it('generic long base64 token (32+)', () => {
    expect(classes('token QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw+/=')).toContain('secret:generic_token');
  });
});

describe('redaction gate — code and structure', () => {
  it('file paths with directories', () => {
    expect(classes('see src/services/receiptService.ts for details')).toContain('path');
  });
  it('bare file names with code extensions', () => {
    expect(classes('edited App.tsx and index.js')).toContain('path');
    expect(classes('the migration 20261001_add_assets.sql ran')).toContain('path');
  });
  it('code fences', () => {
    expect(classes('Example:\n```ts\nconst x = 1;\n```')).toContain('code_fence');
  });
  it('inline backticks', () => {
    expect(classes('call `parseReceipt` first')).toContain('inline_code');
  });
  it('identifier density above threshold (camelCase, snake_case, dotted)', () => {
    const dense = 'Updated receiptService.parseTotals and extract_tax plus useReceiptStore and config.cache.ttl then handleScanResult.';
    expect(classes(dense)).toContain('identifier_density');
  });
  it('identifier density below threshold in a long functional paragraph passes', () => {
    const text =
      'Scanning a receipt that has faded over a couple of weeks now extracts the merchant, date and total instead of asking you to type them in. ' +
      'Try it with an old receipt from your wallet. The app should fill in every field. If a field is missing, note which one. ' +
      'This also works for receipts photographed under warm restaurant lighting.';
    expect(scanText(text, opts).ok).toBe(true);
  });
  it('URLs other than the configured API host', () => {
    expect(classes('docs at https://github.com/jre-coder/corvago/pull/12')).toContain('url');
    expect(classes('see http://internal.example:8080/status')).toContain('url');
  });
  it('a URL-shaped string that does not parse is still flagged', () => {
    expect(classes('see http://%zz for details')).toContain('url');
  });
  it('URLs on the configured API host pass', () => {
    expect(classes('https://api.expensetracker.example/bridge-digests')).not.toContain('url');
  });
  it('email addresses', () => {
    expect(classes('contact jen@noreviagroup.com')).toContain('email');
  });
});

describe('redaction gate — behaviour', () => {
  it('a clean functional paragraph passes with no findings', () => {
    const text =
      'Receipt scanning now handles faded thermal paper. Test it by scanning a two-week-old receipt; the merchant, date and total should be filled in without prompting.';
    const result = scanText(text, opts);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('a paragraph containing src/services/receiptService.ts is held', () => {
    const result = scanText('Changed src/services/receiptService.ts to parse totals better.', opts);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.class === 'path')).toBe(true);
  });

  it('masks the offending substring (never echoes the full secret)', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const result = scanText(`token ${token}`, opts);
    const finding = result.findings.find((f) => f.class === 'secret:github');
    expect(finding).toBeDefined();
    expect(finding?.masked).not.toContain(token);
    expect(finding?.masked).toMatch(/^ghp_a[*…]+a*$|^ghp_a.*\*.*$/);
    expect(finding?.masked.length).toBeLessThanOrEqual(token.length);
  });

  it('masks short matches entirely', () => {
    const result = scanText('edited App.tsx', opts);
    const finding = result.findings.find((f) => f.class === 'path');
    expect(finding?.masked).toMatch(/\*/);
  });

  it('reports every pattern class exactly once per distinct match', () => {
    const result = scanText('a@b.co and a@b.co', opts);
    expect(result.findings.filter((f) => f.class === 'email')).toHaveLength(1);
  });

  it('exposes the pattern classes so docs and tests can enumerate them', () => {
    expect(PATTERN_CLASSES).toEqual(
      expect.arrayContaining([
        'secret:aws',
        'secret:github',
        'secret:stripe',
        'secret:jwt',
        'secret:private_key',
        'secret:slack',
        'secret:generic_token',
        'path',
        'code_fence',
        'inline_code',
        'identifier_density',
        'url',
        'email',
      ]),
    );
  });
});

describe('scanDigest', () => {
  it('passes a clean digest', () => {
    expect(scanDigest(validDigest, opts).ok).toBe(true);
  });

  it('scans every string field including nested test items and reports the field path', () => {
    const dirty = {
      ...validDigest,
      test_items: [
        {
          ...validDigest.test_items[0]!,
          steps: ['Open src/screens/ScanScreen.tsx', 'Tap scan'],
        },
      ],
    };
    const result = scanDigest(dirty, opts);
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.field).toBe('test_items[0].steps[0]');
  });

  it('flags a secret hidden in the summary', () => {
    const dirty = { ...validDigest, summary: 'Rotated to sk_live_' + 'x'.repeat(24) + ' for payments.' };
    const result = scanDigest(dirty, opts);
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.class)).toContain('secret:stripe');
  });

  it('does not scan the external_ref (it is a hash and would trip the hex rule) nor bridge_version', () => {
    const result = scanDigest({ ...validDigest, external_ref: 'abcdef0123456789' }, opts);
    expect(result.ok).toBe(true);
  });
});

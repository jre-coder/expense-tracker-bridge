import type { Digest } from '../../src/schema.js';

/** A fully valid digest: functional language only, nothing that looks like code. */
export const validDigest: Digest = {
  external_ref: '0123456789abcdef',
  change_type: 'fix',
  title: 'Receipt scanning now reads faded thermal paper',
  summary:
    'Scanning a receipt that has faded over a couple of weeks now extracts the merchant, date and total instead of asking you to type them in.',
  test_items: [
    {
      title: 'Scan a faded receipt',
      steps: ['Find a receipt that is at least two weeks old', 'Open the scanner and photograph it'],
      expected: 'Merchant, date and total are filled in without prompting',
      priority: 'high',
    },
  ],
  addresses_feedback: ['fb_01HZX3Y6K8Q9R2T4V7W8X9Y0Z1'],
  shipped_at: '2026-11-13',
  bridge_version: '0.1.0',
};

export const minimalDigest: Digest = {
  external_ref: 'fedcba9876543210',
  change_type: 'chore',
  title: 'Routine maintenance',
  summary: 'Internal housekeeping with no visible change.',
  test_items: [],
  addresses_feedback: [],
  shipped_at: null,
  bridge_version: '0.1.0',
};

export const fixtureDigests: Digest[] = [validDigest, minimalDigest];

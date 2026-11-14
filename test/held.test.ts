import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueStore } from '../src/held.js';
import { validDigest, minimalDigest } from './fixtures/digests.js';

function store(): QueueStore {
  const dir = mkdtempSync(join(tmpdir(), 'held-'));
  return new QueueStore(join(dir, 'queue.json'));
}

describe('QueueStore', () => {
  it('starts empty when the file does not exist', () => {
    expect(store().list()).toEqual([]);
  });

  it('adds a ready digest and a held digest with findings', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'ready', findings: [], source: 'jre-coder/corvago#1' });
    s.add({
      digest: minimalDigest,
      status: 'held',
      findings: [{ class: 'path', field: 'summary', masked: 'src/***' }],
      source: 'jre-coder/corvago#2',
    });
    expect(s.list('ready')).toHaveLength(1);
    expect(s.list('held')).toHaveLength(1);
    expect(s.list()).toHaveLength(2);
  });

  it('persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'held-'));
    const file = join(dir, 'queue.json');
    new QueueStore(file).add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    expect(new QueueStore(file).list()).toHaveLength(1);
  });

  it('is idempotent on external_ref (re-scanning the same PR replaces, never duplicates)', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    s.add({ digest: { ...validDigest, title: 'Second pass' }, status: 'ready', findings: [], source: 's' });
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]?.digest.title).toBe('Second pass');
  });

  it('does not overwrite a sent item on re-scan', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    s.markSent([validDigest.external_ref], '2026-11-14T00:00:00Z');
    s.add({ digest: { ...validDigest, title: 'Again' }, status: 'ready', findings: [], source: 's' });
    expect(s.list('sent')).toHaveLength(1);
    expect(s.list()[0]?.digest.title).toBe(validDigest.title);
  });

  it('approve moves a held item to approved and records the override', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'held', findings: [{ class: 'path', field: 'summary', masked: '***' }], source: 's' });
    expect(s.approve(validDigest.external_ref, '2026-11-14T00:00:00Z')).toBe(true);
    const item = s.get(validDigest.external_ref);
    expect(item?.status).toBe('approved');
    expect(item?.approved_at).toBe('2026-11-14T00:00:00Z');
  });

  it('reject moves a held item to rejected', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'held', findings: [], source: 's' });
    expect(s.reject(validDigest.external_ref)).toBe(true);
    expect(s.get(validDigest.external_ref)?.status).toBe('rejected');
  });

  it('approve/reject return false for unknown ids or items that are not held', () => {
    const s = store();
    expect(s.approve('nope', 'now')).toBe(false);
    expect(s.reject('nope')).toBe(false);
    s.add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    expect(s.approve(validDigest.external_ref, 'now')).toBe(false);
    expect(s.reject(validDigest.external_ref)).toBe(false);
  });

  it('sendable() returns ready and approved items only', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    s.add({ digest: minimalDigest, status: 'held', findings: [], source: 's' });
    expect(s.sendable().map((i) => i.digest.external_ref)).toEqual([validDigest.external_ref]);
    s.approve(minimalDigest.external_ref, 'now');
    expect(s.sendable()).toHaveLength(2);
  });

  it('markSent records sent_at and ignores unknown refs', () => {
    const s = store();
    s.add({ digest: validDigest, status: 'ready', findings: [], source: 's' });
    s.markSent([validDigest.external_ref, 'unknown'], '2026-11-14T00:00:00Z');
    expect(s.get(validDigest.external_ref)?.status).toBe('sent');
    expect(s.get(validDigest.external_ref)?.sent_at).toBe('2026-11-14T00:00:00Z');
  });

  it('throws a readable error on a corrupt queue file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'held-'));
    const file = join(dir, 'queue.json');
    writeFileSync(file, '[]');
    expect(() => new QueueStore(file).list()).toThrow(/queue/i);
    writeFileSync(file, '{nope');
    expect(() => new QueueStore(file).list()).toThrow(/not valid JSON/);
  });
});

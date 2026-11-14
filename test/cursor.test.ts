import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCursor, writeCursor } from '../src/cursor.js';

describe('cursor', () => {
  it('returns null when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    expect(readCursor(join(dir, 'missing.json'))).toBeNull();
  });

  it('round-trips the last merged_at timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    const file = join(dir, 'nested', 'cursor.json');
    writeCursor(file, { last_merged_at: '2026-11-13T09:30:00Z', updated_at: '2026-11-14T00:00:00Z' });
    expect(readCursor(file)).toEqual({ last_merged_at: '2026-11-13T09:30:00Z', updated_at: '2026-11-14T00:00:00Z' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('last_merged_at');
  });

  it('throws a readable error on a corrupt cursor file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    const file = join(dir, 'cursor.json');
    writeFileSync(file, '{not json');
    expect(() => readCursor(file)).toThrow(/cursor/i);
  });

  it('rejects a cursor file with the wrong shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
    const file = join(dir, 'cursor.json');
    writeFileSync(file, JSON.stringify({ last_merged_at: 12 }));
    expect(() => readCursor(file)).toThrow(/cursor/i);
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const CursorSchema = z
  .object({
    /** merged_at of the newest pull request already digested. */
    last_merged_at: z.string(),
    updated_at: z.string(),
  })
  .strict();

export type Cursor = z.infer<typeof CursorSchema>;

export function readCursor(path: string): Cursor | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cursor file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Cursor file ${path} has an unexpected shape; delete it to start over.`);
  return parsed.data;
}

export function writeCursor(path: string, cursor: Cursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor, null, 2) + '\n');
}

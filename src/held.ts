/**
 * Local queue of digests awaiting send or review. Lives in the developer's
 * repo (git-ignored) and never leaves the machine; `send` reads `ready` and
 * `approved` items only. A `held` item is one the redaction gate flagged; it
 * is sent only after an explicit `review --approve`, which is recorded.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DigestSchema, type Digest } from './schema.js';
import type { Finding } from './redaction.js';

export const ITEM_STATUSES = ['ready', 'held', 'approved', 'rejected', 'sent'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const FindingSchema = z.object({ class: z.string(), field: z.string(), masked: z.string() }).strict();

const QueueItemSchema = z
  .object({
    digest: DigestSchema,
    status: z.enum(ITEM_STATUSES),
    findings: z.array(FindingSchema),
    /** Local-only label (e.g. "owner/repo#12") shown in `review`; never sent. */
    source: z.string(),
    created_at: z.string(),
    approved_at: z.string().optional(),
    sent_at: z.string().optional(),
  })
  .strict();

const QueueFileSchema = z.object({ items: z.array(QueueItemSchema) }).strict();

export type QueueItem = z.infer<typeof QueueItemSchema>;
export interface NewQueueItem {
  digest: Digest;
  status: 'ready' | 'held';
  findings: Finding[];
  source: string;
}

export class QueueStore {
  private items: QueueItem[] | null = null;

  constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private load(): QueueItem[] {
    if (this.items) return this.items;
    if (!existsSync(this.path)) {
      this.items = [];
      return this.items;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new Error(`Queue file ${this.path} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = QueueFileSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Queue file ${this.path} has an unexpected shape.`);
    this.items = parsed.data.items;
    return this.items;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ items: this.load() }, null, 2) + '\n');
  }

  list(status?: ItemStatus): QueueItem[] {
    const items = this.load();
    return status ? items.filter((i) => i.status === status) : [...items];
  }

  get(externalRef: string): QueueItem | undefined {
    return this.load().find((i) => i.digest.external_ref === externalRef);
  }

  /** Idempotent on external_ref; a sent item is never replaced by a re-scan. */
  add(item: NewQueueItem): void {
    const items = this.load();
    const index = items.findIndex((i) => i.digest.external_ref === item.digest.external_ref);
    const existing = index >= 0 ? items[index] : undefined;
    if (existing?.status === 'sent') return;
    const next: QueueItem = { ...item, created_at: this.now() };
    if (index >= 0) items[index] = next;
    else items.push(next);
    this.save();
  }

  sendable(): QueueItem[] {
    return this.load().filter((i) => i.status === 'ready' || i.status === 'approved');
  }

  approve(externalRef: string, at: string): boolean {
    const item = this.get(externalRef);
    if (!item || item.status !== 'held') return false;
    item.status = 'approved';
    item.approved_at = at;
    this.save();
    return true;
  }

  reject(externalRef: string): boolean {
    const item = this.get(externalRef);
    if (!item || item.status !== 'held') return false;
    item.status = 'rejected';
    this.save();
    return true;
  }

  markSent(externalRefs: string[], at: string): void {
    for (const ref of externalRefs) {
      const item = this.get(ref);
      if (!item) continue;
      item.status = 'sent';
      item.sent_at = at;
    }
    this.save();
  }
}

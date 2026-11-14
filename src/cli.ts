/**
 * Command-line entry. Every command supports --dry-run, which prints the exact
 * outbound payload (credentials masked) and sends nothing, writes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { CONFIG_FILENAME, PROVIDERS, defaultConfig, loadConfig, resolveSecrets, writeConfig, type Config, type ProviderName } from './config.js';
import { readCursor, writeCursor } from './cursor.js';
import { listMergedPullRequests } from './github.js';
import { QueueStore, type ItemStatus, type QueueItem } from './held.js';
import { MAX_DIGESTS_PER_REQUEST, buildDigestsRequest, buildFeedbackRequest, buildResolutionRequest, describeRequest, fetchAllFeedback, sendRequest } from './outbound.js';
import { createProvider } from './providers/index.js';
import type { DescribedRequest, DigestInput, FeedbackItem, FetchLike, Provider } from './providers/types.js';
import { scanDigest, scanText, type ScanOptions } from './redaction.js';
import { digestFromDraft, type Digest } from './schema.js';
import { BRIDGE_VERSION } from './version.js';

export interface CliDeps {
  fetch: FetchLike;
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export const USAGE = `Usage: expense-bridge <command> [options]

Commands:
  init            Write ${CONFIG_FILENAME} (env var NAMES only; never secrets)
                  --repo owner/name --api-base-url URL --project-ref REF
                  [--provider anthropic|openai|ollama] [--model ID] [--force]
  scan            Read merged pull requests since the cursor, ask YOUR model for
                  functional digests, run the redaction gate, queue the results
                  [--since ISO] [--limit N]
  review          Show held digests with their findings
                  [--approve REF] [--reject REF] [--json]
  send            POST ready + approved digests to the Expense Tracker API
  sync-feedback   GET open feedback into the local cache
  resolve         Ask YOUR model which feedback the digests address; POST resolutions
                  [--min-confidence 0..1]

Global options:
  --config PATH   Config file (default ./${CONFIG_FILENAME})
  --dry-run       Print the exact outbound payload (credentials masked); send and write nothing
  --help, --version`;

const BOOLEAN_FLAGS = new Set(['dry-run', 'force', 'json', 'help', 'version']);
const VALUE_FLAGS = new Set(['config', 'repo', 'provider', 'model', 'api-base-url', 'project-ref', 'since', 'limit', 'approve', 'reject', 'min-confidence']);

interface Parsed {
  command: string | undefined;
  flags: Record<string, string | true>;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | true> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      if (command === undefined) command = arg;
      else throw new UsageError(`Unexpected argument "${arg}"`);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  return { command, flags };
}

interface Ctx {
  deps: CliDeps;
  flags: Record<string, string | true>;
  dryRun: boolean;
  now: () => Date;
  configPath: string;
}

function resolvePath(ctx: Ctx, p: string): string {
  return resolve(ctx.deps.cwd, p);
}

function scanOptions(config: Config): ScanOptions {
  return { allowedHosts: [new URL(config.api_base_url).hostname], identifierDensityThreshold: config.identifier_density_threshold };
}

function formatDescribed(req: DescribedRequest): string {
  const lines = [`${req.method} ${req.url}`];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
  lines.push('', JSON.stringify(JSON.parse(req.body), null, 2));
  return lines.join('\n');
}

const FeedbackCacheSchema = z.object({
  fetched_at: z.string(),
  feedback: z.array(z.object({ id: z.string(), text: z.string(), severity: z.string(), status: z.string(), created_at: z.string() })),
});

function readFeedbackCache(ctx: Ctx, config: Config): FeedbackItem[] | null {
  const path = resolvePath(ctx, config.feedback_file);
  if (!existsSync(path)) return null;
  try {
    return FeedbackCacheSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).feedback;
  } catch {
    ctx.deps.stderr(`warning: ignoring unreadable feedback cache at ${config.feedback_file}; run \`expense-bridge sync-feedback\` to refresh it.`);
    return null;
  }
}

function writeFeedbackCache(ctx: Ctx, config: Config, feedback: FeedbackItem[]): void {
  const path = resolvePath(ctx, config.feedback_file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ fetched_at: ctx.now().toISOString(), feedback }, null, 2) + '\n');
}

function makeProvider(ctx: Ctx, config: Config, providerKey: string | null): Provider {
  return createProvider({
    provider: config.provider,
    model: config.model,
    // In --dry-run the key may be absent; headers are masked before display anyway.
    providerKey: providerKey ?? (ctx.dryRun ? 'DRY_RUN_PLACEHOLDER' : null),
    baseUrl: config.provider_base_url,
    fetch: ctx.deps.fetch,
  });
}

// ---------------------------------------------------------------- commands

function cmdInit(ctx: Ctx): number {
  const { flags, deps } = ctx;
  const required = ['repo', 'api-base-url', 'project-ref'] as const;
  const missing = required.filter((f) => typeof flags[f] !== 'string');
  if (missing.length > 0) throw new Error(`init needs ${missing.map((m) => `--${m}`).join(', ')}`);
  const provider = (flags['provider'] as string | undefined) ?? 'anthropic';
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown provider "${provider}"; use one of ${PROVIDERS.join(', ')}`);
  if (existsSync(ctx.configPath) && flags['force'] !== true) throw new Error(`${ctx.configPath} exists; pass --force to overwrite it.`);
  const opts = {
    repo: flags['repo'] as string,
    provider: provider as ProviderName,
    api_base_url: flags['api-base-url'] as string,
    project_ref: flags['project-ref'] as string,
    ...(typeof flags['model'] === 'string' ? { model: flags['model'] } : {}),
  };
  const config = defaultConfig(opts);
  writeConfig(ctx.configPath, config);
  deps.stdout(`Wrote ${ctx.configPath}`);
  deps.stdout('');
  deps.stdout('Next, export the secrets as environment variables (they are never written to disk by the Bridge):');
  deps.stdout(`  ${config.github_token_env}   a GitHub token that can read pull requests of ${config.repo}`);
  deps.stdout(`  ${config.bridge_key_env}   the per-project bridge key from Expense Tracker`);
  if (config.provider_key_env) deps.stdout(`  ${config.provider_key_env}   your ${config.provider} API key`);
  deps.stdout('');
  deps.stdout('Then: expense-bridge scan --dry-run   (shows what would be asked of your model, sends nothing)');
  return 0;
}

async function cmdScan(ctx: Ctx): Promise<number> {
  const { deps, flags } = ctx;
  const config = loadConfig(ctx.configPath);
  const secrets = resolveSecrets(config, deps.env, { need: ctx.dryRun ? ['github'] : ['github', 'provider'] });
  const cursorPath = resolvePath(ctx, config.cursor_file);
  const cursor = readCursor(cursorPath);
  let since: string | null;
  if (typeof flags['since'] === 'string') {
    since = flags['since'];
  } else if (cursor) {
    since = cursor.last_merged_at;
  } else {
    since = new Date(ctx.now().getTime() - 30 * 24 * 3600 * 1000).toISOString();
    deps.stdout(`No cursor yet; scanning pull requests merged in the last 30 days (since ${since}). Pass --since to change.`);
  }
  const limit = typeof flags['limit'] === 'string' ? Number.parseInt(flags['limit'], 10) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');

  let prs = await listMergedPullRequests({ repo: config.repo, token: secrets.githubToken as string, since, fetch: deps.fetch, maxDiffChars: config.max_diff_chars });
  if (prs.length === 0) {
    deps.stdout(`No merged pull requests since ${since}.`);
    return 0;
  }
  if (prs.length > limit) {
    deps.stdout(`Found ${prs.length} merged pull requests; processing the oldest ${limit} (limit).`);
    prs = prs.slice(0, limit);
  }
  const openFeedback = readFeedbackCache(ctx, config) ?? [];
  const provider = makeProvider(ctx, config, secrets.providerKey);
  const queue = new QueueStore(resolvePath(ctx, config.queue_file), () => ctx.now().toISOString());
  const gate = scanOptions(config);

  let ready = 0;
  let held = 0;
  let lastSuccess: string | null = null;
  for (const pr of prs) {
    const input: DigestInput = {
      repoFullName: config.repo,
      prNumber: pr.number,
      title: pr.title,
      body: pr.body,
      labels: pr.labels,
      mergedAt: pr.mergedAt,
      files: pr.files,
      diff: pr.diff,
      openFeedback,
    };
    if (ctx.dryRun) {
      deps.stdout(`[dry-run] would ask ${provider.name} (${config.model}) about ${config.repo}#${pr.number}:`);
      deps.stdout(formatDescribed(provider.describeDigestRequest(input)));
      deps.stdout('');
      continue;
    }
    try {
      const draft = await provider.generateDigest(input);
      // digestFromDraft only adds Bridge-computed fields to an already-validated draft;
      // outbound.ts re-validates the closed schema immediately before any send.
      const digest = digestFromDraft(draft, { repoFullName: config.repo, prNumber: pr.number, mergedAt: pr.mergedAt, bridgeVersion: BRIDGE_VERSION });
      const scan = scanDigest(digest, gate);
      queue.add({ digest, status: scan.ok ? 'ready' : 'held', findings: scan.findings, source: `${config.repo}#${pr.number}` });
      if (scan.ok) {
        ready++;
        deps.stdout(`  ready  ${digest.external_ref}  #${pr.number}  ${digest.title}`);
      } else {
        held++;
        deps.stdout(`  HELD   ${digest.external_ref}  #${pr.number}  ${scan.findings.map((f) => f.class).join(', ')}`);
      }
      lastSuccess = pr.mergedAt;
    } catch (error) {
      deps.stderr(`error: ${config.repo}#${pr.number}: ${(error as Error).message}`);
      deps.stderr('Stopping here so the cursor does not skip this pull request. Fix the cause and run scan again.');
      if (lastSuccess) writeCursor(cursorPath, { last_merged_at: lastSuccess, updated_at: ctx.now().toISOString() });
      return 1;
    }
  }
  if (ctx.dryRun) {
    deps.stdout(`[dry-run] ${prs.length} pull request(s) would be digested. Nothing was sent or written.`);
    return 0;
  }
  writeCursor(cursorPath, { last_merged_at: lastSuccess as string, updated_at: ctx.now().toISOString() });
  deps.stdout(`Scanned ${prs.length} pull request(s): ${ready} ready, ${held} held.`);
  if (held > 0) deps.stdout('Run `expense-bridge review` to see why items were held; nothing held is ever sent without your approval.');
  if (ready > 0) deps.stdout('Run `expense-bridge send --dry-run` to see the exact payload, then `expense-bridge send`.');
  return 0;
}

function printItem(ctx: Ctx, item: QueueItem): void {
  const { stdout } = ctx.deps;
  stdout(`${item.digest.external_ref}  ${item.source}  (${item.status})`);
  for (const f of item.findings) stdout(`    ${f.class.padEnd(20)} ${f.field.padEnd(26)} ${f.masked}`);
  stdout('    digest as it would be sent:');
  for (const line of JSON.stringify(item.digest, null, 2).split('\n')) stdout(`    ${line}`);
  stdout('');
}

function cmdReview(ctx: Ctx): number {
  const { deps, flags } = ctx;
  const config = loadConfig(ctx.configPath);
  const queue = new QueueStore(resolvePath(ctx, config.queue_file), () => ctx.now().toISOString());
  if (typeof flags['approve'] === 'string') {
    if (!queue.approve(flags['approve'], ctx.now().toISOString())) throw new Error(`${flags['approve']} is not held (unknown ref, or already approved/rejected/sent).`);
    deps.stdout(`Approved ${flags['approve']}; it will be included in the next \`expense-bridge send\`.`);
    return 0;
  }
  if (typeof flags['reject'] === 'string') {
    if (!queue.reject(flags['reject'])) throw new Error(`${flags['reject']} is not held (unknown ref, or already approved/rejected/sent).`);
    deps.stdout(`Rejected ${flags['reject']}; it will never be sent.`);
    return 0;
  }
  const held = queue.list('held');
  if (flags['json'] === true) {
    deps.stdout(JSON.stringify({ held, counts: countByStatus(queue) }, null, 2));
    return 0;
  }
  if (held.length === 0) deps.stdout('Nothing held for review.');
  else {
    deps.stdout(`${held.length} digest(s) held by the redaction gate. Each finding shows a masked copy of what tripped it.`);
    deps.stdout('');
    for (const item of held) printItem(ctx, item);
    deps.stdout('Approve with `expense-bridge review --approve <ref>` only if you have read the digest above and are sure it contains nothing about your code.');
    deps.stdout('Reject with `expense-bridge review --reject <ref>`.');
  }
  const counts = countByStatus(queue);
  deps.stdout(`Queue: ${counts.ready} ready, ${counts.held} held, ${counts.approved} approved, ${counts.rejected} rejected, ${counts.sent} sent.`);
  return 0;
}

function countByStatus(queue: QueueStore): Record<ItemStatus, number> {
  const counts: Record<ItemStatus, number> = { ready: 0, held: 0, approved: 0, rejected: 0, sent: 0 };
  for (const item of queue.list()) counts[item.status] += 1;
  return counts;
}

const DigestsResponseSchema = z.object({
  accepted: z.array(z.object({ external_ref: z.string() })),
  duplicates: z.array(z.string()),
  rejected: z.array(z.object({ external_ref: z.string(), code: z.string(), message: z.string() })),
});

async function cmdSend(ctx: Ctx): Promise<number> {
  const { deps } = ctx;
  const config = loadConfig(ctx.configPath);
  const queue = new QueueStore(resolvePath(ctx, config.queue_file), () => ctx.now().toISOString());
  const items = queue.sendable();
  if (items.length === 0) {
    deps.stdout('Nothing to send.');
    return 0;
  }
  const { bridgeKey } = resolveSecrets(config, deps.env, { need: ['bridge'] });
  let sent = 0;
  let rejected = 0;
  for (let i = 0; i < items.length; i += MAX_DIGESTS_PER_REQUEST) {
    const batch = items.slice(i, i + MAX_DIGESTS_PER_REQUEST);
    const digests: Digest[] = batch.map((b) => b.digest);
    const req = buildDigestsRequest({ apiBaseUrl: config.api_base_url, bridgeKey: bridgeKey as string, projectRef: config.project_ref, digests });
    const result = await sendRequest(req, { fetch: deps.fetch, dryRun: ctx.dryRun, out: deps.stdout, sleep: deps.sleep });
    if (result.dryRun) continue;
    const parsed = DigestsResponseSchema.safeParse(result.body);
    if (parsed.success) {
      const ok = [...parsed.data.accepted.map((a) => a.external_ref), ...parsed.data.duplicates];
      queue.markSent(ok, ctx.now().toISOString());
      sent += ok.length;
      for (const r of parsed.data.rejected) {
        rejected++;
        deps.stderr(`rejected ${r.external_ref}: ${r.code} ${r.message}`);
      }
    } else {
      const refs = digests.map((d) => d.external_ref);
      queue.markSent(refs, ctx.now().toISOString());
      sent += refs.length;
    }
  }
  if (ctx.dryRun) {
    deps.stdout(`[dry-run] ${items.length} digest(s) would be sent. Nothing was sent.`);
    return 0;
  }
  deps.stdout(`Sent ${sent} digest(s)${rejected > 0 ? `, ${rejected} rejected by the server (left in the queue)` : ''}.`);
  return rejected > 0 ? 1 : 0;
}

async function cmdSyncFeedback(ctx: Ctx): Promise<number> {
  const { deps } = ctx;
  const config = loadConfig(ctx.configPath);
  const { bridgeKey } = resolveSecrets(config, deps.env, { need: ['bridge'] });
  const target = { apiBaseUrl: config.api_base_url, bridgeKey: bridgeKey as string };
  if (ctx.dryRun) {
    deps.stdout(`[dry-run] would send:\n${describeRequest(buildFeedbackRequest(target))}`);
    deps.stdout('[dry-run] Nothing was sent or written.');
    return 0;
  }
  const feedback = await fetchAllFeedback({ ...target, fetch: deps.fetch, out: deps.stdout });
  writeFeedbackCache(ctx, config, feedback);
  deps.stdout(`Cached ${feedback.length} open feedback item(s) in ${config.feedback_file}.`);
  return 0;
}

/** Digests the resolver may match against: everything that is or will be on the server. */
const RESOLVABLE = new Set<ItemStatus>(['sent', 'ready', 'approved']);

async function cmdResolve(ctx: Ctx): Promise<number> {
  const { deps, flags } = ctx;
  const config = loadConfig(ctx.configPath);
  const minConfidence = typeof flags['min-confidence'] === 'string' ? Number(flags['min-confidence']) : config.resolution_min_confidence;
  if (Number.isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new UsageError('--min-confidence must be a number between 0 and 1');
  const queue = new QueueStore(resolvePath(ctx, config.queue_file), () => ctx.now().toISOString());
  const digests = queue.list().filter((i) => RESOLVABLE.has(i.status)).map((i) => i.digest);
  if (digests.length === 0) {
    deps.stdout('No digests to match against yet. Run `expense-bridge scan` first.');
    return 0;
  }
  const secrets = resolveSecrets(config, deps.env, { need: ctx.dryRun ? [] : ['bridge', 'provider'] });
  const provider = makeProvider(ctx, config, secrets.providerKey);

  if (ctx.dryRun) {
    const cached = readFeedbackCache(ctx, config);
    if (!cached || cached.length === 0) {
      deps.stdout('[dry-run] No cached feedback. Run `expense-bridge sync-feedback` to fetch open feedback, then try again.');
      return 0;
    }
    deps.stdout(`[dry-run] would ask ${provider.name} (${config.model}) to match ${cached.length} feedback item(s) against ${digests.length} digest(s):`);
    deps.stdout(formatDescribed(provider.describeResolutionRequest(cached, digests)));
    deps.stdout('');
    deps.stdout(`[dry-run] each confident match would then be POSTed to ${config.api_base_url.replace(/\/+$/, '')}/bridge-resolutions as {feedback_id, digest_external_ref, confidence, note}. Nothing was sent.`);
    return 0;
  }

  const target = { apiBaseUrl: config.api_base_url, bridgeKey: secrets.bridgeKey as string };
  const feedback = await fetchAllFeedback({ ...target, fetch: deps.fetch, out: deps.stdout });
  writeFeedbackCache(ctx, config, feedback);
  if (feedback.length === 0) {
    deps.stdout('No open feedback to match.');
    return 0;
  }
  const matches = await provider.matchResolutions(feedback, digests);
  const gate = scanOptions(config);
  let posted = 0;
  let weak = 0;
  let heldNotes = 0;
  const failures: string[] = [];
  for (const match of matches) {
    if (match.confidence < minConfidence) {
      weak++;
      continue;
    }
    const scan = scanText(match.note, gate);
    if (!scan.ok) {
      heldNotes++;
      deps.stderr(`skipped resolution for ${match.feedback_id}: note tripped the redaction gate (${scan.findings.map((f) => f.class).join(', ')}). Not sent.`);
      continue;
    }
    // One rejected resolution (e.g. 404 feedback_not_found) must not stop the rest.
    try {
      const req = buildResolutionRequest({ ...target, resolution: match });
      const result = await sendRequest(req, { fetch: deps.fetch, dryRun: false, out: deps.stdout, sleep: deps.sleep });
      posted++;
      const body = (result as { body: unknown }).body as { created?: unknown } | null;
      const repeat = body?.created === false ? ' (already recorded)' : '';
      deps.stdout(`  resolved ${match.feedback_id} -> ${match.digest_external_ref} (${match.confidence.toFixed(2)})${repeat}`);
    } catch (error) {
      failures.push(`${match.feedback_id} -> ${match.digest_external_ref}: ${(error as Error).message}`);
    }
  }
  for (const failure of failures) deps.stderr(`failed resolution ${failure}`);
  deps.stdout(
    `Posted ${posted} resolution(s); ${weak} below confidence ${minConfidence}; ${heldNotes} skipped by the redaction gate; ${failures.length} failed.`,
  );
  return failures.length > 0 && posted === 0 ? 1 : 0;
}

// ---------------------------------------------------------------- main

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    deps.stderr(`error: ${(error as Error).message}`);
    deps.stderr(USAGE);
    return 2;
  }
  const { command, flags } = parsed;
  if (flags['version'] === true) {
    deps.stdout(BRIDGE_VERSION);
    return 0;
  }
  if (command === undefined || flags['help'] === true) {
    deps.stdout(USAGE);
    return 0;
  }
  const ctx: Ctx = {
    deps,
    flags,
    dryRun: flags['dry-run'] === true,
    now: deps.now,
    configPath: resolve(deps.cwd, typeof flags['config'] === 'string' ? flags['config'] : CONFIG_FILENAME),
  };
  try {
    switch (command) {
      case 'init':
        return cmdInit(ctx);
      case 'scan':
        return await cmdScan(ctx);
      case 'review':
        return cmdReview(ctx);
      case 'send':
        return await cmdSend(ctx);
      case 'sync-feedback':
        return await cmdSyncFeedback(ctx);
      case 'resolve':
        return await cmdResolve(ctx);
      default:
        deps.stderr(`error: Unknown command "${command}"`);
        deps.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    deps.stderr(`error: ${(error as Error).message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

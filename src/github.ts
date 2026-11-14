/**
 * Reads merged pull requests with the developer's own token. Everything this
 * module returns stays on the developer's machine: it is handed to their model
 * and never to the Expense Tracker API.
 */
import { BRIDGE_VERSION } from './version.js';
import type { ChangedFile, FetchLike } from './providers/types.js';

export const GITHUB_API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9][\w-]*\/(?!\.{1,2}$)[\w.-]+$/;
const PER_PAGE = 100;

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  labels: string[];
  mergedAt: string;
  files: ChangedFile[];
  diff: string;
}

export interface ListOptions {
  repo: string;
  token: string;
  /** ISO timestamp; only PRs merged strictly after it are returned. */
  since: string | null;
  fetch: FetchLike;
  maxDiffChars: number;
  maxPages?: number;
}

interface RawPull {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  merged_at: string | null;
  updated_at: string;
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

async function getJson(fetch: FetchLike, token: string, url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': `expense-bridge/${BRIDGE_VERSION}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) throw new GitHubError(`GitHub returned 401: check the token env var (${text.slice(0, 120)})`, 401);
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('GitHub rate limit exhausted; try again later.', 403);
    }
    throw new GitHubError(`GitHub returned ${response.status}: ${text.slice(0, 200)}`, response.status);
  }
  return response.json();
}

function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new GitHubError(`Unexpected GitHub response for ${what}`, 0);
  return value;
}

export function boundDiff(files: Array<{ filename: string; patch?: string | undefined }>, maxChars: number): string {
  let out = '';
  for (const file of files) {
    const chunk = `--- ${file.filename}\n${file.patch ?? '(no text diff)'}\n`;
    if (out.length + chunk.length > maxChars) {
      out += chunk.slice(0, Math.max(0, maxChars - out.length)) + '\n[diff truncated]';
      break;
    }
    out += chunk;
  }
  return out;
}

async function listFiles(opts: ListOptions, number: number): Promise<RawFile[]> {
  const files: RawFile[] = [];
  for (let page = 1; page <= (opts.maxPages ?? 10); page++) {
    const url = `${GITHUB_API}/repos/${opts.repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`;
    const batch = expectArray(await getJson(opts.fetch, opts.token, url), `files of #${number}`) as RawFile[];
    files.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return files;
}

export async function listMergedPullRequests(opts: ListOptions): Promise<PullRequest[]> {
  if (!REPO.test(opts.repo)) throw new Error(`repo must be owner/name, got "${opts.repo}"`);
  const maxPages = opts.maxPages ?? 10;
  const merged: RawPull[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${GITHUB_API}/repos/${opts.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
    const batch = expectArray(await getJson(opts.fetch, opts.token, url), 'pull requests') as RawPull[];
    for (const pr of batch) {
      if (pr.merged_at && (opts.since === null || pr.merged_at > opts.since)) merged.push(pr);
    }
    const last = batch[batch.length - 1];
    const exhausted = opts.since !== null && last !== undefined && last.updated_at <= opts.since;
    if (batch.length < PER_PAGE || exhausted) break;
  }
  merged.sort((a, b) => (a.merged_at as string).localeCompare(b.merged_at as string));

  const result: PullRequest[] = [];
  for (const pr of merged) {
    const files = await listFiles(opts, pr.number);
    result.push({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? '',
      labels: pr.labels.map((l) => l.name),
      mergedAt: pr.merged_at as string,
      files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
      diff: boundDiff(files, opts.maxDiffChars),
    });
  }
  return result;
}

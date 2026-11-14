import { describe, it, expect } from 'vitest';
import { listMergedPullRequests, GitHubError, boundDiff } from '../src/github.js';
import { mockFetch, jsonResponse, textResponse, headerOf } from './helpers.js';

function pr(number: number, mergedAt: string | null, updatedAt = mergedAt ?? '2026-11-13T00:00:00Z') {
  return {
    number,
    title: `PR ${number}`,
    body: number % 2 ? 'body' : null,
    labels: [{ name: 'bug' }, { name: 'scanner' }],
    merged_at: mergedAt,
    updated_at: updatedAt,
    html_url: `https://github.com/o/r/pull/${number}`,
  };
}

const pageOf = (url: string): number => Number(new URL(url).searchParams.get('page'));

const files = [
  { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
  { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 },
];

describe('listMergedPullRequests', () => {
  it('lists merged PRs since the cursor with title, body, labels, merged_at, files and a bounded diff', async () => {
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('/pulls?')) return jsonResponse([pr(3, '2026-11-13T10:00:00Z'), pr(2, null), pr(1, '2026-11-01T00:00:00Z')]);
      return jsonResponse(files);
    });
    const prs = await listMergedPullRequests({ repo: 'o/r', token: 'ghp_t', since: '2026-11-10T00:00:00Z', fetch, maxDiffChars: 10_000 });
    expect(prs).toHaveLength(1);
    const only = prs[0]!;
    expect(only.number).toBe(3);
    expect(only.title).toBe('PR 3');
    expect(only.body).toBe('body');
    expect(only.labels).toEqual(['bug', 'scanner']);
    expect(only.mergedAt).toBe('2026-11-13T10:00:00Z');
    expect(only.files).toEqual([
      { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 },
    ]);
    expect(only.diff).toContain('--- src/a.ts');
    expect(only.diff).toContain('+b');
    expect(only.diff).toContain('assets/logo.png');

    const list = calls[0]!;
    expect(list.url).toMatch(/^https:\/\/api\.github\.com\/repos\/o\/r\/pulls\?/);
    expect(list.url).toContain('state=closed');
    expect(list.url).toContain('sort=updated');
    expect(headerOf(list.init, 'authorization')).toBe('Bearer ghp_t');
    expect(headerOf(list.init, 'accept')).toContain('application/vnd.github');
    expect(headerOf(list.init, 'x-github-api-version')).toBeDefined();
    expect(calls[1]!.url).toBe('https://api.github.com/repos/o/r/pulls/3/files?per_page=100&page=1');
  });

  it('returns results oldest first and includes everything when there is no cursor', async () => {
    const { fetch } = mockFetch((url) =>
      url.includes('/pulls?') ? jsonResponse([pr(3, '2026-11-13T10:00:00Z'), pr(2, '2026-11-01T00:00:00Z')]) : jsonResponse([]),
    );
    const prs = await listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch, maxDiffChars: 1000 });
    expect(prs.map((p) => p.number)).toEqual([2, 3]);
    expect(prs[0]!.body).toBe('');
  });

  it('paginates the PR list until a short page and stops early once updated_at is older than the cursor', async () => {
    const perPage = 100;
    const page1 = Array.from({ length: perPage }, (_, i) => pr(1000 - i, '2026-11-12T00:00:00Z'));
    const page2 = [pr(5, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')];
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('/pulls?')) return pageOf(url) === 1 ? jsonResponse(page1) : jsonResponse(page2);
      return jsonResponse([]);
    });
    const prs = await listMergedPullRequests({ repo: 'o/r', token: 't', since: '2026-11-10T00:00:00Z', fetch, maxDiffChars: 1000 });
    expect(prs).toHaveLength(perPage);
    const listCalls = calls.filter((c) => c.url.includes('/pulls?'));
    expect(listCalls).toHaveLength(2);
  });

  it('stops paging at the hard page cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1, '2026-11-12T00:00:00Z'));
    const { fetch, calls } = mockFetch((url) => (url.includes('/pulls?') ? jsonResponse(full) : jsonResponse([])));
    await listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch, maxDiffChars: 10, maxPages: 2 });
    expect(calls.filter((c) => c.url.includes('/pulls?'))).toHaveLength(2);
  });

  it('paginates the files list', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified', additions: 1, deletions: 0, patch: '+x' }));
    const { fetch, calls } = mockFetch((url) => {
      if (url.includes('/pulls?')) return jsonResponse([pr(1, '2026-11-12T00:00:00Z')]);
      return pageOf(url) === 1 ? jsonResponse(page) : jsonResponse([{ filename: 'last.ts', status: 'added', additions: 1, deletions: 0 }]);
    });
    const prs = await listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch, maxDiffChars: 100_000 });
    expect(prs[0]!.files).toHaveLength(101);
    expect(calls.filter((c) => c.url.includes('/files'))).toHaveLength(2);
  });

  it('raises GitHubError with status and a token hint on 401, and a rate-limit hint on 403', async () => {
    const unauthorized = mockFetch(() => jsonResponse({ message: 'Bad credentials' }, 401)).fetch;
    await expect(listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch: unauthorized, maxDiffChars: 10 })).rejects.toThrow(GitHubError);
    await expect(listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch: unauthorized, maxDiffChars: 10 })).rejects.toThrow(/401.*token/i);
    const limited = mockFetch(() => jsonResponse({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' })).fetch;
    await expect(listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch: limited, maxDiffChars: 10 })).rejects.toThrow(/rate limit/i);
    const other = mockFetch(() => textResponse('nope', 500)).fetch;
    await expect(listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch: other, maxDiffChars: 10 })).rejects.toThrow(/500/);
  });

  it('rejects an unexpected response shape', async () => {
    const { fetch } = mockFetch(() => jsonResponse({ not: 'a list' }));
    await expect(listMergedPullRequests({ repo: 'o/r', token: 't', since: null, fetch, maxDiffChars: 10 })).rejects.toThrow(/unexpected/i);
  });

  it('rejects a malformed repo before making any request', async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse([]));
    await expect(listMergedPullRequests({ repo: '../evil', token: 't', since: null, fetch, maxDiffChars: 10 })).rejects.toThrow(/repo/);
    expect(calls).toHaveLength(0);
  });
});

describe('boundDiff', () => {
  it('concatenates per-file patches and truncates with a marker at the limit', () => {
    const diff = boundDiff(
      [
        { filename: 'a.ts', patch: 'x'.repeat(50) },
        { filename: 'b.ts', patch: 'y'.repeat(50) },
      ],
      80,
    );
    expect(diff.length).toBeLessThanOrEqual(80 + '\n[diff truncated]'.length);
    expect(diff).toContain('[diff truncated]');
    expect(diff).toContain('--- a.ts');
  });
  it('notes binary / patch-less files without a patch body', () => {
    expect(boundDiff([{ filename: 'logo.png' }], 1000)).toBe('--- logo.png\n(no text diff)\n');
  });
});

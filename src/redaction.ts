/**
 * The redaction gate. Runs on every string the Bridge is about to send and on
 * nothing else; a hit holds the item for visible review, it is never sent
 * silently (decisions.md §2, §6).
 *
 * Classes, in the order they are checked:
 *   secret:*            credential shapes (AWS, GitHub, Stripe, JWT/Supabase, private keys, Slack, generic tokens)
 *   path                directory paths and bare file names with code extensions
 *   code_fence          ``` blocks
 *   inline_code         `backticks`
 *   identifier_density  camelCase / snake_case / dotted tokens above a per-100-words threshold
 *   url                 any URL whose host is not the configured API host
 *   email               e-mail addresses
 *
 * Findings carry a MASKED copy of the offending substring, never the original.
 */
import type { Digest } from './schema.js';

export interface Finding {
  class: string;
  /** JSON-path-like location inside the digest, e.g. `test_items[0].steps[1]`. Empty for scanText. */
  field: string;
  masked: string;
}

export interface ScanOptions {
  /** Hosts whose URLs are allowed (the configured Expense Tracker API host). */
  allowedHosts: string[];
  /** Identifiers per 100 words above which text is held. Default 3. */
  identifierDensityThreshold?: number;
}

export interface ScanResult {
  ok: boolean;
  findings: Finding[];
}

export const PATTERN_CLASSES = [
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
] as const;

const SECRET_PATTERNS: ReadonlyArray<{ cls: string; re: RegExp }> = [
  { cls: 'secret:aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { cls: 'secret:github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { cls: 'secret:github', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { cls: 'secret:stripe', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { cls: 'secret:jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g },
  { cls: 'secret:private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { cls: 'secret:slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { cls: 'secret:slack', re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { cls: 'secret:generic_token', re: /\b[0-9a-fA-F]{32,}\b/g },
  { cls: 'secret:generic_token', re: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g },
];

const SOURCE_DIRS =
  'src|lib|app|apps|test|tests|spec|__tests__|pkg|packages|components|screens|services|hooks|utils|supabase|migrations|functions|node_modules|dist|build|config|scripts|docs|public|assets|ios|android|mobile|api|cmd|internal|bin|vendor|static|styles|types|store|contexts|routes|pages|server|client|infra|deploy';
const CODE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|java|kt|swift|mm|cpp|hpp|cs|php|sql|sh|bash|zsh|yml|yaml|toml|ini|env|md|mdx|html|css|scss|less|vue|svelte|graphql|gql|proto|lock|xml|plist|gradle|dart|exs?|scala|clj|lua|ipynb|tf|dockerfile';

/** `a/b`, `./a/b`, `/a/b` where some segment carries a code extension or the first segment is a source dir. */
const DIR_PATH = new RegExp(
  `(?<![\\w/.-])(?:\\.{1,2}/|/)?(?:(?:${SOURCE_DIRS})/[\\w.-]+(?:/[\\w.-]+)*|(?:[\\w.-]+/)+[\\w-]+\\.(?:${CODE_EXT}))\\b`,
  'g',
);
const BARE_FILE = new RegExp(`\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:${CODE_EXT})\\b`, 'g');
const CODE_FENCE = /```/g;
const INLINE_CODE = /`[^`\n]+`/g;
const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s<>"')\]]+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const CAMEL = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
const SNAKE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi;
const DOTTED = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;
const WORD = /[A-Za-z0-9_.]+/g;

/** Brand/product names that look like camelCase but are ordinary user-facing words. */
const CAMEL_ALLOWLIST = new Set(
  [
    'iPhone', 'iPad', 'iPod', 'iMac', 'iOS', 'iPadOS', 'macOS', 'watchOS', 'tvOS', 'visionOS', 'iCloud', 'iMessage',
    'eBay', 'PayPal', 'YouTube', 'GitHub', 'GitLab', 'Bitbucket', 'TestFlight', 'LinkedIn', 'WhatsApp', 'OpenAI',
    'JavaScript', 'TypeScript', 'PowerPoint', 'QuickBooks', 'FaceTime', 'AirDrop', 'AirPlay', 'WiFi', 'MacBook',
    'TikTok', 'WordPress', 'DocuSign', 'FreshBooks', 'OneDrive', 'SharePoint', 'YouTube', 'eSIM', 'mAh',
  ].map((w) => w.toLowerCase()),
);

export function mask(text: string): string {
  if (text.length <= 8) return '*'.repeat(text.length);
  return text.slice(0, 5) + '*'.repeat(text.length - 6) + text.slice(-1);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function collect(text: string, re: RegExp): string[] {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re), (m) => m[0]);
}

export function scanText(text: string, options: ScanOptions, field = ''): ScanResult {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  const push = (cls: string, raw: string): void => {
    const key = `${cls}\u0000${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ class: cls, field, masked: mask(raw) });
  };

  for (const { cls, re } of SECRET_PATTERNS) for (const m of collect(text, re)) push(cls, m);

  const dirPaths = collect(text, DIR_PATH);
  for (const p of dirPaths) push('path', p);
  for (const f of collect(text, BARE_FILE)) if (!dirPaths.some((p) => p.includes(f))) push('path', f);

  for (const m of collect(text, CODE_FENCE)) push('code_fence', m);
  for (const m of collect(text, INLINE_CODE)) push('inline_code', m);

  // URLs and e-mail addresses are judged by their own rules below; blank them
  // out so their dotted hosts do not also count as identifiers.
  const prose = text.replace(URL_RE, ' ').replace(EMAIL, ' ');
  const identifiers = [
    ...collect(prose, CAMEL).filter((w) => !CAMEL_ALLOWLIST.has(w.toLowerCase())),
    ...collect(prose, SNAKE),
    ...collect(prose, DOTTED),
  ];
  const words = collect(prose, WORD).length;
  const threshold = options.identifierDensityThreshold ?? 3;
  if (identifiers.length > 0 && words > 0 && (identifiers.length / words) * 100 > threshold) {
    push('identifier_density', identifiers.join(' '));
  }

  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  for (const u of collect(text, URL_RE)) {
    const host = hostOf(u);
    if (host === null || !allowed.has(host)) push('url', u);
  }

  for (const m of collect(text, EMAIL)) push('email', m);

  return { ok: findings.length === 0, findings };
}

/**
 * Scan every free-text field of a digest. Fields that are not free text are
 * skipped on purpose: external_ref is a hash (it would trip the hex rule),
 * change_type/priority are enums, shipped_at is a date, bridge_version is ours,
 * and addresses_feedback is filtered against server-issued ids elsewhere.
 */
export function scanDigest(digest: Digest, options: ScanOptions): ScanResult {
  const findings: Finding[] = [];
  const add = (field: string, text: string): void => {
    findings.push(...scanText(text, options, field).findings);
  };
  add('title', digest.title);
  add('summary', digest.summary);
  digest.test_items.forEach((item, i) => {
    add(`test_items[${i}].title`, item.title);
    item.steps.forEach((step, j) => add(`test_items[${i}].steps[${j}]`, step));
    add(`test_items[${i}].expected`, item.expected);
  });
  return { ok: findings.length === 0, findings };
}

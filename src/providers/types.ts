import type { Digest, DigestDraft, ResolutionMatch } from '../schema.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Everything about a PR that the developer's model is shown. Stays local. */
export interface DigestInput {
  repoFullName: string;
  prNumber: number;
  title: string;
  body: string;
  labels: string[];
  mergedAt: string | null;
  files: ChangedFile[];
  diff: string;
  openFeedback: FeedbackItem[];
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

/** A feedback item as returned by GET /bridge/feedback. */
export interface FeedbackItem {
  id: string;
  text: string;
  severity: string;
  status: string;
  created_at: string;
}

/** A request as it would be sent, with credentials masked; printed by --dry-run. */
export interface DescribedRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderOptions {
  model: string;
  apiKey: string | null;
  baseUrl?: string | undefined;
  fetch: FetchLike;
}

export interface Provider {
  readonly name: 'anthropic' | 'openai' | 'ollama';
  generateDigest(input: DigestInput): Promise<DigestDraft>;
  matchResolutions(feedback: FeedbackItem[], digests: Digest[]): Promise<ResolutionMatch[]>;
  describeDigestRequest(input: DigestInput): DescribedRequest;
  describeResolutionRequest(feedback: FeedbackItem[], digests: Digest[]): DescribedRequest;
}

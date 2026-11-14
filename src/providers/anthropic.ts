/**
 * Anthropic Messages API over raw HTTP (no SDK: the whole wire shape is in
 * this file so it can be audited). Request shape per the Claude API reference
 * for API version 2026-10-21: no sampling parameters, thinking left at the
 * model default (adaptive), structured output via output_config.format, and
 * server-side refusal fallbacks on the models that support them.
 *
 * No `cache_control` marker: see the note at the top of src/prompt.ts.
 */
import { BaseProvider, ProviderError, joinUrl, type HttpResult } from './shared.js';
import type { DescribedRequest, ProviderOptions } from './types.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 16_000;

/** `fallbacks: "default"` is accepted by the Opus 5.x, Fable 5.x and Sonnet 5.5 families. */
export function supportsServerSideFallback(model: string): boolean {
  return /^claude-(?:opus-5|fable-5|sonnet-5-5|mythos-5)/.test(model);
}

export class AnthropicProvider extends BaseProvider {
  readonly name = 'anthropic' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: ProviderOptions) {
    super(options.model, options.fetch);
    if (!options.apiKey) throw new ProviderError('Anthropic provider needs an API key (set the env var named by provider_key_env).');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? ANTHROPIC_BASE_URL;
  }

  protected buildRequest(system: string, user: string, schema: object): DescribedRequest {
    const fallback = supportsServerSideFallback(this.model);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (fallback) headers['anthropic-beta'] = FALLBACK_BETA;
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    };
    if (fallback) body['fallbacks'] = 'default';
    return { method: 'POST', url: joinUrl(this.baseUrl, '/v1/messages'), headers, body: JSON.stringify(body) };
  }

  protected extractText(result: HttpResult): string {
    const json = result.json as Record<string, unknown>;
    const stopReason = json['stop_reason'];
    if (stopReason === 'refusal') {
      const details = json['stop_details'] as Record<string, unknown> | undefined;
      throw new ProviderError(`Anthropic declined the request (category: ${String(details?.['category'] ?? 'unknown')}).`);
    }
    if (stopReason === 'max_tokens') throw new ProviderError('Anthropic reply hit max_tokens before the JSON was complete.');
    const content = Array.isArray(json['content']) ? (json['content'] as Array<Record<string, unknown>>) : [];
    return content
      .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
      .map((block) => block['text'] as string)
      .join('');
  }
}

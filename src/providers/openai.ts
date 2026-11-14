/**
 * OpenAI Chat Completions over raw HTTP with a strict json_schema response
 * format. Request shape written from the public API reference as understood
 * at authoring time (not re-verified live); the tests pin the shape the Bridge
 * sends so any drift is visible.
 */
import { BaseProvider, ProviderError, joinUrl, type HttpResult } from './shared.js';
import type { DescribedRequest, ProviderOptions } from './types.js';

export const OPENAI_BASE_URL = 'https://api.openai.com';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: ProviderOptions) {
    super(options.model, options.fetch);
    if (!options.apiKey) throw new ProviderError('OpenAI provider needs an API key (set the env var named by provider_key_env).');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? OPENAI_BASE_URL;
  }

  protected buildRequest(system: string, user: string, schema: object): DescribedRequest {
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'bridge_output', strict: true, schema } },
    };
    return {
      method: 'POST',
      url: joinUrl(this.baseUrl, '/v1/chat/completions'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    };
  }

  protected extractText(result: HttpResult): string {
    const json = result.json as Record<string, unknown>;
    const choices = Array.isArray(json['choices']) ? (json['choices'] as Array<Record<string, unknown>>) : [];
    const first = choices[0];
    if (!first) throw new ProviderError('OpenAI reply had no choices.');
    const message = (first['message'] ?? {}) as Record<string, unknown>;
    if (typeof message['refusal'] === 'string' && message['refusal']) throw new ProviderError('OpenAI declined the request.');
    if (first['finish_reason'] === 'length') throw new ProviderError('OpenAI reply was cut off (finish_reason: length).');
    return typeof message['content'] === 'string' ? message['content'] : '';
  }
}

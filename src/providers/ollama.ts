/**
 * Ollama /api/chat over raw HTTP, local-only by default. The JSON schema is
 * passed as `format` so the model is constrained to it. Request shape written
 * from the Ollama API docs as understood at authoring time (not re-verified
 * live); the tests pin what the Bridge sends.
 */
import { BaseProvider, ProviderError, joinUrl, type HttpResult } from './shared.js';
import type { DescribedRequest, ProviderOptions } from './types.js';

export const OLLAMA_BASE_URL = 'http://localhost:11434';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export class OllamaProvider extends BaseProvider {
  readonly name = 'ollama' as const;
  private readonly baseUrl: string;

  constructor(options: ProviderOptions) {
    super(options.model, options.fetch);
    this.baseUrl = options.baseUrl ?? OLLAMA_BASE_URL;
    const host = new URL(this.baseUrl).hostname;
    if (!LOCAL_HOSTS.has(host)) {
      throw new ProviderError(
        `Ollama provider is local-only in v1 (got host "${host}"). Point provider_base_url at localhost, or use the anthropic/openai provider for a remote model.`,
      );
    }
  }

  protected buildRequest(system: string, user: string, schema: object): DescribedRequest {
    const body = {
      model: this.model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      format: schema,
      options: { temperature: 0 },
    };
    return { method: 'POST', url: joinUrl(this.baseUrl, '/api/chat'), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  protected extractText(result: HttpResult): string {
    const json = result.json as Record<string, unknown>;
    const message = json['message'] as Record<string, unknown> | undefined;
    if (!message || typeof message['content'] !== 'string') throw new ProviderError('Ollama reply had no message content.');
    return message['content'];
  }
}

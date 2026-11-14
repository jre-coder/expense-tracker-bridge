import type { ProviderName } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import type { FetchLike, Provider } from './types.js';

export interface CreateProviderOptions {
  provider: ProviderName;
  model: string;
  providerKey: string | null;
  baseUrl?: string | undefined;
  fetch: FetchLike;
}

export function createProvider(opts: CreateProviderOptions): Provider {
  const options = { model: opts.model, apiKey: opts.providerKey, baseUrl: opts.baseUrl, fetch: opts.fetch };
  switch (opts.provider) {
    case 'anthropic':
      return new AnthropicProvider(options);
    case 'openai':
      return new OpenAIProvider(options);
    case 'ollama':
      return new OllamaProvider(options);
  }
}

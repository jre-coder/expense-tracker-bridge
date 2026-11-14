import { describe, it, expect } from 'vitest';
import { createProvider } from '../src/providers/index.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { ProviderError, extractJsonObject, draftFromModelOutput, matchesFromModelOutput } from '../src/providers/shared.js';
import type { DigestInput, FeedbackItem, Provider } from '../src/providers/types.js';
import { DIGEST_SYSTEM_PROMPT } from '../src/prompt.js';
import { mockFetch, jsonResponse, textResponse, headerOf } from './helpers.js';
import { validDigest } from './fixtures/digests.js';

const input: DigestInput = {
  repoFullName: 'jre-coder/corvago',
  prNumber: 12,
  title: 'Handle faded thermal receipts',
  body: 'Closes the faded-receipt bug.',
  labels: ['bug'],
  mergedAt: '2026-11-13T09:30:00Z',
  files: [{ filename: 'src/services/receiptService.ts', status: 'modified', additions: 10, deletions: 2 }],
  diff: '--- src/services/receiptService.ts\n+const a = 2;',
  openFeedback: [{ id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: '2026-11-01T00:00:00Z' }],
};

const draftJson = {
  change_type: 'fix',
  title: 'Receipt scanning now reads faded thermal paper',
  summary: 'Faded receipts are extracted correctly.',
  test_items: [{ title: 'Scan a faded receipt', steps: ['Scan an old receipt'], expected: 'Fields fill in', priority: 'high' }],
  addresses_feedback: ['fb_1', 'fb_invented'],
};

const feedback: FeedbackItem[] = [
  { id: 'fb_1', text: 'Old receipts never scan', severity: 'high', status: 'open', created_at: '2026-11-01T00:00:00Z' },
];
const matchesJson = {
  matches: [
    { feedback_id: 'fb_1', digest_external_ref: validDigest.external_ref, confidence: 0.92, note: 'The faded-receipt fix covers this.' },
    { feedback_id: 'fb_unknown', digest_external_ref: validDigest.external_ref, confidence: 0.9, note: 'x' },
    { feedback_id: 'fb_1', digest_external_ref: 'ffffffffffffffff', confidence: 0.9, note: 'unknown digest' },
  ],
};

describe('shared helpers', () => {
  it('extractJsonObject parses plain JSON and JSON wrapped in a code fence', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('noise {"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
  });
  it('extractJsonObject throws ProviderError on garbage, without echoing the text', () => {
    expect(() => extractJsonObject('not json at all')).toThrow(ProviderError);
    expect(() => extractJsonObject('{"a":')).toThrow(/JSON/);
    expect(() => extractJsonObject('{bad json}')).toThrow(/not valid JSON/);
    expect(() => extractJsonObject('[1,2]')).toThrow(/object/);
  });
  it('draftFromModelOutput validates and keeps only feedback ids we actually know', () => {
    const draft = draftFromModelOutput(draftJson, new Set(['fb_1']));
    expect(draft.addresses_feedback).toEqual(['fb_1']);
    expect(draft.title).toBe(draftJson.title);
  });
  it('draftFromModelOutput rejects an invalid draft with the schema issues', () => {
    expect(() => draftFromModelOutput({ ...draftJson, change_type: 'refactor' }, new Set())).toThrow(/change_type/);
  });
  it('matchesFromModelOutput drops unknown feedback ids and digest refs and clamps to valid matches', () => {
    const matches = matchesFromModelOutput(matchesJson, new Set(['fb_1']), new Set([validDigest.external_ref]));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe(0.92);
  });
  it('matchesFromModelOutput rejects an output without a matches array or with invalid items', () => {
    expect(() => matchesFromModelOutput({ nope: [] }, new Set(), new Set())).toThrow(/matches/);
    expect(() => matchesFromModelOutput({ matches: [{ feedback_id: 'fb_1' }] }, new Set(), new Set())).toThrow(ProviderError);
  });
});

describe('AnthropicProvider', () => {
  const make = (responder: Parameters<typeof mockFetch>[0]) => {
    const f = mockFetch(responder);
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'sk-ant-test', fetch: f.fetch });
    return { ...f, provider };
  };

  it('sends the Messages API request shape with structured output and no sampling params', async () => {
    const { provider, calls } = make(() =>
      jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(draftJson) }] }),
    );
    const draft = await provider.generateDigest(input);
    expect(draft.addresses_feedback).toEqual(['fb_1']);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'x-api-key')).toBe('sk-ant-test');
    expect(headerOf(call.init, 'anthropic-version')).toBe('2026-10-21');
    expect(headerOf(call.init, 'anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = call.body as Record<string, unknown>;
    expect(body['model']).toBe('claude-opus-5-5');
    expect(body['system']).toBe(DIGEST_SYSTEM_PROMPT);
    expect(body['fallbacks']).toBe('default');
    expect(body['max_tokens']).toBeGreaterThanOrEqual(4000);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('thinking');
    const oc = body['output_config'] as Record<string, unknown>;
    expect((oc['format'] as Record<string, unknown>)['type']).toBe('json_schema');
    expect(JSON.stringify(oc['format'])).not.toMatch(/maxLength|maxItems/);
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toContain('Handle faded thermal receipts');
  });

  it('omits fallbacks and the beta header for models without server-side fallback', async () => {
    const f = mockFetch(() => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(draftJson) }] }));
    const provider = new AnthropicProvider({ model: 'claude-sonnet-4-6', apiKey: 'k', fetch: f.fetch });
    await provider.generateDigest(input);
    expect((f.calls[0]!.body as Record<string, unknown>)['fallbacks']).toBeUndefined();
    expect(headerOf(f.calls[0]!.init, 'anthropic-beta')).toBeUndefined();
  });

  it('honours a custom base URL', async () => {
    const f = mockFetch(() => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(draftJson) }] }));
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: f.fetch, baseUrl: 'https://proxy.example/' });
    await provider.generateDigest(input);
    expect(f.calls[0]!.url).toBe('https://proxy.example/v1/messages');
  });

  it('concatenates multiple text blocks', async () => {
    const text = JSON.stringify(draftJson);
    const { provider } = make(() =>
      jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: text.slice(0, 10) }, { type: 'thinking', thinking: '' }, { type: 'text', text: text.slice(10) }] }),
    );
    expect((await provider.generateDigest(input)).title).toBe(draftJson.title);
  });

  it('surfaces a refusal, a truncated response and HTTP errors as ProviderError', async () => {
    await expect(make(() => jsonResponse({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] })).provider.generateDigest(input)).rejects.toThrow(/declined/);
    await expect(make(() => jsonResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] })).provider.generateDigest(input)).rejects.toThrow(/max_tokens/);
    await expect(make(() => jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)).provider.generateDigest(input)).rejects.toThrow(/401/);
  });

  it('handles a non-JSON HTTP body and a JSON parse failure in the model text', async () => {
    await expect(make(() => textResponse('upstream down', 502)).provider.generateDigest(input)).rejects.toThrow(/502/);
    await expect(make(() => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry, no' }] })).provider.generateDigest(input)).rejects.toThrow(/JSON/);
    await expect(make(() => textResponse('<html>', 200)).provider.generateDigest(input)).rejects.toThrow(/JSON/);
  });

  it('matches resolutions with the resolution schema and filters unknown ids', async () => {
    const { provider, calls } = make(() => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(matchesJson) }] }));
    const matches = await provider.matchResolutions(feedback, [validDigest]);
    expect(matches).toHaveLength(1);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(JSON.stringify((body['output_config'] as Record<string, unknown>)['format'])).toContain('matches');
  });

  it('describes requests for --dry-run with the key masked', () => {
    const { provider } = make(() => textResponse(''));
    const described = provider.describeDigestRequest(input);
    expect(described.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.stringify(described.headers)).not.toContain('sk-ant-test');
    expect(described.body).toContain('Handle faded thermal receipts');
    expect(provider.describeResolutionRequest(feedback, [validDigest]).body).toContain(validDigest.external_ref);
  });

  it('requires an API key', () => {
    expect(() => new AnthropicProvider({ model: 'm', apiKey: null, fetch: mockFetch(() => textResponse('')).fetch })).toThrow(/API key/);
  });
});

describe('OpenAIProvider', () => {
  const ok = (content: unknown) => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });

  it('sends chat completions with a strict json_schema response_format and a bearer token', async () => {
    const f = mockFetch(() => ok(draftJson));
    const provider = new OpenAIProvider({ model: 'gpt-4.1', apiKey: 'sk-oa', fetch: f.fetch });
    const draft = await provider.generateDigest(input);
    expect(draft.change_type).toBe('fix');
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headerOf(call.init, 'authorization')).toBe('Bearer sk-oa');
    const body = call.body as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4.1');
    const rf = body['response_format'] as Record<string, unknown>;
    expect(rf['type']).toBe('json_schema');
    expect((rf['json_schema'] as Record<string, unknown>)['strict']).toBe(true);
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: DIGEST_SYSTEM_PROMPT });
    expect(messages[1]?.role).toBe('user');
  });

  it('handles refusals, length cut-offs, missing choices, HTTP errors and bad JSON', async () => {
    const mk = (r: Response) => new OpenAIProvider({ model: 'm', apiKey: 'k', fetch: mockFetch(() => r).fetch });
    await expect(mk(jsonResponse({ choices: [{ finish_reason: 'stop', message: { refusal: 'no', content: null } }] })).generateDigest(input)).rejects.toThrow(/declined/);
    await expect(mk(jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '{' } }] })).generateDigest(input)).rejects.toThrow(/length/);
    await expect(mk(jsonResponse({ choices: [] })).generateDigest(input)).rejects.toThrow(/no choices/i);
    await expect(mk(jsonResponse({ error: { message: 'bad key' } }, 401)).generateDigest(input)).rejects.toThrow(/401/);
    await expect(mk(jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'nope' } }] })).generateDigest(input)).rejects.toThrow(/JSON/);
  });

  it('matches resolutions and supports a custom base URL', async () => {
    const f = mockFetch(() => ok(matchesJson));
    const provider = new OpenAIProvider({ model: 'm', apiKey: 'k', fetch: f.fetch, baseUrl: 'https://oa.example' });
    expect(await provider.matchResolutions(feedback, [validDigest])).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://oa.example/v1/chat/completions');
    expect(JSON.stringify(provider.describeDigestRequest(input).headers)).not.toContain('"k"');
    expect(provider.describeResolutionRequest(feedback, [validDigest]).body).toContain('fb_1');
  });

  it('requires an API key', () => {
    expect(() => new OpenAIProvider({ model: 'm', apiKey: null, fetch: mockFetch(() => textResponse('')).fetch })).toThrow(/API key/);
  });
});

describe('OllamaProvider', () => {
  it('posts to the local chat endpoint with the schema as format and no key', async () => {
    const f = mockFetch(() => jsonResponse({ message: { role: 'assistant', content: JSON.stringify(draftJson) }, done: true }));
    const provider = new OllamaProvider({ model: 'llama3.1', apiKey: null, fetch: f.fetch });
    const draft = await provider.generateDigest(input);
    expect(draft.title).toBe(draftJson.title);
    const call = f.calls[0]!;
    expect(call.url).toBe('http://localhost:11434/api/chat');
    expect(headerOf(call.init, 'authorization')).toBeUndefined();
    const body = call.body as Record<string, unknown>;
    expect(body['stream']).toBe(false);
    expect(body['model']).toBe('llama3.1');
    expect((body['format'] as Record<string, unknown>)['type']).toBe('object');
  });

  it('honours a custom base URL and handles errors', async () => {
    const f = mockFetch(() => jsonResponse({ message: { content: JSON.stringify(matchesJson) }, done: true }));
    const provider = new OllamaProvider({ model: 'm', apiKey: null, fetch: f.fetch, baseUrl: 'http://127.0.0.1:11434/' });
    expect(await provider.matchResolutions(feedback, [validDigest])).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    const bad = new OllamaProvider({ model: 'm', apiKey: null, fetch: mockFetch(() => jsonResponse({ error: 'model not found' }, 404)).fetch });
    await expect(bad.generateDigest(input)).rejects.toThrow(/404/);
    const noMsg = new OllamaProvider({ model: 'm', apiKey: null, fetch: mockFetch(() => jsonResponse({ done: true })).fetch });
    await expect(noMsg.generateDigest(input)).rejects.toThrow(/message/);
    expect(provider.describeDigestRequest(input).url).toContain('/api/chat');
    expect(provider.describeResolutionRequest(feedback, [validDigest]).body).toContain('fb_1');
  });

  it('refuses to talk to a non-local Ollama host unless the user opts in (local-only by default)', () => {
    expect(() => new OllamaProvider({ model: 'm', apiKey: null, fetch: mockFetch(() => textResponse('')).fetch, baseUrl: 'https://ollama.example' })).toThrow(/local/);
  });
});

describe('createProvider', () => {
  const f = mockFetch(() => textResponse(''));
  it('builds each provider from config + secrets', () => {
    const a: Provider = createProvider({ provider: 'anthropic', model: 'claude-opus-5-5', providerKey: 'k', fetch: f.fetch });
    expect(a.name).toBe('anthropic');
    expect(createProvider({ provider: 'openai', model: 'gpt-4.1', providerKey: 'k', fetch: f.fetch }).name).toBe('openai');
    expect(createProvider({ provider: 'ollama', model: 'llama3.1', providerKey: null, fetch: f.fetch }).name).toBe('ollama');
  });
  it('passes the base URL through', () => {
    const p = createProvider({ provider: 'ollama', model: 'm', providerKey: null, fetch: f.fetch, baseUrl: 'http://localhost:11435' });
    expect(p.describeDigestRequest(input).url).toBe('http://localhost:11435/api/chat');
  });
});

describe('no code in the digest the provider returns', () => {
  it('the parsed draft contains only schema fields (unknown keys from the model are dropped)', async () => {
    const f = mockFetch(() =>
      jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...draftJson, diff: '+++ b/src/x.ts', files: ['src/x.ts'] }) }] }),
    );
    const provider = new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: f.fetch });
    const draft = await provider.generateDigest(input);
    expect(Object.keys(draft).sort()).toEqual(['addresses_feedback', 'change_type', 'summary', 'test_items', 'title']);
    expect(JSON.stringify(draft)).not.toContain('src/');
  });
});

describe('provider response edge cases', () => {
  it('Anthropic: refusal without stop_details, and a reply with no content array', async () => {
    const mk = (r: Response) => new AnthropicProvider({ model: 'claude-opus-5-5', apiKey: 'k', fetch: mockFetch(() => r).fetch });
    await expect(mk(jsonResponse({ stop_reason: 'refusal' })).generateDigest(input)).rejects.toThrow(/unknown/);
    await expect(mk(jsonResponse({ stop_reason: 'end_turn' })).generateDigest(input)).rejects.toThrow(/JSON object/);
  });

  it('OpenAI: missing choices array, missing message, null content', async () => {
    const mk = (r: Response) => new OpenAIProvider({ model: 'm', apiKey: 'k', fetch: mockFetch(() => r).fetch });
    await expect(mk(jsonResponse({})).generateDigest(input)).rejects.toThrow(/no choices/i);
    await expect(mk(jsonResponse({ choices: [{ finish_reason: 'stop' }] })).generateDigest(input)).rejects.toThrow(/JSON object/);
    await expect(mk(jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: null } }] })).generateDigest(input)).rejects.toThrow(/JSON object/);
  });
});

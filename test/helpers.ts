import type { FetchLike } from '../src/providers/types.js';

export interface RecordedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

export type Responder = (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response> | Error;

/** A fetch double that records every call and never touches the network. */
export function mockFetch(responder: Responder): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = typeof init?.body === 'string' ? safeParse(init.body) : undefined;
    calls.push({ url, init: init ?? {}, body });
    const result = await responder(url, init ?? {}, calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetch, calls };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
}

export function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

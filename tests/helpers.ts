import { vi } from 'vitest';
import { Db } from '../src/db/index.js';
import { nullLogger } from '../src/logger.js';
import { defaultRetry, type HttpDeps } from '../src/olx/http.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type MockReply = Response | (() => Response) | Error;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * fetch mock that serves replies by matching "METHOD path" (path without query) against routes,
 * falling back to a FIFO queue. Every call is recorded.
 */
export function mockFetch() {
  const calls: RecordedCall[] = [];
  const queue: MockReply[] = [];
  const routes = new Map<string, MockReply[]>();

  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, body });

    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    const routed = routes.get(key);
    const reply = routed && routed.length > 0 ? (routed.length > 1 ? routed.shift()! : routed[0]!) : queue.shift();
    if (!reply) throw new Error(`mockFetch: no reply for ${key}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply.clone();
  });

  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    /** Queue one-off replies in order. */
    enqueue: (...replies: MockReply[]) => queue.push(...replies),
    /** Route "GET /api/partner/threads" → replies (last one repeats). */
    route: (key: string, ...replies: MockReply[]) => routes.set(key, replies),
  };
}

export function makeHttpDeps(fetchFn: typeof fetch, overrides: Partial<HttpDeps> = {}) {
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    fetch: fetchFn,
    logger: nullLogger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => Date.UTC(2026, 10, 19, 12, 0, 0),
    retry: { ...defaultRetry },
    ...overrides,
  };
  return { deps, sleeps };
}

export function memoryDb(now?: () => number): Db {
  return new Db(':memory:', now);
}

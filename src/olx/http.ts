import type { z } from 'zod';
import type { Logger } from '../logger.js';
import { OlxApiError, OlxBlockedError } from './errors.js';

export type FetchFn = typeof fetch;

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a server-provided Retry-After. */
  maxRetryAfterMs: number;
}

export const defaultRetry: RetryOptions = {
  maxRetries: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxRetryAfterMs: 5 * 60_000,
};

/** Per OLX FAQ: an IP over the limit is blocked for 30 minutes. */
export const BLOCK_DURATION_MS = 30 * 60_000;

export interface HttpDeps {
  fetch: FetchFn;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
  retry: RetryOptions;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: a random value in [cap/2, cap], cap = min(max, base * 2^attempt). */
export function backoffDelay(attempt: number, opts: RetryOptions, random: () => number): number {
  const cap = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(cap / 2 + random() * (cap / 2));
}

/** Parses Retry-After (delta-seconds or HTTP-date). Returns ms or null. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

const isRetryableStatus = (s: number) => s === 429 || s >= 500;

function isHtmlBlock(res: Response): boolean {
  return res.status === 403 && (res.headers.get('content-type') ?? '').includes('text/html');
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Extracts a readable message from OLX error shapes: {error:{title,detail}}, {data:{error}}, {error, error_description}. */
export function describeError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 200) : undefined;
  const b = body as Record<string, unknown>;
  const inner = (b.data as Record<string, unknown> | undefined)?.error ?? b.error;
  if (typeof inner === 'string') return [inner, b.error_description].filter(Boolean).join(': ');
  if (inner && typeof inner === 'object') {
    const e = inner as Record<string, unknown>;
    return [e.title, e.detail].filter(Boolean).join(': ') || undefined;
  }
  return undefined;
}

export interface RawRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Performs a request with retries on network errors, 429 and 5xx (honouring Retry-After).
 * Returns the final Response for any non-retryable status (caller decides what to do).
 * Throws OlxBlockedError on the CloudFront HTML 403.
 */
export async function fetchWithRetry(req: RawRequest, deps: HttpDeps): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    // Content-Type only with a body: OLX answers 400 to GET requests that carry it.
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(req.url, { method: req.method, headers, body });
    } catch (err) {
      if (attempt >= deps.retry.maxRetries) throw err;
      const delay = backoffDelay(attempt, deps.retry, deps.random);
      deps.logger.warn({ err, url: req.url, attempt, delay }, 'OLX request failed (network), retrying');
      await deps.sleep(delay);
      continue;
    }

    if (isHtmlBlock(res)) {
      throw new OlxBlockedError(deps.now() + BLOCK_DURATION_MS);
    }

    if (isRetryableStatus(res.status) && attempt < deps.retry.maxRetries) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), deps.now());
      const delay =
        retryAfter !== null ? Math.min(retryAfter, deps.retry.maxRetryAfterMs) : backoffDelay(attempt, deps.retry, deps.random);
      deps.logger.warn({ url: req.url, status: res.status, attempt, delay }, 'OLX request throttled/failed, retrying');
      void res.body?.cancel().catch(() => undefined);
      await deps.sleep(delay);
      continue;
    }

    return res;
  }
}

/** Reads a response as JSON validated by `schema`, or throws OlxApiError for non-2xx. */
export async function parseResponse<S extends z.ZodType>(res: Response, schema: S | null, url: string): Promise<z.output<S>> {
  const body = await readBody(res);
  if (!res.ok) {
    throw new OlxApiError(res.status, `OLX ${res.status} for ${url}: ${describeError(body) ?? res.statusText}`, body);
  }
  if (!schema) return undefined as z.output<S>;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new OlxApiError(res.status, `Unexpected OLX response shape for ${url}: ${parsed.error.message}`, body);
  }
  return parsed.data;
}

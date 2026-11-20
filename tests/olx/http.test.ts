import { describe, expect, it } from 'vitest';
import { OlxApiError, OlxBlockedError } from '../../src/olx/errors.js';
import { backoffDelay, defaultRetry, describeError, fetchWithRetry, parseRetryAfter } from '../../src/olx/http.js';
import { json, makeHttpDeps, mockFetch } from '../helpers.js';

describe('backoffDelay', () => {
  it('grows exponentially, stays within [cap/2, cap] and respects max', () => {
    const opts = { ...defaultRetry, baseDelayMs: 1000, maxDelayMs: 10_000 };
    expect(backoffDelay(0, opts, () => 0)).toBe(500);
    expect(backoffDelay(0, opts, () => 1)).toBe(1000);
    expect(backoffDelay(3, opts, () => 0.5)).toBe(6000); // cap 8000
    expect(backoffDelay(10, opts, () => 1)).toBe(10_000);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  it('parses seconds', () => expect(parseRetryAfter('7', now)).toBe(7000));
  it('parses HTTP date', () => expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBe(3000));
  it('returns null for garbage/missing', () => {
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe('describeError', () => {
  it('handles OLX error shapes', () => {
    expect(describeError({ error: { status: 400, title: 'Invalid', detail: 'bad field' } })).toBe('Invalid: bad field');
    expect(describeError({ data: { error: { title: 'Nope' } } })).toBe('Nope');
    expect(describeError({ error: 'invalid_grant', error_description: 'expired' })).toBe('invalid_grant: expired');
  });
});

describe('fetchWithRetry', () => {
  it('does not send Content-Type on GET, sends JSON on POST', async () => {
    const m = mockFetch();
    m.enqueue(json([]), json({}));
    const { deps } = makeHttpDeps(m.fetch);
    await fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps);
    await fetchWithRetry({ method: 'POST', url: 'https://x.test/b', body: { text: 'hi' } }, deps);
    expect(m.calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(m.calls[1]!.headers['Content-Type']).toBe('application/json');
    expect(m.calls[1]!.body).toEqual({ text: 'hi' });
  });

  it('honours Retry-After on 429', async () => {
    const m = mockFetch();
    m.enqueue(json({}, 429, { 'retry-after': '2' }), json({ ok: 1 }));
    const { deps, sleeps } = makeHttpDeps(m.fetch);
    const res = await fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps);
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([2000]);
  });

  it('caps a huge Retry-After', async () => {
    const m = mockFetch();
    m.enqueue(json({}, 429, { 'retry-after': '99999' }), json({}));
    const { deps, sleeps } = makeHttpDeps(m.fetch);
    await fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps);
    expect(sleeps).toEqual([defaultRetry.maxRetryAfterMs]);
  });

  it('retries 5xx with backoff and finally returns the last response', async () => {
    const m = mockFetch();
    m.route('GET /a', json({}, 503));
    const { deps, sleeps } = makeHttpDeps(m.fetch, { retry: { ...defaultRetry, maxRetries: 3 } });
    const res = await fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps);
    expect(res.status).toBe(503);
    expect(m.calls).toHaveLength(4);
    expect(sleeps).toEqual([750, 1500, 3000]);
  });

  it('retries network errors', async () => {
    const m = mockFetch();
    m.enqueue(new TypeError('fetch failed'), json({}));
    const { deps } = makeHttpDeps(m.fetch);
    const res = await fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps);
    expect(res.status).toBe(200);
  });

  it('does not retry 4xx', async () => {
    const m = mockFetch();
    m.enqueue(json({ error: { title: 'bad' } }, 400));
    const { deps } = makeHttpDeps(m.fetch);
    const res = await fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps);
    expect(res.status).toBe(400);
    expect(m.calls).toHaveLength(1);
  });

  it('throws OlxBlockedError on CloudFront HTML 403', async () => {
    const m = mockFetch();
    m.enqueue(new Response('<html>The request could not be satisfied</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    const { deps } = makeHttpDeps(m.fetch);
    await expect(fetchWithRetry({ method: 'GET', url: 'https://x.test/a' }, deps)).rejects.toBeInstanceOf(OlxBlockedError);
  });

  it('OlxApiError is exported for consumers', () => {
    expect(new OlxApiError(400, 'x').status).toBe(400);
  });
});

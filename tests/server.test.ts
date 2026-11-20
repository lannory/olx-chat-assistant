import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../src/logger.js';
import { buildServer } from '../src/server.js';

function setup(exchange = vi.fn().mockResolvedValue({})) {
  const onAuthorized = vi.fn();
  const app = buildServer({
    oauth: { exchangeCode: exchange, hasTokens: () => true },
    logger: nullLogger,
    lastPollOkAt: () => Date.UTC(2026, 10, 19, 12, 0),
    pollIntervalSec: 90,
    onAuthorized,
    now: () => Date.UTC(2026, 10, 19, 12, 1),
  });
  return { app, exchange, onAuthorized };
}

describe('server', () => {
  it('GET /health', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', authorized: true, lastPollOkAt: '2026-11-19T12:00:00.000Z', pollStale: false });
  });

  it('OAuth callback exchanges the code and notifies', async () => {
    const { app, exchange, onAuthorized } = setup();
    const res = await app.inject({ method: 'GET', url: '/oauth/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Готово');
    expect(exchange).toHaveBeenCalledWith('abc', 'xyz');
    expect(onAuthorized).toHaveBeenCalledOnce();
  });

  it('OAuth callback reports errors without leaking markup', async () => {
    const { app } = setup(vi.fn().mockRejectedValue(new Error('Invalid or expired OAuth state <x>')));
    const res = await app.inject({ method: 'GET', url: '/oauth/callback?code=abc&state=bad' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('&lt;x&gt;');

    const denied = await app.inject({ method: 'GET', url: '/oauth/callback?error=access_denied' });
    expect(denied.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/oauth/callback' });
    expect(missing.statusCode).toBe(400);
  });

  it('has no public endpoint to start authorization', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/oauth/start' })).statusCode).toBe(404);
  });
});

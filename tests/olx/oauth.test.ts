import { describe, expect, it, vi } from 'vitest';
import { OlxAuthRequiredError } from '../../src/olx/errors.js';
import { OAuthService } from '../../src/olx/oauth.js';
import { json, makeHttpDeps, memoryDb, mockFetch } from '../helpers.js';

const cfg = {
  baseUrl: 'https://www.olx.ua',
  clientId: 'cid',
  clientSecret: 'secret',
  redirectUri: 'https://bot.example.com/oauth/callback',
  scope: 'v2 read write',
};

const tokenBody = (n: number) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 86400,
  token_type: 'bearer',
  scope: 'v2 read write',
});

function setup() {
  const m = mockFetch();
  const { deps } = makeHttpDeps(m.fetch);
  const db = memoryDb(deps.now);
  const oauth = new OAuthService(cfg, db, deps);
  return { m, deps, db, oauth };
}

describe('OAuthService', () => {
  it('builds the authorize URL with state, scope and redirect_uri', () => {
    const { oauth } = setup();
    const url = new URL(oauth.createAuthorizeUrl());
    expect(url.origin + url.pathname).toBe('https://www.olx.ua/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('v2 read write');
    expect(url.searchParams.get('redirect_uri')).toBe(cfg.redirectUri);
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects an unknown state without calling OLX', async () => {
    const { oauth, m } = setup();
    await expect(oauth.exchangeCode('code', 'forged')).rejects.toThrow(/state/);
    expect(m.calls).toHaveLength(0);
  });

  it('exchanges the code (JSON body) and stores tokens', async () => {
    const { oauth, m, db, deps } = setup();
    const state = new URL(oauth.createAuthorizeUrl()).searchParams.get('state')!;
    m.route('POST /api/open/oauth/token', json(tokenBody(1)));

    await oauth.exchangeCode('the-code', state);

    expect(m.calls[0]!.url).toBe('https://www.olx.ua/api/open/oauth/token');
    expect(m.calls[0]!.body).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cid',
      client_secret: 'secret',
      code: 'the-code',
      scope: 'v2 read write',
      redirect_uri: cfg.redirectUri,
    });
    expect(db.getTokens()).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: deps.now() + 86400_000,
      scope: 'v2 read write',
    });
    // state is single-use
    await expect(oauth.exchangeCode('the-code', state)).rejects.toThrow(/state/);
  });

  it('getAccessToken throws OlxAuthRequiredError when there are no tokens', async () => {
    const { oauth } = setup();
    await expect(oauth.getAccessToken()).rejects.toBeInstanceOf(OlxAuthRequiredError);
  });

  it('returns the stored token while valid and refreshes proactively near expiry', async () => {
    const { oauth, db, deps, m } = setup();
    db.saveTokens({ accessToken: 'a0', refreshToken: 'r0', expiresAt: deps.now() + 3600_000, scope: null });
    expect(await oauth.getAccessToken()).toBe('a0');

    db.saveTokens({ accessToken: 'a0', refreshToken: 'r0', expiresAt: deps.now() + 60_000, scope: null });
    m.route('POST /api/open/oauth/token', json(tokenBody(2)));
    expect(await oauth.getAccessToken()).toBe('access-2');
    expect(m.calls[0]!.body).toEqual({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'secret',
      refresh_token: 'r0',
    });
    expect(db.getTokens()!.refreshToken).toBe('refresh-2'); // rotated refresh token persisted
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    const { oauth, db, deps, m } = setup();
    db.saveTokens({ accessToken: 'a0', refreshToken: 'r0', expiresAt: deps.now() - 1, scope: null });
    m.route('POST /api/open/oauth/token', json(tokenBody(3)));
    const [a, b] = await Promise.all([oauth.getAccessToken(), oauth.getAccessToken()]);
    expect(a).toBe('access-3');
    expect(b).toBe('access-3');
    expect(m.calls).toHaveLength(1);
  });

  it('fires onAuthFailure and throws OlxAuthRequiredError on invalid_grant', async () => {
    const { oauth, db, deps, m } = setup();
    db.saveTokens({ accessToken: 'a0', refreshToken: 'r0', expiresAt: deps.now() - 1, scope: null });
    m.route('POST /api/open/oauth/token', json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400));
    const handler = vi.fn();
    oauth.onAuthFailure(handler);
    await expect(oauth.refresh()).rejects.toBeInstanceOf(OlxAuthRequiredError);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]![0]).toMatch(/invalid_grant/);
  });

  it('does not fire onAuthFailure on transient errors', async () => {
    const { oauth, db, deps, m } = setup();
    db.saveTokens({ accessToken: 'a0', refreshToken: 'r0', expiresAt: deps.now() - 1, scope: null });
    m.route('POST /api/open/oauth/token', json({}, 502));
    const handler = vi.fn();
    oauth.onAuthFailure(handler);
    await expect(oauth.refresh()).rejects.toThrow(/502/);
    expect(handler).not.toHaveBeenCalled();
  });
});

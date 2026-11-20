import { describe, expect, it } from 'vitest';
import { OlxApiError } from '../../src/olx/errors.js';
import { OAuthService } from '../../src/olx/oauth.js';
import { OlxClient } from '../../src/olx/olxClient.js';
import { json, makeHttpDeps, memoryDb, mockFetch } from '../helpers.js';

const T1 = '550e8400-e29b-41d4-a716-446655440000';

function setup() {
  const m = mockFetch();
  const { deps } = makeHttpDeps(m.fetch);
  const db = memoryDb(deps.now);
  db.saveTokens({ accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: deps.now() + 3600_000, scope: null });
  const oauth = new OAuthService(
    { baseUrl: 'https://www.olx.ua', clientId: 'c', clientSecret: 's', redirectUri: 'https://x.test/cb', scope: 'v2 read write' },
    db,
    deps,
  );
  const client = new OlxClient('https://www.olx.ua', oauth, deps);
  return { m, db, client };
}

const thread = (n: number, extra: Record<string, unknown> = {}) => ({
  id: n,
  uuid: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  advert_id: 100 + n,
  interlocutor_id: 200 + n,
  total_count: 3,
  unread_count: 1,
  created_at: '2026-11-19 10:00:00',
  is_favourite: false,
  ...extra,
});

describe('OlxClient', () => {
  it('sends Authorization and Version headers', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/threads', json([thread(1)]));
    await client.listThreads({ limit: 10, offset: 0 });
    const call = m.calls[0]!;
    expect(call.url).toBe('https://www.olx.ua/api/partner/threads?offset=0&limit=10');
    expect(call.headers.Authorization).toBe('Bearer tok-1');
    expect(call.headers.Version).toBe('2.0');
  });

  it('parses threads as a plain array and as {data: [...]}, preferring uuid', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/threads', json([thread(1)]), json({ data: [thread(2)] }));
    const a = await client.listThreads();
    const b = await client.listThreads();
    expect(a[0]).toMatchObject({ key: thread(1).uuid, legacyId: 1, advertId: 101, unreadCount: 1, totalCount: 3 });
    expect(b[0]!.key).toBe(thread(2).uuid);
  });

  it('falls back to numeric id when uuid is missing', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/threads', json([{ ...thread(5), uuid: undefined }]));
    expect((await client.listThreads())[0]!.key).toBe('5');
  });

  it('paginates listAllThreads until a short page', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/threads', json([thread(1), thread(2)]), json([thread(3)]));
    const all = await client.listAllThreads(2);
    expect(all.map((t) => t.legacyId)).toEqual([1, 2, 3]);
    expect(m.calls.map((c) => new URL(c.url).search)).toEqual(['?offset=0&limit=2', '?offset=2&limit=2']);
  });

  it('stops paginating when the server ignores offset', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/threads', json([thread(1), thread(2)]));
    const all = await client.listAllThreads(2);
    expect(all).toHaveLength(2);
    expect(m.calls).toHaveLength(2);
  });

  it('parses messages including attachments and null text', async () => {
    const { m, client } = setup();
    m.route(
      `GET /api/partner/threads/${T1}/messages`,
      json([
        { id: 1, uuid: 'm1', thread_uuid: T1, created_at: '2026-11-19 10:00:00', type: 'received', text: 'Актуально?', is_read: false, attachments: null },
        { id: 2, uuid: 'm2', thread_uuid: T1, created_at: '2026-11-19 10:01:00', type: 'received', text: null, is_read: false, attachments: [{ name: 'a.jpg', url: 'https://x' }] },
      ]),
    );
    const msgs = await client.getMessages(T1);
    expect(msgs[0]).toMatchObject({ key: 'm1', type: 'received', text: 'Актуально?', hasAttachments: false });
    expect(msgs[1]).toMatchObject({ key: 'm2', text: '', hasAttachments: true });
  });

  it('posts a message and a mark-as-read command', async () => {
    const { m, client } = setup();
    m.route(`POST /api/partner/threads/${T1}/messages`, new Response(null, { status: 200 }));
    m.route(`POST /api/partner/threads/${T1}/commands`, new Response(null, { status: 204 }));
    await client.sendMessage(T1, 'Так, актуально');
    await client.markAsRead(T1);
    expect(m.calls[0]!.body).toEqual({ text: 'Так, актуально' });
    expect(m.calls[1]!.body).toEqual({ command: 'mark-as-read' });
  });

  it('unwraps advert from {data}', async () => {
    const { m, client } = setup();
    m.route(
      'GET /api/partner/adverts/123',
      json({ data: { id: 123, title: 'Lenovo ThinkPad T480', description: 'Стан ідеальний', url: 'https://www.olx.ua/d/obyavlenie/x.html', status: 'active', price: { value: 9000, currency: 'UAH', negotiable: true } } }),
    );
    expect(await client.getAdvert(123)).toEqual({
      id: 123,
      title: 'Lenovo ThinkPad T480',
      description: 'Стан ідеальний',
      url: 'https://www.olx.ua/d/obyavlenie/x.html',
      status: 'active',
      priceValue: 9000,
      priceCurrency: 'UAH',
      negotiable: true,
    });
  });

  it('on 401 refreshes the token and retries exactly once', async () => {
    const { m, client, db } = setup();
    m.route('GET /api/partner/users/7', json({ error: 'invalid_token' }, 401), json({ data: { id: 7, name: 'Олег' } }));
    m.route('POST /api/open/oauth/token', json({ access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 86400 }));
    const user = await client.getUser(7);
    expect(user).toEqual({ id: 7, name: 'Олег' });
    const userCalls = m.calls.filter((c) => c.url.includes('/users/7'));
    expect(userCalls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(db.getTokens()!.refreshToken).toBe('ref-2');
  });

  it('gives up after a second 401', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/users/7', json({ error: 'invalid_token' }, 401));
    m.route('POST /api/open/oauth/token', json({ access_token: 'tok-2', refresh_token: 'ref-2', expires_in: 86400 }));
    await expect(client.getUser(7)).rejects.toMatchObject({ status: 401 });
    expect(m.calls.filter((c) => c.url.includes('/oauth/token'))).toHaveLength(1);
  });

  it('throws OlxApiError on unexpected response shape', async () => {
    const { m, client } = setup();
    m.route('GET /api/partner/threads', json({ unexpected: true }));
    await expect(client.listThreads()).rejects.toBeInstanceOf(OlxApiError);
  });
});

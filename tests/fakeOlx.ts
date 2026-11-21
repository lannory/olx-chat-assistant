import type { OlxApi } from '../src/olx/olxClient.js';
import type { OlxAdvert, OlxMessage, OlxThread, OlxUser } from '../src/olx/schemas.js';

/** In-memory OLX used by poller/processor tests. */
export class FakeOlx implements OlxApi {
  threads: OlxThread[] = [];
  messages = new Map<string, OlxMessage[]>();
  adverts = new Map<number, OlxAdvert>();
  users = new Map<number, OlxUser>();
  sent: { threadId: string; text: string; photos?: string[] }[] = [];
  markedRead: string[] = [];
  calls: string[] = [];
  failMessagesFor = new Set<string>();
  private seq = 0;

  addThread(key: string, opts: Partial<OlxThread> = {}): OlxThread {
    const t: OlxThread = {
      key,
      legacyId: null,
      advertId: 1,
      interlocutorId: 10,
      totalCount: 0,
      unreadCount: 0,
      createdAt: '2026-11-19 10:00:00',
      isFavourite: false,
      ...opts,
    };
    this.threads.push(t);
    this.messages.set(key, []);
    return t;
  }

  /** Simulates a new message arriving; updates counters like OLX does. */
  addMessage(threadKey: string, type: 'sent' | 'received', text: string, createdAt = '2026-11-19 12:00:00', extra: Partial<OlxMessage> = {}) {
    const list = this.messages.get(threadKey)!;
    const m: OlxMessage = {
      key: `${threadKey}-m${++this.seq}`,
      type,
      text,
      createdAt,
      isRead: type === 'sent',
      attachments: [],
      hasAttachments: false,
      ...extra,
    };
    list.push(m);
    const t = this.threads.find((x) => x.key === threadKey)!;
    t.totalCount = list.length;
    if (type === 'received') t.unreadCount++;
    return m;
  }

  async listThreads(): Promise<OlxThread[]> {
    return this.listAllThreads();
  }

  async listAllThreads(): Promise<OlxThread[]> {
    this.calls.push('listAllThreads');
    return this.threads.map((t) => ({ ...t }));
  }

  async getThread(threadId: string): Promise<OlxThread> {
    return { ...this.threads.find((t) => t.key === threadId)! };
  }

  async getMessages(threadId: string): Promise<OlxMessage[]> {
    this.calls.push(`getMessages ${threadId}`);
    if (this.failMessagesFor.has(threadId)) throw new Error('boom');
    return [...(this.messages.get(threadId) ?? [])];
  }

  async sendMessage(threadId: string, text: string, photos: readonly string[] = []): Promise<void> {
    this.sent.push(photos.length ? { threadId, text, photos: [...photos] } : { threadId, text });
    this.addMessage(threadId, 'sent', text);
  }

  async markAsRead(threadId: string): Promise<void> {
    this.markedRead.push(threadId);
    const t = this.threads.find((x) => x.key === threadId);
    if (t) t.unreadCount = 0;
  }

  async getAdvert(advertId: number): Promise<OlxAdvert> {
    const a = this.adverts.get(advertId);
    if (!a) throw new Error(`no advert ${advertId}`);
    return a;
  }

  async getUser(userId: number): Promise<OlxUser> {
    return this.users.get(userId) ?? { id: userId, name: null };
  }
}

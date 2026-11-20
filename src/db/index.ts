/**
 * The only module that talks SQL. Everything else uses the typed methods of {@link Db}.
 * To move to PostgreSQL, re-implement this class (same method signatures, async-ify if needed).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.js';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string | null;
}

export interface ThreadRow {
  uuid: string;
  legacyId: number | null;
  advertId: number;
  interlocutorId: number;
  interlocutorName: string | null;
  totalCount: number;
  unreadCount: number;
  lastSeenTotal: number;
  ignored: boolean;
  lastOwnerMsgAt: number | null;
}

export type MessageAuthor = 'buyer' | 'owner' | 'bot';

export interface MessageRow {
  uuid: string;
  threadUuid: string;
  type: 'sent' | 'received';
  author: MessageAuthor | null;
  text: string;
  hasAttachments: boolean;
  createdAt: number;
  processedAt: number | null;
}

export type DraftStatus = 'pending' | 'scheduled' | 'sent' | 'skipped' | 'superseded';
export type DraftSource = 'rule' | 'llm';

export interface DraftRow {
  id: number;
  threadUuid: string;
  messageUuid: string;
  intent: string;
  text: string;
  source: DraftSource;
  status: DraftStatus;
  scheduledFor: number | null;
  tgChatId: number | null;
  tgMessageId: number | null;
  createdAt: number;
}

export interface AdvertRow {
  id: number;
  title: string;
  description: string;
  priceValue: number | null;
  priceCurrency: string | null;
  negotiable: boolean | null;
  url: string | null;
  status: string | null;
  fetchedAt: number;
}

export interface TgLink {
  threadUuid: string;
  draftId: number | null;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toThread(r: Row): ThreadRow {
  return {
    uuid: String(r.uuid),
    legacyId: num(r.legacy_id),
    advertId: Number(r.advert_id),
    interlocutorId: Number(r.interlocutor_id),
    interlocutorName: (r.interlocutor_name as string | null) ?? null,
    totalCount: Number(r.total_count),
    unreadCount: Number(r.unread_count),
    lastSeenTotal: Number(r.last_seen_total),
    ignored: Number(r.ignored) === 1,
    lastOwnerMsgAt: num(r.last_owner_msg_at),
  };
}

function toMessage(r: Row): MessageRow {
  return {
    uuid: String(r.uuid),
    threadUuid: String(r.thread_uuid),
    type: r.type as MessageRow['type'],
    author: (r.author as MessageAuthor | null) ?? null,
    text: String(r.text ?? ''),
    hasAttachments: Number(r.has_attachments) === 1,
    createdAt: Number(r.created_at),
    processedAt: num(r.processed_at),
  };
}

function toDraft(r: Row): DraftRow {
  return {
    id: Number(r.id),
    threadUuid: String(r.thread_uuid),
    messageUuid: String(r.message_uuid),
    intent: String(r.intent),
    text: String(r.text),
    source: r.source as DraftSource,
    status: r.status as DraftStatus,
    scheduledFor: num(r.scheduled_for),
    tgChatId: num(r.tg_chat_id),
    tgMessageId: num(r.tg_message_id),
    createdAt: Number(r.created_at),
  };
}

function toAdvert(r: Row): AdvertRow {
  return {
    id: Number(r.id),
    title: String(r.title),
    description: String(r.description ?? ''),
    priceValue: num(r.price_value),
    priceCurrency: (r.price_currency as string | null) ?? null,
    negotiable: r.negotiable === null || r.negotiable === undefined ? null : Number(r.negotiable) === 1,
    url: (r.url as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    fetchedAt: Number(r.fetched_at),
  };
}

export class Db {
  private readonly db: Database.Database;

  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    for (let v = current; v < migrations.length; v++) {
      const sql = migrations[v]!;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- OAuth ----------

  getTokens(): StoredTokens | null {
    const r = this.db.prepare('SELECT * FROM oauth_tokens WHERE id = 1').get() as Row | undefined;
    if (!r) return null;
    return {
      accessToken: String(r.access_token),
      refreshToken: String(r.refresh_token),
      expiresAt: Number(r.expires_at),
      scope: (r.scope as string | null) ?? null,
    };
  }

  saveTokens(t: StoredTokens): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (id, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (1, @accessToken, @refreshToken, @expiresAt, @scope, @now)
         ON CONFLICT (id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at, scope = excluded.scope, updated_at = excluded.updated_at`,
      )
      .run({ ...t, now: this.now() });
  }

  createOAuthState(state: string): void {
    this.db.prepare('INSERT INTO oauth_states (state, created_at) VALUES (?, ?)').run(state, this.now());
  }

  /** Returns true if the state existed and was younger than maxAgeMs. The state is deleted either way. */
  consumeOAuthState(state: string, maxAgeMs: number): boolean {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT created_at FROM oauth_states WHERE state = ?').get(state) as Row | undefined;
      this.db.prepare('DELETE FROM oauth_states WHERE state = ? OR created_at < ?').run(state, this.now() - maxAgeMs);
      return !!r && this.now() - Number(r.created_at) <= maxAgeMs;
    });
  }

  // ---------- Settings ----------

  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // ---------- Threads ----------

  getThread(uuid: string): ThreadRow | null {
    const r = this.db.prepare('SELECT * FROM threads WHERE uuid = ?').get(uuid) as Row | undefined;
    return r ? toThread(r) : null;
  }

  /** Inserts or refreshes counters from the API. Never touches last_seen_total / ignored / owner timestamps. */
  upsertThread(t: {
    uuid: string;
    legacyId: number | null;
    advertId: number;
    interlocutorId: number;
    totalCount: number;
    unreadCount: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO threads (uuid, legacy_id, advert_id, interlocutor_id, total_count, unread_count, updated_at)
         VALUES (@uuid, @legacyId, @advertId, @interlocutorId, @totalCount, @unreadCount, @now)
         ON CONFLICT (uuid) DO UPDATE SET legacy_id = excluded.legacy_id, total_count = excluded.total_count,
           unread_count = excluded.unread_count, updated_at = excluded.updated_at`,
      )
      .run({ ...t, now: this.now() });
  }

  setThreadSeenTotal(uuid: string, total: number): void {
    this.db.prepare('UPDATE threads SET last_seen_total = ? WHERE uuid = ?').run(total, uuid);
  }

  setThreadIgnored(uuid: string, ignored: boolean): void {
    this.db.prepare('UPDATE threads SET ignored = ? WHERE uuid = ?').run(ignored ? 1 : 0, uuid);
  }

  setInterlocutorName(uuid: string, name: string): void {
    this.db.prepare('UPDATE threads SET interlocutor_name = ? WHERE uuid = ?').run(name, uuid);
  }

  /** Keeps the max of the stored and given timestamp. */
  touchOwnerMessage(uuid: string, at: number): void {
    this.db
      .prepare(
        `UPDATE threads SET last_owner_msg_at = CASE
           WHEN last_owner_msg_at IS NULL OR last_owner_msg_at < @at THEN @at ELSE last_owner_msg_at END
         WHERE uuid = @uuid`,
      )
      .run({ uuid, at });
  }

  countUnreadThreads(): { threads: number; messages: number } {
    const r = this.db
      .prepare('SELECT COUNT(*) AS t, COALESCE(SUM(unread_count), 0) AS m FROM threads WHERE unread_count > 0 AND ignored = 0')
      .get() as Row;
    return { threads: Number(r.t), messages: Number(r.m) };
  }

  // ---------- Messages ----------

  hasMessage(uuid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE uuid = ?').get(uuid);
  }

  /** Inserts a message if unknown. Returns true when it was new. */
  insertMessage(m: Omit<MessageRow, 'processedAt'> & { processedAt?: number | null }): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO messages (uuid, thread_uuid, type, author, text, has_attachments, created_at, processed_at)
         VALUES (@uuid, @threadUuid, @type, @author, @text, @hasAttachments, @createdAt, @processedAt)
         ON CONFLICT (uuid) DO NOTHING`,
      )
      .run({ ...m, hasAttachments: m.hasAttachments ? 1 : 0, processedAt: m.processedAt ?? null });
    return res.changes > 0;
  }

  markMessageProcessed(uuid: string): void {
    this.db.prepare('UPDATE messages SET processed_at = ? WHERE uuid = ? AND processed_at IS NULL').run(this.now(), uuid);
  }

  /** Received messages that were stored but not handled yet (e.g. crash mid-processing), oldest first. */
  listUnprocessedMessages(threadUuid: string): MessageRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE thread_uuid = ? AND processed_at IS NULL AND type = 'received'
           ORDER BY created_at, rowid`,
        )
        .all(threadUuid) as Row[]
    ).map(toMessage);
  }

  lastMessages(threadUuid: string, limit: number): MessageRow[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE thread_uuid = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(threadUuid, limit) as Row[]
    )
      .map(toMessage)
      .reverse();
  }

  /**
   * True once the seller side has (or is about to have) a message in the thread: a sent message seen
   * in OLX, something this service posted, or a draft that is open or already sent. Used to greet
   * the buyer only in the first reply.
   */
  sellerHasWritten(threadUuid: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM messages WHERE thread_uuid = @t AND type = 'sent')
            OR EXISTS (SELECT 1 FROM outgoing WHERE thread_uuid = @t)
            OR EXISTS (SELECT 1 FROM drafts WHERE thread_uuid = @t AND status IN ('pending', 'scheduled', 'sent'))`,
      )
      .get({ t: threadUuid });
  }

  // ---------- Outgoing (what this service posted) ----------

  /** Records a message about to be posted; returns its id so a failed send can be rolled back. */
  recordOutgoing(threadUuid: string, text: string, author: 'bot' | 'owner'): number {
    const res = this.db
      .prepare('INSERT INTO outgoing (thread_uuid, text, author, sent_at) VALUES (?, ?, ?, ?)')
      .run(threadUuid, text.trim(), author, this.now());
    return Number(res.lastInsertRowid);
  }

  deleteOutgoing(id: number): void {
    this.db.prepare('DELETE FROM outgoing WHERE id = ?').run(id);
  }

  /**
   * Finds an unmatched outgoing record with the same text in the thread, marks it as matched to
   * messageUuid and returns its author. Returns null if the message was not posted by this service.
   */
  matchOutgoing(threadUuid: string, text: string, messageUuid: string): 'bot' | 'owner' | null {
    return this.transaction(() => {
      const r = this.db
        .prepare(
          `SELECT id, author FROM outgoing WHERE thread_uuid = ? AND text = ? AND matched_uuid IS NULL
           ORDER BY sent_at LIMIT 1`,
        )
        .get(threadUuid, text.trim()) as Row | undefined;
      if (!r) return null;
      this.db.prepare('UPDATE outgoing SET matched_uuid = ? WHERE id = ?').run(messageUuid, r.id);
      return r.author as 'bot' | 'owner';
    });
  }

  // ---------- Auto replies ----------

  hasAutoReplied(threadUuid: string, intent: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM auto_replies WHERE thread_uuid = ? AND intent = ?').get(threadUuid, intent);
  }

  /** Returns false if a reply for this intent was already recorded (race-safe guard). */
  recordAutoReply(threadUuid: string, intent: string, messageUuid: string): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO auto_replies (thread_uuid, intent, message_uuid, sent_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_uuid, intent) DO NOTHING`,
      )
      .run(threadUuid, intent, messageUuid, this.now());
    return res.changes > 0;
  }

  // ---------- Drafts ----------

  createDraft(d: {
    threadUuid: string;
    messageUuid: string;
    intent: string;
    text: string;
    source: DraftSource;
    status: DraftStatus;
    scheduledFor?: number | null;
  }): DraftRow {
    const now = this.now();
    const res = this.db
      .prepare(
        `INSERT INTO drafts (thread_uuid, message_uuid, intent, text, source, status, scheduled_for, created_at, updated_at)
         VALUES (@threadUuid, @messageUuid, @intent, @text, @source, @status, @scheduledFor, @now, @now)`,
      )
      .run({ ...d, scheduledFor: d.scheduledFor ?? null, now });
    return this.getDraft(Number(res.lastInsertRowid))!;
  }

  getDraft(id: number): DraftRow | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Row | undefined;
    return r ? toDraft(r) : null;
  }

  /**
   * Atomically moves a draft from one of `from` statuses to `to`. Returns false if the draft was
   * not in an expected status (e.g. a double click on "Send").
   */
  transitionDraft(id: number, from: DraftStatus[], to: DraftStatus): boolean {
    const placeholders = from.map(() => '?').join(',');
    const res = this.db
      .prepare(`UPDATE drafts SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(to, this.now(), id, ...from);
    return res.changes > 0;
  }

  updateDraftText(id: number, text: string): void {
    this.db.prepare('UPDATE drafts SET text = ?, updated_at = ? WHERE id = ?').run(text, this.now(), id);
  }

  setDraftTelegramMessage(id: number, chatId: number, messageId: number): void {
    this.db.prepare('UPDATE drafts SET tg_chat_id = ?, tg_message_id = ? WHERE id = ?').run(chatId, messageId, id);
  }

  listDueScheduledDrafts(now: number): DraftRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM drafts WHERE status = 'scheduled' AND scheduled_for <= ? ORDER BY scheduled_for, id`)
        .all(now) as Row[]
    ).map(toDraft);
  }

  listOpenDraftsForThread(threadUuid: string): DraftRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM drafts WHERE thread_uuid = ? AND status IN ('pending', 'scheduled') ORDER BY id`)
        .all(threadUuid) as Row[]
    ).map(toDraft);
  }

  // ---------- Telegram links ----------

  linkTelegramMessage(chatId: number, messageId: number, threadUuid: string, draftId: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO tg_links (tg_chat_id, tg_message_id, thread_uuid, draft_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tg_chat_id, tg_message_id) DO UPDATE SET thread_uuid = excluded.thread_uuid, draft_id = excluded.draft_id`,
      )
      .run(chatId, messageId, threadUuid, draftId, this.now());
  }

  /** All Telegram messages (in every allowed chat) that show the given draft. */
  listTelegramLinksForDraft(draftId: number): { chatId: number; messageId: number }[] {
    return (
      this.db.prepare('SELECT tg_chat_id, tg_message_id FROM tg_links WHERE draft_id = ?').all(draftId) as Row[]
    ).map((r) => ({ chatId: Number(r.tg_chat_id), messageId: Number(r.tg_message_id) }));
  }

  deleteAutoReply(threadUuid: string, intent: string): void {
    this.db.prepare('DELETE FROM auto_replies WHERE thread_uuid = ? AND intent = ?').run(threadUuid, intent);
  }

  listAutoRepliedIntents(threadUuid: string): string[] {
    return (this.db.prepare('SELECT intent FROM auto_replies WHERE thread_uuid = ?').all(threadUuid) as Row[]).map((r) =>
      String(r.intent),
    );
  }

  countDraftsByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status').all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  }

  getTelegramLink(chatId: number, messageId: number): TgLink | null {
    const r = this.db
      .prepare('SELECT thread_uuid, draft_id FROM tg_links WHERE tg_chat_id = ? AND tg_message_id = ?')
      .get(chatId, messageId) as Row | undefined;
    return r ? { threadUuid: String(r.thread_uuid), draftId: num(r.draft_id) } : null;
  }

  // ---------- Adverts cache ----------

  getAdvert(id: number): AdvertRow | null {
    const r = this.db.prepare('SELECT * FROM adverts_cache WHERE id = ?').get(id) as Row | undefined;
    return r ? toAdvert(r) : null;
  }

  upsertAdvert(a: Omit<AdvertRow, 'fetchedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO adverts_cache (id, title, description, price_value, price_currency, negotiable, url, status, fetched_at)
         VALUES (@id, @title, @description, @priceValue, @priceCurrency, @negotiable, @url, @status, @now)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, description = excluded.description,
           price_value = excluded.price_value, price_currency = excluded.price_currency, negotiable = excluded.negotiable,
           url = excluded.url, status = excluded.status, fetched_at = excluded.fetched_at`,
      )
      .run({ ...a, negotiable: a.negotiable === null ? null : a.negotiable ? 1 : 0, now: this.now() });
  }
}

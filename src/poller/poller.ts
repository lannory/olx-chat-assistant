/**
 * Periodically pulls OLX threads, stores new messages (deduplicated by uuid across restarts) and hands
 * unprocessed buyer messages to the processor.
 *
 * A thread is fetched when it is new, its total_count changed since the last successful pass, or it
 * has unread messages. The very first pass is a baseline: existing history is stored as already
 * processed, so the bot never answers old conversations after the first start.
 */
import type { Db, MessageAuthor, ThreadRow, MessageRow } from '../db/index.js';
import type { Logger } from '../logger.js';
import { OlxAuthRequiredError, OlxBlockedError } from '../olx/errors.js';
import type { OlxApi } from '../olx/olxClient.js';
import type { OlxMessage, OlxThread } from '../olx/schemas.js';
import { parseOlxDate } from '../time.js';

export interface MessageProcessor {
  /** Handles new buyer messages of one thread (oldest first). Must mark them processed. */
  handleNewMessages(thread: ThreadRow, messages: MessageRow[]): Promise<void>;
}

export type PollAlert =
  | { kind: 'auth_required'; reason: string }
  | { kind: 'blocked'; retryAt: number }
  | { kind: 'failing'; consecutiveFailures: number; error: string }
  | { kind: 'recovered' }
  | { kind: 'baseline'; threads: number; unreadThreads: number };

export interface PollerDeps {
  db: Db;
  olx: OlxApi;
  processor: MessageProcessor;
  logger: Logger;
  timezone: string;
  now?: () => number;
  onAlert?: (alert: PollAlert) => void | Promise<void>;
  /** Called after each pass (used for scheduled sends). */
  afterPoll?: () => Promise<void>;
}

export interface PollStats {
  threads: number;
  fetchedThreads: number;
  newMessages: number;
  processedThreads: number;
  failedThreads: number;
  baseline: boolean;
}

export const SETTING_BASELINE_DONE = 'baseline_done';
export const SETTING_LAST_POLL_OK = 'last_poll_ok_at';
export const SETTING_PAUSED = 'paused';

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;
  private blockedUntil = 0;
  private consecutiveFailures = 0;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get isPaused(): boolean {
    return this.deps.db.getSetting(SETTING_PAUSED) === '1';
  }

  setPaused(paused: boolean): void {
    this.deps.db.setSetting(SETTING_PAUSED, paused ? '1' : '0');
  }

  lastSuccessAt(): number | null {
    const v = this.deps.db.getSetting(SETTING_LAST_POLL_OK);
    return v ? Number(v) : null;
  }

  start(intervalSec: number): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      this.running = this.tick();
      await this.running;
      this.running = null;
      if (!this.stopped) this.timer = setTimeout(loop, intervalSec * 1000);
    };
    void loop();
  }

  /** Stops scheduling and waits for an in-flight pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One scheduled iteration: respects pause/block, never throws. */
  async tick(): Promise<void> {
    if (this.isPaused) return;
    if (this.now() < this.blockedUntil) return;
    try {
      await this.pollOnce();
      if (this.consecutiveFailures > 0) {
        if (this.consecutiveFailures >= 3) await this.alert({ kind: 'recovered' });
        this.consecutiveFailures = 0;
      }
      await this.deps.afterPoll?.();
    } catch (err) {
      await this.handlePollError(err);
    }
  }

  private async handlePollError(err: unknown): Promise<void> {
    if (err instanceof OlxAuthRequiredError) {
      this.deps.logger.warn({ err: err.message }, 'poll skipped: OLX authorization required');
      await this.alert({ kind: 'auth_required', reason: err.message });
      return;
    }
    if (err instanceof OlxBlockedError) {
      this.blockedUntil = err.retryAt;
      this.deps.logger.error({ retryAt: new Date(err.retryAt).toISOString() }, 'OLX blocked our IP; pausing polling');
      await this.alert({ kind: 'blocked', retryAt: err.retryAt });
      return;
    }
    this.consecutiveFailures++;
    this.deps.logger.error({ err, consecutiveFailures: this.consecutiveFailures }, 'poll failed');
    if (this.consecutiveFailures === 3 || this.consecutiveFailures % 20 === 0) {
      await this.alert({ kind: 'failing', consecutiveFailures: this.consecutiveFailures, error: String((err as Error)?.message ?? err) });
    }
  }

  private async alert(a: PollAlert): Promise<void> {
    try {
      await this.deps.onAlert?.(a);
    } catch (err) {
      this.deps.logger.error({ err }, 'alert handler failed');
    }
  }

  /** A single pass over all threads. Throws on errors that affect the whole pass. */
  async pollOnce(): Promise<PollStats> {
    const { db, olx, logger } = this.deps;
    const baseline = db.getSetting(SETTING_BASELINE_DONE) !== '1';
    const threads = await olx.listAllThreads();
    const stats: PollStats = {
      threads: threads.length,
      fetchedThreads: 0,
      newMessages: 0,
      processedThreads: 0,
      failedThreads: 0,
      baseline,
    };

    for (const t of threads) {
      try {
        await this.syncThread(t, baseline, stats);
      } catch (err) {
        if (err instanceof OlxAuthRequiredError || err instanceof OlxBlockedError) throw err;
        stats.failedThreads++;
        logger.error({ err, thread: t.key }, 'failed to sync thread; will retry next poll');
      }
    }

    if (baseline && stats.failedThreads === 0) {
      db.setSetting(SETTING_BASELINE_DONE, '1');
      await this.alert({ kind: 'baseline', threads: threads.length, unreadThreads: threads.filter((t) => t.unreadCount > 0).length });
    }
    db.setSetting(SETTING_LAST_POLL_OK, String(this.now()));
    logger.info(stats, 'poll finished');
    return stats;
  }

  private async syncThread(t: OlxThread, baseline: boolean, stats: PollStats): Promise<void> {
    const { db, olx } = this.deps;
    const existing = db.getThread(t.key);
    db.upsertThread({
      uuid: t.key,
      legacyId: t.legacyId,
      advertId: t.advertId,
      interlocutorId: t.interlocutorId,
      totalCount: t.totalCount,
      unreadCount: t.unreadCount,
    });

    const changed = !existing || existing.lastSeenTotal !== t.totalCount || t.unreadCount > 0;
    if (!changed) return;

    if (existing?.ignored) {
      db.setThreadSeenTotal(t.key, t.totalCount);
      return;
    }

    stats.fetchedThreads++;
    const messages = await olx.getMessages(t.key);
    stats.newMessages += this.storeMessages(t.key, messages, baseline);

    if (!baseline) {
      const pending = db.listUnprocessedMessages(t.key);
      if (pending.length > 0) {
        await this.deps.processor.handleNewMessages(db.getThread(t.key)!, pending);
        stats.processedThreads++;
      }
    }
    db.setThreadSeenTotal(t.key, t.totalCount);
  }

  /** Stores unknown messages; returns how many were new. */
  private storeMessages(threadUuid: string, messages: OlxMessage[], baseline: boolean): number {
    const { db, timezone } = this.deps;
    const now = this.now();
    const sorted = messages
      .map((m, i) => ({ m, i, at: parseOlxDate(m.createdAt, timezone) ?? now }))
      .sort((a, b) => a.at - b.at || a.i - b.i);

    let added = 0;
    db.transaction(() => {
      for (const { m, at } of sorted) {
        if (db.hasMessage(m.key)) continue;
        let author: MessageAuthor | null;
        if (m.type === 'received') author = 'buyer';
        else if (m.type === 'sent') author = db.matchOutgoing(threadUuid, m.text, m.key) ?? 'owner';
        else author = null; // unknown type: store for history, never act on it

        if (author === 'owner') db.touchOwnerMessage(threadUuid, Math.min(at, now));

        db.insertMessage({
          uuid: m.key,
          threadUuid,
          type: m.type === 'sent' ? 'sent' : 'received',
          author,
          text: m.text,
          hasAttachments: m.hasAttachments,
          createdAt: at,
          processedAt: baseline || author !== 'buyer' ? now : null,
        });
        added++;
      }
    });
    return added;
  }
}

/**
 * Draft lifecycle: send / skip / supersede, and dispatch of drafts postponed by quiet hours.
 * Status transitions are atomic in the DB, so double clicks or a click racing the scheduler can't
 * send the same draft twice.
 */
import type { Db, DraftRow, DraftStatus } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { Notifier } from '../notify.js';
import { AUTO_INTENTS, type Intent } from '../rules/classifier.js';
import type { RuntimeSettings } from '../settings.js';
import type { OlxSender } from './sender.js';

export type SendResult = { ok: true; draft: DraftRow } | { ok: false; error: string; draft: DraftRow | null };

/** How a draft got sent: decides who counts as the author (owner messages start the cooldown). */
export type SendTrigger = 'auto' | 'schedule' | 'button' | 'edit';

const OPEN: DraftStatus[] = ['pending', 'scheduled'];

export function draftIntents(d: Pick<DraftRow, 'intent' | 'source'>): Intent[] {
  if (d.source !== 'rule') return [];
  return d.intent.split(',').filter((i): i is Intent => (AUTO_INTENTS as readonly string[]).includes(i));
}

export class ReplyService {
  constructor(
    private readonly db: Db,
    private readonly sender: OlxSender,
    private readonly notifier: Notifier,
    private readonly settings: RuntimeSettings,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Sends a draft (optionally with edited text). Records template intents as answered first, so a
   * retry can never send the same template twice. Rolls back on OLX failure.
   */
  async sendDraft(draftId: number, trigger: SendTrigger, editedText?: string): Promise<SendResult> {
    const before = this.db.getDraft(draftId);
    if (!before) return { ok: false, error: 'чернетку не знайдено', draft: null };
    if (!this.db.transitionDraft(draftId, OPEN, 'sent')) {
      return { ok: false, error: `чернетка вже ${statusLabel(before.status)}`, draft: before };
    }

    const text = (editedText ?? before.text).trim();
    if (editedText !== undefined) this.db.updateDraftText(draftId, text);

    const intents = draftIntents(before);
    const recorded = intents.filter((i) => this.db.recordAutoReply(before.threadUuid, i, before.messageUuid));
    // Automatic sends must not repeat an already answered question.
    if ((trigger === 'auto' || trigger === 'schedule') && recorded.length < intents.length) {
      for (const i of recorded) this.db.deleteAutoReply(before.threadUuid, i);
      this.db.transitionDraft(draftId, ['sent'], 'superseded');
      return { ok: false, error: 'на це питання вже відповідали', draft: this.db.getDraft(draftId) };
    }

    // An approved template is still the bot's text; anything the owner typed counts as the owner's.
    const author = trigger === 'edit' || before.source === 'llm' ? 'owner' : 'bot';
    try {
      await this.sender.send(before.threadUuid, text, author);
    } catch (err) {
      for (const i of recorded) this.db.deleteAutoReply(before.threadUuid, i);
      this.db.transitionDraft(draftId, ['sent'], 'pending');
      const error = String((err as Error)?.message ?? err);
      this.logger.error({ err, draftId }, 'failed to send draft to OLX');
      return { ok: false, error, draft: this.db.getDraft(draftId) };
    }
    this.logger.info({ draftId, thread: before.threadUuid, trigger }, 'draft sent to OLX');
    return { ok: true, draft: this.db.getDraft(draftId)! };
  }

  skipDraft(draftId: number): DraftRow | null {
    if (!this.db.transitionDraft(draftId, OPEN, 'skipped')) return null;
    return this.db.getDraft(draftId);
  }

  /** Closes open drafts of a thread (e.g. the owner answered manually). Returns closed drafts. */
  supersedeOpenDrafts(threadUuid: string, except?: number): DraftRow[] {
    const closed: DraftRow[] = [];
    for (const d of this.db.listOpenDraftsForThread(threadUuid)) {
      if (d.id === except) continue;
      if (this.db.transitionDraft(d.id, OPEN, 'superseded')) closed.push(this.db.getDraft(d.id)!);
    }
    return closed;
  }

  /** Sends drafts whose quiet-hours delay has expired. Called after every poll. */
  async dispatchScheduled(): Promise<void> {
    const now = this.now();
    for (const d of this.db.listDueScheduledDrafts(now)) {
      const thread = this.db.getThread(d.threadUuid);

      if (this.settings.mode === 'draft') {
        if (this.db.transitionDraft(d.id, ['scheduled'], 'pending')) {
          await this.safeUpdate(this.db.getDraft(d.id)!, 'draft', 'режим draft: підтвердіть вручну');
        }
        continue;
      }
      if (!thread || thread.ignored) {
        if (this.db.transitionDraft(d.id, ['scheduled'], 'superseded')) {
          await this.safeUpdate(this.db.getDraft(d.id)!, 'superseded', 'тред ігнорується');
        }
        continue;
      }
      if (thread.lastOwnerMsgAt !== null && thread.lastOwnerMsgAt >= d.createdAt) {
        if (this.db.transitionDraft(d.id, ['scheduled'], 'superseded')) {
          await this.safeUpdate(this.db.getDraft(d.id)!, 'superseded', 'ви вже відповіли в цьому треді');
        }
        continue;
      }

      const res = await this.sendDraft(d.id, 'schedule');
      if (res.ok) {
        await this.safeNotify(() => this.notifier.updateDraftCards(res.draft, { kind: 'auto_sent', draft: res.draft, note: 'після тихих годин' }));
      } else if (res.draft) {
        const draft = res.draft;
        const status =
          draft.status === 'superseded'
            ? ({ kind: 'draft_superseded', draft, reason: res.error } as const)
            : ({ kind: 'send_failed', draft, error: res.error } as const);
        await this.safeNotify(() => this.notifier.updateDraftCards(draft, status));
      }
    }
  }

  private async safeUpdate(draft: DraftRow, kind: 'draft' | 'superseded', text: string): Promise<void> {
    await this.safeNotify(() =>
      this.notifier.updateDraftCards(
        draft,
        kind === 'draft' ? { kind: 'draft', draft, note: text } : { kind: 'draft_superseded', draft, reason: text },
      ),
    );
  }

  private async safeNotify(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.error({ err }, 'Telegram notification failed');
    }
  }
}

export function statusLabel(s: DraftStatus): string {
  return { pending: 'очікує', scheduled: 'запланована', sent: 'надіслана', skipped: 'пропущена', superseded: 'скасована' }[s];
}

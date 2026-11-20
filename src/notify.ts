import type { DraftRow, ThreadRow } from './db/index.js';

/** What happened in a thread; drives the status block and buttons of the Telegram card. */
export type CardStatus =
  | { kind: 'forward'; reason: string }
  | { kind: 'draft'; draft: DraftRow; note?: string }
  | { kind: 'scheduled'; draft: DraftRow }
  | { kind: 'auto_sent'; draft: DraftRow; note?: string }
  | { kind: 'send_failed'; draft: DraftRow; error: string }
  | { kind: 'draft_sent'; draft: DraftRow }
  | { kind: 'draft_skipped'; draft: DraftRow }
  | { kind: 'draft_superseded'; draft: DraftRow; reason: string };

export interface Notifier {
  /** Sends a new card about the thread to every allowed chat. */
  threadCard(thread: ThreadRow, status: CardStatus): Promise<void>;
  /** Re-renders existing cards that show this draft. */
  updateDraftCards(draft: DraftRow, status: CardStatus): Promise<void>;
  /** Plain alert to every allowed chat. */
  alert(html: string): Promise<void>;
}

/** Notifier that does nothing (tests / Telegram not configured). */
export const nullNotifier: Notifier = {
  threadCard: async () => undefined,
  updateDraftCards: async () => undefined,
  alert: async () => undefined,
};

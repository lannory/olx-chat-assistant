/**
 * Decides whether a thread may get an automatic (template) reply right now.
 * Pure function: no I/O, easy to test.
 */
import type { Intent } from './classifier.js';

export interface PolicyInput {
  /** Intents the new buyer messages asked about (union, de-duplicated). */
  intents: Intent[];
  /** Intents already answered automatically in this thread. */
  alreadyAnswered: Set<Intent>;
  /** Intents that already have an open (pending/scheduled) draft. */
  openDraftIntents: Set<Intent>;
  /** When the owner last wrote in this thread (OLX app or via Telegram). */
  lastOwnerMsgAt: number | null;
  cooldownMin: number;
  now: number;
  /** Intents answered even right after the owner wrote (e.g. "Дякую за замовлення" for delivery details). */
  cooldownExempt?: ReadonlySet<Intent>;
}

export type PolicyDecision =
  | { allow: true; intents: Intent[] }
  | { allow: false; reason: string };

export function decideAutoReply(p: PolicyInput): PolicyDecision {
  const exempt = p.intents.length > 0 && p.intents.every((i) => p.cooldownExempt?.has(i));
  if (!exempt && p.lastOwnerMsgAt !== null && p.cooldownMin > 0) {
    const ago = p.now - p.lastOwnerMsgAt;
    if (ago >= 0 && ago < p.cooldownMin * 60_000) {
      return { allow: false, reason: `ви писали в цьому треді ${Math.max(1, Math.round(ago / 60_000))} хв тому` };
    }
  }
  const fresh = p.intents.filter((i) => !p.alreadyAnswered.has(i) && !p.openDraftIntents.has(i));
  if (fresh.length === 0) {
    return { allow: false, reason: 'на це питання в треді вже відповідали автоматично' };
  }
  return { allow: true, intents: fresh };
}

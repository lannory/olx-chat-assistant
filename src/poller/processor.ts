/**
 * Turns new buyer messages of a thread into an action:
 *   blocked / unknown / cooldown → forward to Telegram only
 *   template answer              → draft (MODE=draft), immediate send (MODE=auto) or a send
 *                                  postponed to the end of quiet hours (MODE=auto at night)
 *   optional LLM draft           → only in MODE=draft, only as a draft: for messages without a
 *                                  template, and for condition questions when the advert has no notes
 */
import type { Config } from '../config.js';
import type { Db, MessageRow, ThreadRow } from '../db/index.js';
import type { Drafter } from '../llm/draft.js';
import type { Logger } from '../logger.js';
import type { CardStatus, Notifier } from '../notify.js';
import {
  BLOCK_REASON_LABELS,
  INTENT_LABELS,
  NO_LLM_BLOCKS,
  classify,
  deliveryTopics,
  isMilitary,
  isSmallTalk,
  type Intent,
} from '../rules/classifier.js';
import type { JsonFileStore } from '../rules/jsonFileStore.js';
import { decideAutoReply } from '../rules/policy.js';
import { composeReply, formatPrice, olxDeliveryPrice, type templatesSchema } from '../rules/templates.js';
import type { ThreadContextService } from '../services/context.js';
import { draftIntents, type ReplyService } from '../services/replies.js';
import type { RuntimeSettings } from '../settings.js';
import { isQuietTime, quietEndAfter } from '../time.js';
import type { MessageProcessor } from './poller.js';

export interface ProcessorDeps {
  db: Db;
  context: ThreadContextService;
  replies: ReplyService;
  notifier: Notifier;
  settings: RuntimeSettings;
  templates: JsonFileStore<typeof templatesSchema>;
  drafter: Drafter | null;
  logger: Logger;
  config: Pick<Config, 'OWNER_COOLDOWN_MIN' | 'QUIET_HOURS' | 'TIMEZONE' | 'SHIPPING_COD' | 'SHIPPING_PREPAY' | 'TG_HISTORY_SIZE'>;
  now?: () => number;
}

type Plan =
  | {
      kind: 'forward';
      reason: string;
      /** False when there is nothing to answer in words (thanks, delivery details, "paid"): no LLM draft. */
      llm?: boolean;
    }
  | {
      kind: 'reply';
      text: string;
      intents: Intent[];
      note?: string;
      /** A question the templates can't cover (no advert notes, unknown camera/accessory): in MODE=draft an LLM draft is preferred. */
      llmPreferred?: string;
      /** Photo URLs to post with the reply (whichever draft gets created). */
      photos: string[];
    };

/** "Дякую за замовлення" goes out even if the owner has just written in the thread. */
const COOLDOWN_EXEMPT: ReadonlySet<Intent> = new Set(['order_details']);

/** Prices written in the advert description ("за 1500 грн", "600 грн"). */
export function descriptionPrices(description: string): number[] {
  return [...description.matchAll(/(\d{1,3}(?:[ .]\d{3})+|\d+)\s*(грн|uah|₴)/giu)].map((m) => Number(m[1]!.replace(/[ .]/g, '')));
}

/** "5" / "7.5" for a 9 000 грн item means thousands. */
export function scaleOffer(offer: number, price: number): number {
  return offer < 100 && price >= 1000 ? offer * 1000 : offer;
}

export class Processor implements MessageProcessor {
  private readonly now: () => number;

  constructor(private readonly d: ProcessorDeps) {
    this.now = d.now ?? Date.now;
  }

  async handleNewMessages(thread: ThreadRow, messages: MessageRow[]): Promise<void> {
    const { db, logger } = this.d;
    const plan = await this.plan(thread, messages);
    const status = await this.execute(thread, messages, plan);
    logger.info({ thread: thread.uuid, plan: plan.kind, status: status.kind, messages: messages.length }, 'thread processed');

    try {
      await this.d.notifier.threadCard(db.getThread(thread.uuid) ?? thread, status);
    } catch (err) {
      logger.error({ err, thread: thread.uuid }, 'Telegram notification failed');
    }
    for (const m of messages) db.markMessageProcessed(m.uuid);
  }

  private async plan(thread: ThreadRow, messages: MessageRow[]): Promise<Plan> {
    const relevant = messages.filter((m) => m.hasAttachments || !isSmallTalk(m.text));
    if (relevant.length === 0) return { kind: 'forward', reason: 'привітання / подяка без питання', llm: false };

    const intents = new Set<Intent>();
    const offers: number[] = [];
    let bargainExplicit = false;
    const tpl = this.d.templates.get();
    const classifyOpts = {
      pickupWords: tpl.pickup_words,
      photoWords: tpl.photos.flatMap((p) => (p.match ? [p.match] : [])),
    };
    for (const m of relevant) {
      const c = classify(m.text, m.hasAttachments, classifyOpts);
      if (c.blocked) return { kind: 'forward', reason: BLOCK_REASON_LABELS[c.blocked], llm: !NO_LLM_BLOCKS.has(c.blocked) };
      c.intents.forEach((i) => intents.add(i));
      offers.push(...c.offers);
      bargainExplicit ||= c.bargainExplicit;
    }

    // Ordering via OLX Delivery needs no shipping details from the buyer: the delivery answer covers it.
    const topics = [...new Set(relevant.flatMap((m) => deliveryTopics(m.text)))];
    if (topics.includes('olx')) intents.delete('order');

    // A bare number ("9000", "9000 беру") at or above the advert price is agreement, not bargaining;
    // "що за набір за 1500?" quotes a price from the description, it is not an offer either.
    if (intents.has('bargain') && !bargainExplicit && offers.length > 0) {
      const advert = await this.d.context.getAdvert(thread.advertId);
      const price = advert?.priceValue ?? null;
      const listed = new Set(descriptionPrices(advert?.description ?? ''));
      const real = offers.filter((o) => !listed.has(o));
      if (real.length === 0) {
        intents.delete('bargain');
      } else if (price !== null && real.every((o) => scaleOffer(o, price) >= price)) {
        intents.delete('bargain');
        if (intents.size === 0) return { kind: 'forward', reason: 'покупець пропонує ціну оголошення або більше', llm: false };
      }
      if (intents.size === 0) return { kind: 'forward', reason: 'не розпізнано' };
    }

    const open = this.d.db.listOpenDraftsForThread(thread.uuid);
    const decision = decideAutoReply({
      intents: [...intents],
      alreadyAnswered: new Set(this.d.db.listAutoRepliedIntents(thread.uuid) as Intent[]),
      openDraftIntents: new Set(open.flatMap(draftIntents)),
      lastOwnerMsgAt: thread.lastOwnerMsgAt,
      cooldownMin: this.d.config.OWNER_COOLDOWN_MIN,
      now: this.now(),
      cooldownExempt: COOLDOWN_EXEMPT,
    });
    // Delivery details need no words beyond the template: never an LLM draft for them.
    const onlyDetails = [...intents].every((i) => i === 'order_details');
    if (!decision.allow) return { kind: 'forward', reason: decision.reason, llm: !onlyDetails };

    // "Я з ЗСУ" may come in an earlier message than "знижка буде?", so look at recent buyer history.
    const military = this.d.db
      .lastMessages(thread.uuid, 20)
      .some((m) => m.author === 'buyer' && isMilitary(m.text));

    const advert = await this.d.context.getAdvert(thread.advertId);
    const reply = composeReply(
      decision.intents,
      {
        advert,
        notes: this.d.context.getNotes(thread.advertId),
        shipping: { cod: this.d.config.SHIPPING_COD, prepay: this.d.config.SHIPPING_PREPAY },
        military,
        greet: !this.d.db.sellerHasWritten(thread.uuid),
        deliveryTopics: topics,
        buyerText: relevant.map((m) => m.text).join('\n'),
      },
      tpl,
    );
    const skippedNote = reply.skipped.map((s) => `${INTENT_LABELS[s.intent]} — ${s.reason}`).join('; ');
    if (!reply.text) return { kind: 'forward', reason: skippedNote || 'немає шаблону' };
    const notes = [
      military && reply.intents.includes('bargain') ? 'покупець згадує військову службу' : '',
      skippedNote ? `не покрито: ${skippedNote}` : '',
    ].filter(Boolean);
    // Questions the templates could not answer for lack of data (no notes, unknown camera/accessory):
    // in MODE=draft the LLM answers the whole message from the advert instead.
    const llmIntents = reply.skipped.filter((s) => s.intent === 'condition' || s.intent === 'delivery').map((s) => s.intent);
    return {
      kind: 'reply',
      text: reply.text,
      intents: reply.intents,
      note: notes.join('; ') || undefined,
      llmPreferred: llmIntents.length
        ? `${llmIntents.map((i) => INTENT_LABELS[i]).join(', ')}: бракує даних для шаблону, відповідь за описом оголошення`
        : undefined,
      photos: reply.photos,
    };
  }

  private async execute(thread: ThreadRow, messages: MessageRow[], plan: Plan): Promise<CardStatus> {
    const { db, settings, config } = this.d;
    const lastMessage = messages.at(-1)!;
    const mode = settings.mode;

    if (plan.kind === 'forward') {
      if (mode === 'draft' && this.d.drafter && plan.llm !== false) {
        const llm = await this.llmDraft(thread);
        if (llm) {
          const draft = db.createDraft({
            threadUuid: thread.uuid,
            messageUuid: lastMessage.uuid,
            intent: 'llm',
            text: llm,
            source: 'llm',
            status: 'pending',
          });
          return { kind: 'draft', draft, note: `без автовідповіді: ${plan.reason}` };
        }
      }
      return { kind: 'forward', reason: plan.reason };
    }

    const base = {
      threadUuid: thread.uuid,
      messageUuid: lastMessage.uuid,
      intent: plan.intents.join(','),
      text: plan.text,
      source: 'rule' as const,
      photos: plan.photos,
    };

    if (mode === 'draft') {
      // The template would answer only part of the message: let the LLM draft the whole reply from
      // the advert description. Falls back to the template draft if the LLM gives nothing.
      if (plan.llmPreferred && this.d.drafter) {
        const llm = await this.llmDraft(thread);
        if (llm) {
          const draft = db.createDraft({ ...base, intent: 'llm', text: llm, source: 'llm', status: 'pending' });
          return { kind: 'draft', draft, note: plan.llmPreferred };
        }
      }
      return { kind: 'draft', draft: db.createDraft({ ...base, status: 'pending' }), note: plan.note };
    }

    const now = this.now();
    if (config.QUIET_HOURS && isQuietTime(now, config.QUIET_HOURS, config.TIMEZONE)) {
      const draft = db.createDraft({
        ...base,
        status: 'scheduled',
        scheduledFor: quietEndAfter(now, config.QUIET_HOURS, config.TIMEZONE),
      });
      return { kind: 'scheduled', draft };
    }

    const draft = db.createDraft({ ...base, status: 'pending' });
    const res = await this.d.replies.sendDraft(draft.id, 'auto');
    if (res.ok) return { kind: 'auto_sent', draft: res.draft, note: plan.note };
    const current = res.draft ?? draft;
    if (current.status === 'superseded') return { kind: 'draft_superseded', draft: current, reason: res.error };
    return { kind: 'send_failed', draft: current, error: res.error };
  }

  private async llmDraft(thread: ThreadRow): Promise<string | null> {
    try {
      const [advert, buyerName] = await Promise.all([
        this.d.context.getAdvert(thread.advertId),
        this.d.context.getInterlocutorName(thread),
      ]);
      return await this.d.drafter!.draft({
        advert,
        notes: this.d.context.getNotes(thread.advertId),
        history: this.d.db.lastMessages(thread.uuid, 12),
        buyerName,
        sellerHasWritten: this.d.db.sellerHasWritten(thread.uuid),
        olxPrice:
          advert?.priceValue != null
            ? formatPrice(olxDeliveryPrice(advert.priceValue, this.d.templates.get().olx_fee), advert.priceCurrency)
            : null,
      });
    } catch (err) {
      this.d.logger.error({ err, thread: thread.uuid }, 'LLM draft failed');
      return null;
    }
  }
}

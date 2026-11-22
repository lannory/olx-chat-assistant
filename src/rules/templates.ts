import { z } from 'zod';
import type { AdvertRow } from '../db/index.js';
import type { DeliveryTopic, Intent } from './classifier.js';
import { wallTime } from '../time.js';
import { detectItem, detectItemName, itemsSchema } from './itemName.js';

const shippingSetSchema = z.object({
  /** Any delivery question, or several topics at once ("наложкою чи OLX доставкою?"). */
  general: z.string().min(1),
  /** The buyer asks specifically about OLX Delivery / cash on delivery / Ukrposhta. */
  olx: z.string().optional(),
  cod: z.string().optional(),
  ukrposhta: z.string().optional(),
});

export const templatesSchema = z.object({
  greeting: z.string().default(''),
  /** Used instead of `greeting` in the evening and at night (local time, TIMEZONE). Empty = always `greeting`. */
  greeting_evening: z.string().default(''),
  /** Evening/night window for `greeting_evening`: from `from`:00 until `to`:00 (wraps over midnight). */
  evening_hours: z
    .object({ from: z.number().int().min(0).max(23).default(18), to: z.number().int().min(0).max(23).default(6) })
    .default({ from: 18, to: 6 }),
  signature: z.string().default(''),
  intents: z.object({
    availability: z.string().min(1),
    delivery: z.string().min(1),
    pickup: z.string().min(1),
    condition: z.string().min(1),
    // Defaults keep older templates.json files (without these keys) loading.
    bargain: z.string().min(1).default('Торг відсутній.'),
    /** Used instead of `bargain` when the buyer mentions military service. */
    bargain_military: z.string().min(1).default('На жаль, немає можливості зробити знижку.'),
    /** The buyer wants to order ("хочу замовити", "беру"). */
    order: z
      .string()
      .min(1)
      .default('Напишіть, будь ласка, дані для відправки: ПІБ, номер телефону, місто та номер відділення Нової Пошти.'),
    /** The buyer sent delivery details (name, phone, branch). */
    order_details: z.string().min(1).default('Дякую за замовлення!'),
    /** Added after the greeting when the buyer only greeted ("Добрий день"). Empty = just greet back. */
    hello: z.string().default(''),
  }),
  /**
   * Generic `{payment}` variants for `intents.delivery`, chosen by SHIPPING_COD / SHIPPING_PREPAY.
   * Used only when there is no `shipping` section.
   */
  payment: z
    .object({
      cod_and_prepay: z.string().default(''),
      cod_only: z.string().default(''),
      prepay_only: z.string().default(''),
    })
    .default({ cod_and_prepay: '', cod_only: '', prepay_only: '' }),
  /**
   * Delivery answers by product category and by what the buyer asked about. When present, they
   * replace `intents.delivery`. Placeholders as in other templates plus `{olx_price}`.
   */
  shipping: z.record(z.string(), shippingSetSchema).optional(),
  /** Rules that turn an advert title into a short item name and a shipping category. */
  items: itemsSchema,
  /** Extra words that mean "pickup / where are you" for this seller (district names etc.), as regexes. */
  pickup_words: z.array(z.string().min(1)).default([]),
  /** What the LLM needs to know about the seller: goods, location, shipping and payment terms, tone. */
  llm: z.object({ seller_context: z.string().default('') }).default({ seller_context: '' }),
  /** OLX Delivery fee added to the price for `{olx_price}`: price + percent% + fixed, rounded up to round_to. */
  olx_fee: z
    .object({
      percent: z.number().min(0).default(3),
      fixed: z.number().min(0).default(20),
      round_to: z.number().int().min(1).default(10),
    })
    .default({ percent: 3, fixed: 20, round_to: 10 }),
  quick: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]{1,20}$/i, 'id: латиниця/цифри, до 20 символів'),
        label: z.string().min(1).max(30),
        text: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * Photo sets the bot can post to the buyer (OLX message attachments). The OLX API takes photos
   * only as public URLs, so each set is a list of links.
   */
  photos: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9_-]{1,20}$/i, 'id: латиниця/цифри, до 20 символів'),
        /** Button text in Telegram. */
        label: z.string().min(1).max(30),
        /** Message text sent with the photos. */
        text: z.string().min(1),
        urls: z.array(z.url({ protocol: /^https?$/ })).min(1).max(10),
        /** Advert IDs this set belongs to; empty = any advert. */
        adverts: z.array(z.coerce.number().int()).default([]),
        /** Regex: buyer words that ask for this set even without the word "фото" ("великий комплект"). */
        match: z.string().optional(),
      }),
    )
    .default([]),
});
export type PhotoSet = z.output<typeof templatesSchema>['photos'][number];
export type Templates = z.output<typeof templatesSchema>;

const noteSchema = z.object({
  title: z.string().optional(),
  /** Short name for replies ("ноутбук", "зарядки"); detected from the title when missing. */
  item: z.string().optional(),
  /** Key in `shipping` of templates.json: picks the payment/shipping terms. Detected when missing. */
  category: z.string().optional(),
  condition: z.string().optional(),
  kit: z.string().optional(),
  batteries: z.string().optional(),
  notes: z.string().optional(),
});
export type AdvertNotes = z.output<typeof noteSchema>;

export const advertsConfigSchema = z.object({
  adverts: z.record(z.string().regex(/^\d+$/, 'ключ — числовий advert_id'), noteSchema).default({}),
});
export type AdvertsConfig = z.output<typeof advertsConfigSchema>;

export interface ShippingOptions {
  cod: boolean;
  prepay: boolean;
}

export interface ReplyContext {
  advert: AdvertRow | null;
  notes: AdvertNotes | null;
  shipping: ShippingOptions;
  /** The buyer mentioned military service: bargaining gets the `bargain_military` wording. */
  military?: boolean;
  /** Start with `greeting`. False for follow-up replies, when the seller has already written. Default true. */
  greet?: boolean;
  /** What the buyer's delivery question is about (OLX Delivery, cash on delivery, Ukrposhta). */
  deliveryTopics?: DeliveryTopic[];
  /** The buyer's new messages, joined: picks the photo set by its `match` words. */
  buyerText?: string;
  /** When the reply is written, and the seller's timezone: "Добрий вечір" vs "Добрий день". */
  now?: number;
  timezone?: string;
}

/** `greeting_evening` from `evening_hours.from` until `evening_hours.to` local time, `greeting` otherwise. */
export function greetingTemplate(t: Templates, now: number | undefined, timezone: string | undefined): string {
  if (!t.greeting_evening.trim() || now === undefined || !timezone) return t.greeting;
  const { hour } = wallTime(now, timezone);
  const { from, to } = t.evening_hours;
  const evening = from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  return evening ? t.greeting_evening : t.greeting;
}

/**
 * The photo set for a photo request, chosen only when it is clear what the buyer wants:
 * the one set whose `match` words the buyer used, or else the one set bound to this advert that has
 * no `match`. "Фото серійника" must not get the accessories photos, so otherwise null (the owner
 * picks with "📷 Фото").
 */
export function pickPhotoSet(t: Templates, advertId: number | null, buyerText: string): PhotoSet | null {
  const fits = t.photos.filter((p) => p.adverts.length === 0 || (advertId !== null && p.adverts.includes(advertId)));
  const named = fits.filter((p) => p.match && new RegExp(p.match, 'iu').test(buyerText));
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return null;
  const own = fits.filter((p) => !p.match && advertId !== null && p.adverts.includes(advertId));
  return own.length === 1 ? own[0]! : null;
}

/** No-break spaces used by Intl as thousands separators (U+00A0, U+202F). */
const NBSP_RE = new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, 'g');

export function formatPrice(value: number | null, currency: string | null): string {
  if (value === null) return '';
  const n = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value).replace(NBSP_RE, ' ');
  if (!currency || currency.toUpperCase() === 'UAH') return `${n} грн`;
  return `${n} ${currency}`;
}

export type Category = string;

/** Price the buyer pays with OLX Delivery when the seller adds the OLX fee: price + percent% + fixed, rounded up. */
export function olxDeliveryPrice(price: number, fee: Templates['olx_fee']): number {
  const raw = price * (1 + fee.percent / 100) + fee.fixed;
  return Math.ceil(Math.round(raw * 100) / 100 / fee.round_to) * fee.round_to;
}

/**
 * Picks the delivery answer: Ukrposhta first (it decides whether we ship at all), then the single
 * topic asked about, otherwise the general answer.
 */
export function shippingTemplate(t: Templates, category: Category | null, topics: DeliveryTopic[] = []): string | null {
  const set = category ? t.shipping?.[category] : undefined;
  if (!set) return null;
  if (topics.includes('ukrposhta') && set.ukrposhta) return set.ukrposhta;
  const only = topics.filter((x) => x !== 'ukrposhta');
  if (only.length === 1 && set[only[0]!]) return set[only[0]!]!;
  return set.general;
}

/**
 * Shipping category, from `category` / `item` in adverts.config.json or the advert title.
 * Null when nothing says what it is.
 */
export function itemCategory(title: string | null | undefined, notes: AdvertNotes | null, items: Templates['items']): Category | null {
  if (notes?.category) return notes.category;
  const fromItem = notes?.item?.trim() ? detectItem(notes.item, items) : null;
  if (fromItem && !fromItem.unknown) return fromItem.category;
  return detectItem(title, items).category;
}

export function paymentText(t: Templates, s: ShippingOptions): string {
  if (s.cod && s.prepay) return t.payment.cod_and_prepay;
  if (s.cod) return t.payment.cod_only;
  if (s.prepay) return t.payment.prepay_only;
  return '';
}

/**
 * Replaces {placeholders}. A line whose placeholders all resolved to empty strings is dropped,
 * so "Акумулятори: {batteries}" disappears when there is no battery note.
 */
export function render(template: string, vars: Record<string, string | undefined>): string {
  const lines = template.split('\n').flatMap((line) => {
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    if (keys.length > 0 && keys.every((k) => !vars[k]?.trim())) return [];
    return [line.replace(/\{(\w+)\}/g, (_, k: string) => vars[k]?.trim() ?? '')];
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hasNotes(n: AdvertNotes | null): boolean {
  return !!n && [n.condition, n.kit, n.batteries, n.notes].some((v) => v?.trim());
}

export interface ComposedReply {
  text: string;
  /** Intents actually covered by `text`. */
  intents: Intent[];
  /** Intents that could not be answered automatically and why. */
  skipped: { intent: Intent; reason: string }[];
  /** Photo URLs to post with the text. */
  photos: string[];
}

export function contextVars(ctx: ReplyContext, t: Templates): Record<string, string> {
  const a = ctx.advert;
  const title = ctx.notes?.title ?? a?.title;
  return {
    title: title ?? 'товар',
    item: ctx.notes?.item?.trim() || detectItemName(title, t.items),
    price: a ? formatPrice(a.priceValue, a.priceCurrency) : '',
    olx_price: a?.priceValue != null ? formatPrice(olxDeliveryPrice(a.priceValue, t.olx_fee), a.priceCurrency) : '',
    url: a?.url ?? '',
    payment: paymentText(t, ctx.shipping),
    condition: ctx.notes?.condition ?? '',
    kit: ctx.notes?.kit ?? '',
    batteries: ctx.notes?.batteries ?? '',
    notes: ctx.notes?.notes ?? '',
  };
}

/** Builds one reply covering several intents: greeting (first reply only) + one paragraph per intent + signature. */
export function composeReply(intents: Intent[], ctx: ReplyContext, t: Templates): ComposedReply {
  const vars = contextVars(ctx, t);
  const parts: string[] = [];
  const covered: Intent[] = [];
  const skipped: ComposedReply['skipped'] = [];
  let photos: string[] = [];

  for (const intent of intents) {
    if (intent === 'condition' && !hasNotes(ctx.notes)) {
      skipped.push({ intent, reason: 'немає нотаток для цього оголошення в adverts.config.json' });
      continue;
    }
    if (intent === 'hello') {
      // The greeting itself is the answer (added below); `intents.hello` may add a line after it.
      const p = render(t.intents.hello, vars);
      if (p) parts.push(p);
      covered.push(intent);
      continue;
    }
    if (intent === 'photo') {
      const set = pickPhotoSet(t, ctx.advert?.id ?? null, ctx.buyerText ?? '');
      if (!set) {
        skipped.push({
          intent,
          reason: t.photos.length ? 'незрозуміло, який набір фото надіслати (кнопка «📷 Фото»)' : 'немає наборів фото в templates.json',
        });
        continue;
      }
      parts.push(render(set.text, vars));
      covered.push(intent);
      photos = set.urls;
      continue;
    }
    let template = intent === 'bargain' && ctx.military ? t.intents.bargain_military : t.intents[intent];
    if (intent === 'delivery' && t.shipping) {
      // Categories ship on different terms; guessing could promise the wrong ones.
      const category = itemCategory(ctx.notes?.title ?? ctx.advert?.title, ctx.notes, t.items);
      const shipping = shippingTemplate(t, category, ctx.deliveryTopics);
      if (!shipping) {
        skipped.push({ intent, reason: 'не вдалося визначити категорію товару (задайте category в adverts.config.json)' });
        continue;
      }
      if (shipping.includes('{olx_price}') && !vars.olx_price) {
        skipped.push({ intent, reason: 'невідома ціна оголошення, не можу порахувати вартість з комісією OLX' });
        continue;
      }
      template = shipping;
    }
    if (intent === 'bargain' && ctx.advert?.negotiable === true) {
      // "Торг відсутній" would contradict an advert marked as negotiable on OLX.
      skipped.push({ intent, reason: 'в оголошенні на OLX вказано «торг»' });
      continue;
    }
    const p = render(template, vars);
    if (p) {
      parts.push(p);
      covered.push(intent);
    }
  }
  const hello = covered.includes('hello');
  if (parts.length === 0 && !hello) return { text: '', intents: [], skipped, photos: [] };

  // A buyer who greets gets greeted back, even later in the thread.
  const greeting = ctx.greet === false && !hello ? '' : render(greetingTemplate(t, ctx.now, ctx.timezone), vars);
  if (parts.length === 0 && !greeting) return { text: '', intents: [], skipped, photos: [] };
  const text = [greeting, ...parts, render(t.signature, vars)].filter(Boolean).join('\n');
  return { text, intents: covered, skipped, photos };
}

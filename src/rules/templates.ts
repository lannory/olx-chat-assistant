import { z } from 'zod';
import type { AdvertRow } from '../db/index.js';
import type { DeliveryTopic, Intent } from './classifier.js';
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
      .default('Добре, напишіть, будь ласка, дані для відправки: ПІБ, номер телефону, місто та номер відділення Нової Пошти.'),
    /** The buyer sent delivery details (name, phone, branch). */
    order_details: z.string().min(1).default('Дякую за замовлення!'),
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
});
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

  for (const intent of intents) {
    if (intent === 'condition' && !hasNotes(ctx.notes)) {
      skipped.push({ intent, reason: 'немає нотаток для цього оголошення в adverts.config.json' });
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
  if (parts.length === 0) return { text: '', intents: [], skipped };

  const greeting = ctx.greet === false ? '' : render(t.greeting, vars);
  const text = [greeting, ...parts, render(t.signature, vars)].filter(Boolean).join('\n');
  return { text, intents: covered, skipped };
}

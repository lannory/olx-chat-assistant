/**
 * Short generic name of what is being sold ("ноутбук", "зарядки"), used in replies instead of the
 * full advert title, plus its category (which picks the shipping terms). The rules come from
 * `items` in templates.json; `item` / `category` in adverts.config.json override them.
 *
 * The keyword found earliest in the title wins, so "Зарядка для ноутбука Lenovo" is a charger while
 * "Ноутбук Lenovo + зарядка" is a laptop. `fallback` (e.g. brand names) only counts when no rule matched.
 */
import { z } from 'zod';

const itemRuleSchema = z.object({
  /** Case-insensitive regular expression searched in the title. */
  match: z.string().min(1),
  name: z.string().min(1),
  /** Used instead of `name` when the matched word itself matches `plural_match` ("зарядки"). */
  plural: z.string().optional(),
  plural_match: z.string().optional(),
  /** Key of the shipping terms in `shipping` (e.g. "main", "accessory"). */
  category: z.string().optional(),
});

export const itemsSchema = z
  .object({
    rules: z.array(itemRuleSchema).default([]),
    fallback: itemRuleSchema.omit({ plural: true, plural_match: true }).optional(),
    /** Name when nothing matched. */
    default: z.string().min(1).default('товар'),
  })
  .default({ rules: [], default: 'товар' });
export type ItemsConfig = z.output<typeof itemsSchema>;
type ItemRule = z.output<typeof itemRuleSchema>;

export interface DetectedItem {
  name: string;
  category: string | null;
  /** Nothing in the text matched a rule. */
  unknown: boolean;
}

const compiled = new Map<string, RegExp>();
function rx(source: string, anchored = false): RegExp {
  const key = `${anchored ? '^' : ''}${source}`;
  let re = compiled.get(key);
  if (!re) {
    re = new RegExp(anchored ? `^(?:${source})` : source, 'iu');
    compiled.set(key, re);
  }
  return re;
}

export function detectItem(title: string | null | undefined, items: ItemsConfig): DetectedItem {
  const none: DetectedItem = { name: items.default, category: null, unknown: true };
  if (!title) return none;
  let best: { index: number; rule: ItemRule; word: string } | null = null;
  for (const rule of items.rules) {
    const m = rx(rule.match).exec(title);
    if (!m || (best && m.index >= best.index)) continue;
    best = { index: m.index, rule, word: title.slice(m.index) };
  }
  if (best) {
    const { rule, word } = best;
    const plural = rule.plural && rule.plural_match && rx(rule.plural_match, true).test(word);
    return { name: plural ? rule.plural! : rule.name, category: rule.category ?? null, unknown: false };
  }
  if (items.fallback && rx(items.fallback.match).test(title)) {
    return { name: items.fallback.name, category: items.fallback.category ?? null, unknown: false };
  }
  return none;
}

export function detectItemName(title: string | null | undefined, items: ItemsConfig): string {
  return detectItem(title, items).name;
}

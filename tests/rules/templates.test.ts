import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nullLogger } from '../../src/logger.js';
import type { DeliveryTopic } from '../../src/rules/classifier.js';
import { decideAutoReply } from '../../src/rules/policy.js';
import { JsonFileStore } from '../../src/rules/jsonFileStore.js';
import {
  advertsConfigSchema,
  composeReply,
  formatPrice,
  olxDeliveryPrice,
  render,
  templatesSchema,
  type ReplyContext,
} from '../../src/rules/templates.js';

const templates = templatesSchema.parse(JSON.parse(readFileSync('config/templates.example.json', 'utf8')));

const advert = {
  id: 1,
  title: 'Ноутбук Lenovo ThinkPad T480',
  description: '',
  priceValue: 9000,
  priceCurrency: 'UAH',
  negotiable: false,
  url: 'https://www.olx.ua/d/x.html',
  status: 'active',
  fetchedAt: 0,
};

const ctx = (over: Partial<ReplyContext> = {}): ReplyContext => ({
  advert,
  notes: null,
  shipping: { cod: true, prepay: true },
  ...over,
});

describe('shipped config files', () => {
  it('templates.json and adverts.config.json are valid', () => {
    expect(templates.quick.length).toBeGreaterThan(0);
    expect(() => advertsConfigSchema.parse(JSON.parse(readFileSync('config/adverts.config.example.json', 'utf8')))).not.toThrow();
  });

  it('pickup template does not reveal an exact address', () => {
    expect(templates.intents.pickup).toMatch(/самовивіз/);
    expect(templates.intents.pickup).not.toMatch(/\d+\s*(буд|вул|просп)|вул\.|просп\./i);
  });
});

describe('render', () => {
  it('fills placeholders and drops lines whose placeholders are all empty', () => {
    expect(render('A: {a}\nB: {b}\nC', { a: '1', b: '' })).toBe('A: 1\nC');
  });
});

describe('formatPrice', () => {
  it('formats UAH and other currencies', () => {
    expect(formatPrice(9000, 'UAH')).toBe('9 000 грн');
    expect(formatPrice(349, 'EUR')).toBe('349 EUR');
    expect(formatPrice(null, 'UAH')).toBe('');
  });
});

describe('composeReply', () => {
  it('combines intents with one greeting', () => {
    const r = composeReply(['availability', 'delivery'], ctx(), templates);
    expect(r.intents).toEqual(['availability', 'delivery']);
    expect(r.text.match(/Добрий день/g)).toHaveLength(1);
    expect(r.text).toContain('Так, ноутбук в наявності');
    expect(r.text).toContain('накладеним платежем без передоплати');
  });

  it('names the item briefly; `item` in notes overrides detection', () => {
    const battery = { ...advert, title: 'Оригінальна зарядка Lenovo 65W' };
    expect(composeReply(['availability'], ctx({ advert: battery }), templates).text).toContain('Так, зарядка в наявності.');
    const custom = composeReply(['availability'], ctx({ notes: { item: 'набір кріплень' } }), templates);
    expect(custom.text).toContain('Так, набір кріплень в наявності.');
    expect(custom.text).not.toContain('ThinkPad');
  });

  it('omits the greeting in follow-up replies', () => {
    const r = composeReply(['delivery'], ctx({ greet: false }), templates);
    expect(r.text).not.toContain('Добрий день');
    expect(r.text).toMatch(/^Відправляю Новою Поштою/);
  });

  it('each category gets its own payment terms', () => {
    const main = composeReply(['delivery'], ctx(), templates).text;
    expect(main).toContain('накладеним платежем без передоплати');
    expect(main).toContain('комісія OLX — тоді вартість буде 9 290 грн');

    const battery = { ...advert, title: 'Зарядка для ноутбука Lenovo', priceValue: 600 };
    const accessory = composeReply(['delivery'], ctx({ advert: battery }), templates).text;
    expect(accessory).toContain('передоплатою 100 грн');
    expect(accessory).toContain('OLX Доставкою без додаткової комісії');
    expect(accessory).not.toContain('без передоплати');
  });

  it('answers exactly what was asked: OLX Delivery, cash on delivery, Ukrposhta', () => {
    const main = (topics: DeliveryTopic[]) => composeReply(['delivery'], ctx({ greet: false, deliveryTopics: topics }), templates).text;
    expect(main(['olx'])).toBe(
      'OLX Доставкою відправляю, але до вартості додається комісія OLX, тобто вартість буде 9 290 грн. Також відправляю накладеним платежем без передоплати.',
    );
    expect(main(['cod'])).toBe('Так, відправляю накладеним платежем без передоплати.');
    expect(main(['ukrposhta', 'cod'])).toContain('Укрпоштою не відправляю');
    // Both ways at once ("наложкою чи OLX?") → the general answer.
    expect(main(['olx', 'cod'])).toMatch(/^Відправляю Новою Поштою/);

    const battery = { ...advert, title: 'Зарядка Lenovo', priceValue: 600 };
    const acc = (topics: DeliveryTopic[]) =>
      composeReply(['delivery'], ctx({ advert: battery, greet: false, deliveryTopics: topics }), templates).text;
    expect(acc(['olx'])).toMatch(/^Так, OLX Доставкою відправляю, без додаткової комісії/);
    expect(acc(['ukrposhta'])).toBe('Укрпоштою відправляю лише через OLX Доставку або за повної передоплати.');
  });

  it('OLX Delivery price = price + 3% + 20 грн, rounded up to 10', () => {
    const fee = templates.olx_fee;
    expect(olxDeliveryPrice(9000, fee)).toBe(9290);
    expect(olxDeliveryPrice(9500, fee)).toBe(9810); // 9805 → 9810
    expect(olxDeliveryPrice(400, fee)).toBe(440); // 432 → 440
    expect(olxDeliveryPrice(10000, { percent: 3, fixed: 20, round_to: 1 })).toBe(10320);
  });

  it('skips the OLX answer when the advert price is unknown', () => {
    const r = composeReply(['delivery'], ctx({ advert: { ...advert, priceValue: null }, deliveryTopics: ['olx'] }), templates);
    expect(r.text).toBe('');
    expect(r.skipped[0]!.reason).toContain('комісією OLX');
  });

  it('`category` in notes overrides detection', () => {
    const r = composeReply(['delivery'], ctx({ notes: { category: 'accessory' } }), templates);
    expect(r.text).toContain('передоплатою 100 грн');
  });

  it('does not guess the terms when the item category is unclear', () => {
    const unknown = { ...advert, title: 'Велосипед дитячий' };
    const r = composeReply(['availability', 'delivery'], ctx({ advert: unknown }), templates);
    expect(r.intents).toEqual(['availability']);
    expect(r.text).not.toContain('Новою Поштою');
    expect(r.skipped[0]!.intent).toBe('delivery');
  });

  it('without a shipping section falls back to intents.delivery + SHIPPING_* variants', () => {
    const generic = templatesSchema.parse({
      ...templates,
      shipping: undefined,
      payment: { cod_and_prepay: 'обидва', cod_only: 'тільки наложка', prepay_only: 'тільки передоплата' },
    });
    expect(composeReply(['delivery'], ctx({ shipping: { cod: false, prepay: true } }), generic).text).toContain('тільки передоплата');
    expect(composeReply(['delivery'], ctx({ shipping: { cod: true, prepay: true } }), generic).text).toContain('обидва');
  });

  it('condition needs advert notes; otherwise it is skipped', () => {
    const skipped = composeReply(['condition'], ctx(), templates);
    expect(skipped.text).toBe('');
    expect(skipped.skipped[0]!.intent).toBe('condition');

    const r = composeReply(['condition'], ctx({ notes: { condition: 'як нова', kit: 'ноутбук, зарядка' } }), templates);
    expect(r.text).toContain('Стан: як нова');
    expect(r.text).toContain('Комплектація: ноутбук, зарядка');
    expect(r.text).not.toContain('Акумулятори');
  });
});

describe('composeReply: bargaining', () => {
  const fixed = { ...advert, negotiable: false };

  it('answers "Торг відсутній" and combines with other intents', () => {
    const r = composeReply(['availability', 'bargain'], ctx({ advert: fixed }), templates);
    expect(r.intents).toEqual(['availability', 'bargain']);
    expect(r.text).toBe('Добрий день!\nТак, ноутбук в наявності.\nНа жаль, торг відсутній. У моєму профілі є й інші пропозиції на різний бюджет.');
  });

  it('uses the military wording when the buyer mentions service', () => {
    const r = composeReply(['bargain'], ctx({ advert: fixed, military: true }), templates);
    expect(r.text).toBe('Добрий день!\nНа жаль, немає можливості зробити знижку.');
  });

  it('does not deny bargaining when the OLX advert is marked negotiable', () => {
    const r = composeReply(['bargain'], ctx({ advert: { ...advert, negotiable: true } }), templates);
    expect(r.text).toBe('');
    expect(r.skipped[0]).toEqual({ intent: 'bargain', reason: 'в оголошенні на OLX вказано «торг»' });
  });

  it('older templates.json without bargain keys still loads with defaults', () => {
    const { bargain: _b, bargain_military: _m, ...rest } = JSON.parse(readFileSync('config/templates.example.json', 'utf8')).intents;
    const t = templatesSchema.parse({ ...JSON.parse(readFileSync('config/templates.example.json', 'utf8')), intents: rest });
    expect(t.intents.bargain).toBe('Торг відсутній.');
    expect(t.intents.bargain_military).toBe('На жаль, немає можливості зробити знижку.');
  });
});

describe('decideAutoReply', () => {
  const base = {
    intents: ['availability' as const],
    alreadyAnswered: new Set<never>(),
    openDraftIntents: new Set<never>(),
    lastOwnerMsgAt: null,
    cooldownMin: 30,
    now: 1_000_000_000,
  };

  it('allows a fresh question', () => {
    expect(decideAutoReply(base)).toEqual({ allow: true, intents: ['availability'] });
  });

  it('blocks when the owner wrote recently', () => {
    const d = decideAutoReply({ ...base, lastOwnerMsgAt: base.now - 10 * 60_000 });
    expect(d).toEqual({ allow: false, reason: 'ви писали в цьому треді 10 хв тому' });
    expect(decideAutoReply({ ...base, lastOwnerMsgAt: base.now - 31 * 60_000 }).allow).toBe(true);
  });

  it('never repeats an answered intent and filters partially answered ones', () => {
    expect(decideAutoReply({ ...base, alreadyAnswered: new Set(['availability']) as never }).allow).toBe(false);
    expect(
      decideAutoReply({ ...base, intents: ['availability', 'delivery'], alreadyAnswered: new Set(['availability']) as never }),
    ).toEqual({ allow: true, intents: ['delivery'] });
    expect(decideAutoReply({ ...base, openDraftIntents: new Set(['availability']) as never }).allow).toBe(false);
  });
});

describe('JsonFileStore', () => {
  it('reloads on change and keeps the last valid version on a broken edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olxbot-'));
    const path = join(dir, 'adverts.json');
    writeFileSync(path, JSON.stringify({ adverts: { '1': { kit: 'A' } } }));
    const store = new JsonFileStore(path, advertsConfigSchema, nullLogger).load();
    expect(store.get().adverts['1']!.kit).toBe('A');

    writeFileSync(path, JSON.stringify({ adverts: { '1': { kit: 'B' } } }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    expect(store.get().adverts['1']!.kit).toBe('B');

    writeFileSync(path, '{ broken');
    utimesSync(path, new Date(), new Date(Date.now() + 10_000));
    expect(store.get().adverts['1']!.kit).toBe('B');
  });
});

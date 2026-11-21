import { describe, expect, it } from 'vitest';
import { classify, deliveryTopics, extractOffers, isSmallTalk } from '../../src/rules/classifier.js';

describe('price offers (from real buyer messages)', () => {
  it.each([
    ['8000', [8000]],
    ['5500', [5500]],
    ['7500?', [7500]],
    ['8000-?', [8000]],
    ['6к?', [6000]],
    ['7тис ?', [7000]],
    ['10.000 ?', [10000]],
    ['доброго вечора 6500', [6500]],
    ['Доброго вечора, 15500?', [15500]],
    ['8500 беру', [8500]],
    ['8500 зараз замовляю', [8500]],
    ['2500 можливо?', [2500]],
    ['5 відасте ?', [5]],
    ['За 7 віддасте ?', [7]],
    ['за 8к договоримся?', [8000]],
    ['Готов забрать за 8,5к если уступите конечно', [8500]],
    ['Добрий день! Пропоную 8000', [8000]],
    ['Предлагаю 5 тысяч грн', [5000]],
    ['Нова пропозиція: 6500.00 грн.', [6500]],
  ] as const)('%s → %j', (text, offers) => {
    expect(extractOffers(text)).toEqual(offers);
    const c = classify(text);
    expect(c.intents).toContain('bargain');
    expect(c.blocked).toBeNull();
  });

  it.each([
    'Так доставка 125 грн Макс',
    'Можна забрати через 10 хвилин можна?',
    'Хочу 2 шт',
    '128 гб?',
    'Також 10?',
    'Завтра на 12 орієнтовно буде зручно якщо заїду ?',
    'Можу забрати за 10 хвилин?',
    'О 19:45 можна?',
    'Хочу купити ноутбук, 0661234567',
  ])('not an offer: %s', (text) => {
    expect(extractOffers(text)).toEqual([]);
  });
});

describe('bargaining phrased with the word "ціна"', () => {
  it.each(['Крайня ціна?', 'Яка крайня ціна буде ?', 'Сколько край цена?', 'Доброго вечора , ціна крайня ?', 'Яка ціна на віддачу??', 'На якій ціні зможемо зійтися?'])(
    '%s → bargain, not a price question',
    (text) => {
      const c = classify(text);
      expect(c.blocked).toBeNull();
      expect(c.intents).toEqual(['bargain']);
      expect(c.bargainExplicit).toBe(true);
    },
  );
});

describe('acknowledgements are small talk', () => {
  it.each(['🤝', 'Добре', 'Добре, дякую', '+, дякую.', 'Зрозумів', 'Ок, дякую', 'Понял', 'Супер', 'Зрозуміло. Дякую.', 'дякую, гарного дня!', '👍', 'Доброго вечора!'])(
    'small talk: %s',
    (text) => expect(isSmallTalk(text)).toBe(true),
  );
  it.each(['Так', 'Добре?', 'Добре, а коли відправите?', 'Є', 'Беру'])('not small talk: %s', (text) => expect(isSmallTalk(text)).toBe(false));
});

describe('orders, delivery details and payments', () => {
  it.each([
    ['Доброго дня, хочу замовити', ['order']],
    ['Беру', ['order']],
    ['Можна замовити?', ['order']],
    ['Беру / Відправляєте НП післяплатою?', ['delivery', 'order']],
    ['Вітаю! Можна замовити олх доставкою?', ['delivery', 'order']],
  ] as const)('%s → %j', (text, intents) => {
    const c = classify(text);
    expect(c.blocked).toBeNull();
    expect(c.intents).toEqual(intents);
  });

  it('a counter-offer is bargaining, not an order', () => {
    expect(classify('За 6500 беру').intents).toEqual(['bargain']);
  });

  it('"чому я не можу замовити?" is not an order', () => {
    expect(classify('Чому я не можу замовити олх доставкою?').intents).not.toContain('order');
  });

  it.each([
    'Іваненко Петро\n0661234567\nКиїв, відділення 25',
    'Харків / Нп 138 / Петренко Іван / 0501234567',
    'Сидоренко Олег Петрович, відділення 38, м Одеса',
    'Дніпро, поштомат 12345',
    'Давайте наложкой / Одеса / Нова пошта 12 / Мельник Олег',
  ])('delivery details → order_details only: %s', (text) => {
    const c = classify(text);
    expect(c.blocked).toBeNull();
    expect(c.intents).toEqual(['order_details']);
  });

  it('a request to pay to someone\'s card is not delivery details', () => {
    const c = classify('ПІСЛЯ ОПЛАТИ ОБОВ’ЯЗКОВО НАДІШЛІТЬ СКРІНШОТ ОПЛАТИ!\n💳 Карта Банку: 4441 1111 2222 3333\nОлександр, Нова пошта 12');
    expect(c.intents).not.toContain('order_details');
  });

  it('a question with a branch number is not delivery details', () => {
    expect(classify('Можна на відділення 5 відправити?').intents).not.toContain('order_details');
  });

  it.each(['Скинув', 'Скинув предоплату', 'Закинув 500', 'Переказав Вам 100 грн'])('payment report → paid: %s', (text) => {
    expect(classify(text).blocked).toBe('paid');
  });
  it('"я б оплатив доставку" is not a payment report', () => {
    expect(classify('Я би доставку наприклад оплатив').blocked).not.toBe('paid');
  });
});

describe('photo requests', () => {
  it.each(['Скиньте фото', 'Скиньте, будь ласка, фото комплекту', 'А фото є?', 'Можна фото?', 'Фото комплекту можна?', 'Покажіть фото'])(
    'photo: %s',
    (text) => {
      const c = classify(text);
      expect(c.blocked).toBeNull();
      expect(c.intents).toContain('photo');
      expect(c.intents).not.toContain('bargain');
    },
  );

  it.each(['В комплекті все що на фото?', 'Скиньте 500 і беру'])('not a photo request: %s', (text) => {
    expect(classify(text).intents).not.toContain('photo');
  });

  it('configured words of a photo set ask for photos without the word "фото"', () => {
    const opts = { photoWords: ['великий\\s+(комплект|набір)'] };
    expect(classify('А що входить у великий набір?').intents).not.toContain('photo');
    expect(classify('А що входить у великий набір?', false, opts).intents).toContain('photo');
  });

  it('"скиньте карту / номер" is not bargaining', () => {
    expect(classify('Скиньте карту, оплачу').intents).not.toContain('bargain');
    expect(classify('Скиньте 500?').intents).toContain('bargain');
  });
});

describe('seller-specific pickup words', () => {
  it('come from the config, not from the code', () => {
    expect(classify('Ви в центрі?').intents).not.toContain('pickup');
    expect(classify('Ви в центрі?', false, { pickupWords: ['центр'] }).intents).toEqual(['pickup']);
  });
});

describe('deliveryTopics', () => {
  it.each([
    ['олх доставкою відпраляєте', ['olx']],
    ['OLX доставка можлива?', ['olx']],
    ['Наложкою відправите?', ['cod']],
    ['Можна оплата при отриманні?', ['cod']],
    ['Без передоплати відправите?', ['cod']],
    ['Укрпоштою можна?', ['ukrposhta']],
    ['Наложкою чи олх доставкою?', ['olx', 'cod']],
    ['Відправите Новою Поштою?', []],
  ])('%s', (text, expected) => {
    expect(deliveryTopics(text)).toEqual(expected);
  });
});

const ok = (text: string) => {
  const c = classify(text);
  expect(c.blocked, `"${text}" should be auto-answerable, got ${c.blocked}`).toBeNull();
  return c.intents;
};
const blocked = (text: string, att = false) => classify(text, att).blocked;

describe('classify: auto-answerable intents', () => {
  it.each([
    ['Актуально?', ['availability']],
    ['ЩЕ АКТУАЛЬНО???', ['availability']],
    ['Добрий день, ще продається?', ['availability']],
    ['Еще продается?', ['availability']],
    ['В наявності є?', ['availability']],
    ['Есть в наличии?', ['availability']],
    ['Ще не продали?', ['availability']],
    ['Доставка можлива?', ['delivery']],
    ['Відправите новою поштою?', ['delivery']],
    ['Отправите Новой почтой?', ['delivery']],
    ['Можна НП накладеним платежем?', ['delivery']],
    ['Наложенным платежом отправите?', ['delivery']],
    ['Самовивіз можливий?', ['pickup']],
    ['Де можна забрати?', ['pickup']],
    ['Где можно посмотреть?', ['pickup']],
    ['Можна подивитись сьогодні?', ['pickup']],
    ['Що в комплекті?', ['condition']],
    ['Який стан ноутбука?', ['condition']],
    ['Какое состояние?', ['condition']],
    ['Скільки акумуляторів?', ['condition']],
    ['Подряпини є?', ['condition']],
    ['Актуально? Відправите НП?', ['availability', 'delivery']],
    // bargaining → fixed "no bargaining" answer
    ['Торг можливий?', ['bargain']],
    ['Актуально? Торг є?', ['availability', 'bargain']],
    ['Скинете трохи?', ['bargain']],
    ['Скиньте 500', ['bargain']],
    ['Знижка буде?', ['bargain']],
    ['А дешевше?', ['bargain']],
    ['За 7000 віддасте?', ['bargain']],
    ['За 7 000 заберу сьогодні', ['pickup', 'bargain']],
    ['Даю 6500 грн', ['bargain']],
    ['Остання ціна?', ['bargain']],
    ['Ціна остаточна?', ['bargain']],
    ['Последняя цена?', ['bargain']],
    ['Може домовимось?', ['bargain']],
  ] as const)('%s → %j', (text, intents) => {
    expect(ok(text)).toEqual(intents);
  });
});

describe('classify: military', () => {
  it.each([
    'Я військовий, зробите знижку?',
    'Для ЗСУ скинете?',
    'Беру для хлопців на фронт, дешевше можна?',
    'Я з 47 бригади, торг є?',
    'Военному скидка будет?',
    'Я служу, можна знижку?',
    'Захиснику знижка є?',
  ])('%s', (text) => {
    const c = classify(text);
    expect(c.military).toBe(true);
    expect(c.intents).toContain('bargain');
    expect(c.blocked).toBeNull();
  });

  it.each(['Фронтальний екран працює? Торг є?', 'Торг є?', 'Службу доставки яку використовуєте?'])('not military: %s', (text) => {
    expect(classify(text).military).toBe(false);
  });
});

describe('classify: never auto-answer', () => {
  it.each([
    ['Яка ціна?', 'price'],
    ['Скільки коштує з доставкою? Торг є?', 'price'],
    ['Обмін або знижка?', 'exchange'],
    ['Цена?', 'price'],
    ['Скільки коштує з доставкою?', 'price'],
    ['Сколько стоит?', 'price'],
    ['Обмін на планшет цікавить?', 'exchange'],
    ['Обменяете на телефон?', 'exchange'],
    ['Привіт', 'unknown'],
    ['Можна ваш номер телефону?', 'unknown'],
    ['', 'empty'],
  ] as const)('%s → %s', (text, reason) => {
    expect(blocked(text)).toBe(reason);
  });

  it('blocks messages with attachments even if they ask a known question', () => {
    const c = classify('Актуально?', true);
    expect(c.blocked).toBe('attachment');
    expect(c.intents).toEqual(['availability']);
  });

  it('does not treat time expressions as price offers', () => {
    expect(blocked('Можу забрати за 10 хвилин?')).toBeNull();
  });
});

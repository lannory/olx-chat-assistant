import { describe, expect, it, vi } from 'vitest';
import { ADVERT_ID, createHarness, OWNER_CHAT, STRANGER_CHAT } from './harness.js';

describe('draft mode (default)', () => {
  it('proposes a template draft with buttons and sends it only after "Надіслати"', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Добрий день! Ще актуально?');

    expect(h.olx.sent).toHaveLength(0);
    const card = h.lastCard()!;
    expect(card.payload.chat_id).toBe(OWNER_CHAT);
    const text = card.payload.text as string;
    expect(text).toContain('Ноутбук Lenovo ThinkPad T480');
    expect(text).toContain('9 000 грн');
    expect(text).toContain('Олег');
    expect(text).toContain('Ще актуально?');
    expect(text).toContain('Чернетка');
    expect(text).toContain('olx.ua/d/uk/obyavlenie');
    const buttons = h.buttons(card).map((b) => b.text);
    expect(buttons).toEqual(
      expect.arrayContaining(['✅ Надіслати', '✏️ Редагувати', '⏭ Пропустити', '💬 Відповісти', '📋 Шаблони', '👁 Прочитано', '🔕 Ігнорувати тред']),
    );

    const sendBtn = h.buttons(card).find((b) => b.text === '✅ Надіслати')!;
    await h.press(sendBtn.callback_data, h.messageIdOf(card));
    expect(h.olx.sent).toHaveLength(1);
    expect(h.olx.sent[0]!.text).toContain('ноутбук в наявності');
    const edited = h.sent('editMessageText').at(-1)!;
    expect(edited.payload.text).toContain('Надіслано');

    // Double click does not send twice.
    await h.press(sendBtn.callback_data, h.messageIdOf(card));
    expect(h.olx.sent).toHaveLength(1);

    // The same question later: no new draft, only a forward.
    h.clock.now += 3600_000;
    await h.buyerSays('Так актуально чи ні?');
    const second = h.lastCard()!;
    expect(second.payload.text).toContain('вже відповідали');
    expect(h.buttons(second).map((b) => b.text)).not.toContain('✅ Надіслати');
  });

  it('bot-sent template does not count as an owner message (no cooldown)', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Актуально?');
    const card = h.lastCard()!;
    await h.press(h.buttons(card)[0]!.callback_data, h.messageIdOf(card));
    await h.poller.tick(); // poller sees our sent message
    expect(h.db.getThread('t1')!.lastOwnerMsgAt).toBeNull();

    await h.buyerSays('Відправите новою поштою?');
    expect(h.lastCard()!.payload.text).toContain('Чернетка');
  });

  it('greets only in the first reply of a thread', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('В наявності?');
    expect(h.db.getDraft(1)!.text).toMatch(/^Добрий день!/);

    // Second question while the first draft is still waiting: no second greeting.
    await h.buyerSays('Відправляєте наложкою?');
    const second = h.db.getDraft(2)!;
    expect(second.intent).toBe('delivery');
    expect(second.text).not.toContain('Добрий день');

    // Same after the first reply was actually sent.
    await h.press(h.buttons(h.lastCard()!)[0]!.callback_data, h.messageIdOf(h.lastCard()!));
    await h.poller.tick();
    await h.buyerSays('А самовивіз можна?');
    expect(h.db.getDraft(3)!.text).not.toContain('Добрий день');
  });

  it('the pasted case: "олх доставкою відпраляєте" gets the OLX answer with the computed price', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('олх доставкою відпраляєте');
    expect(h.db.getDraft(1)!.text).toBe(
      'Добрий день!\nOLX Доставкою відправляю, але до вартості додається комісія OLX, тобто вартість буде 9 290 грн. Також відправляю накладеним платежем без передоплати.',
    );
  });

  it('a bare price offer gets "торг відсутній"; the full price is not treated as bargaining', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('8000');
    expect(h.db.getDraft(1)!.text).toBe('Добрий день!\nНа жаль, торг відсутній. У моєму профілі є й інші пропозиції на різний бюджет.');

    const h2 = createHarness();
    await h2.init();
    await h2.buyerSays('9000 беру');
    expect(h2.db.getDraft(1)).toBeNull();
    expect(h2.lastCard()!.payload.text).toContain('покупець пропонує ціну оголошення або більше');

    const h3 = createHarness();
    await h3.init();
    await h3.buyerSays('За 7 віддасте?'); // 7 = 7 000 for a 9 000 грн laptop
    expect(h3.db.getDraft(1)!.intent).toBe('bargain');
  });

  it('"хочу замовити" asks for delivery details; via OLX Delivery it does not', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Доброго дня, хочу замовити');
    expect(h.db.getDraft(1)!.text).toBe(
      'Добрий день!\nТак, ноутбук в наявності.\nНапишіть, будь ласка, дані для відправки: ПІБ, номер телефону, місто та номер відділення Нової Пошти.',
    );

    const h2 = createHarness();
    await h2.init();
    await h2.buyerSays('Вітаю! Можна замовити олх доставкою?');
    expect(h2.db.getDraft(1)!.intent).toBe('availability,delivery');
    expect(h2.db.getDraft(1)!.text).not.toContain('дані для відправки');
  });

  it('delivery details get "Дякую за замовлення!"', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Хочу замовити');
    await h.press(h.buttons(h.lastCard()!)[0]!.callback_data, h.messageIdOf(h.lastCard()!));
    await h.poller.tick();
    await h.buyerSays('Іваненко Петро\n0661234567\nКиїв, відділення 25');
    const draft = h.db.getDraft(2)!;
    expect(draft.intent).toBe('order_details');
    expect(draft.text).toBe('Дякую за замовлення!'); // no second greeting
    expect(h.lastCard()!.payload.text).toContain('дані для відправки');

    const auto = createHarness({ mode: 'auto' });
    await auto.init();
    await auto.buyerSays('Харків / Нп 138 / Петренко Іван / 0501234567');
    expect(auto.olx.sent.map((s) => s.text)).toEqual(['Добрий день!\nДякую за замовлення!']);
  });

  it('the reported case: owner edited the reply, details came within the cooldown → template, not LLM', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('Дякую за дані, замовлення буде відправлено накладеним платежем Новою поштою.') };
    const h = createHarness({ drafter });
    await h.init();
    await h.buyerSays('Доброго дня, хочу замовити');
    const card = h.lastCard()!;
    await h.press(h.buttons(card).find((b) => b.text === '✏️ Редагувати')!.callback_data, h.messageIdOf(card));
    await h.text('Доброго дня! Напишіть, будь ласка, дані для відправки.', { replyTo: h.messageIdOf(h.sent().at(-1)!) });
    await h.poller.tick();
    expect(h.db.getThread('t1')!.lastOwnerMsgAt).toBe(h.clock.now); // owner cooldown is running

    h.clock.now += 14 * 60_000;
    await h.buyerSays('Житомир, нп1\n0661234567\nПетренко Іван Іванович');
    const draft = h.db.getDraft(2)!;
    expect(draft.source).toBe('rule');
    expect(draft.text).toBe('Дякую за замовлення!');

    // The buyer sends the same details again: already answered → forwarded, still no LLM draft.
    await h.press(h.buttons(h.lastCard()!)[0]!.callback_data, h.messageIdOf(h.lastCard()!));
    await h.buyerSays('Житомир, нп1\n0661234567\nПетренко Іван Іванович');
    expect(h.db.getDraft(3)).toBeNull();
    expect(drafter.draft).not.toHaveBeenCalled();
  });

  it('thanks, delivery details and payment reports never get an LLM draft', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('LLM') };
    const h = createHarness({ drafter });
    await h.init();
    await h.buyerSays('🤝');
    await h.buyerSays('Іваненко Петро\n0661234567\nКиїв, відділення 25');
    expect(h.db.getDraft(1)!.text).toBe('Добрий день!\nДякую за замовлення!');
    await h.buyerSays('Скинув');
    expect(h.lastCard()!.payload.text).toContain('повідомляє про оплату');
    expect(drafter.draft).not.toHaveBeenCalled();
  });

  it('a photo request gets a draft with the configured photos; they go out as OLX attachments', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Скиньте фото великого комплекту');
    const draft = h.db.getDraft(1)!;
    expect(draft.intent).toBe('photo');
    expect(draft.text).toBe('Добрий день!\nОсь фото великого комплекту аксесуарів:');
    expect(draft.photos).toEqual(['https://example.com/photos/big-kit-1.jpg', 'https://example.com/photos/big-kit-2.jpg']);
    expect(h.lastCard()!.payload.text).toContain('+ 2 фото');

    await h.press(h.buttons(h.lastCard()!)[0]!.callback_data, h.messageIdOf(h.lastCard()!));
    expect(h.olx.sent).toEqual([
      { threadId: 't1', text: 'Добрий день!\nОсь фото великого комплекту аксесуарів:', photos: draft.photos },
    ]);
  });

  it('"що за великий набір за 1500?" asks for the kit photos, the listed price is not an offer', async () => {
    const h = createHarness();
    h.olx.adverts.get(ADVERT_ID)!.description = 'Допродаж:\n- великий набір аксесуарів (за фото пишіть) за 1500 грн.';
    await h.init();
    await h.buyerSays('А що за великий набір за 1500?');
    const draft = h.db.getDraft(1)!;
    expect(draft.intent).toBe('photo');
    expect(draft.photos).toHaveLength(2);
  });

  it('a photo request the sets do not cover ("фото серійника") is not answered with the kit photos', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Можете надіслати фото серійника?');
    expect(h.db.getDraft(1)).toBeNull();
    expect(h.lastCard()!.payload.text).toContain('незрозуміло, який набір фото');
  });

  it('"📷 Фото" button sends a photo set by hand', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Можу забрати за 10 хвилин?');
    const card = h.lastCard()!;
    expect(h.buttons(card).map((b) => b.text)).toContain('📷 Фото');
    await h.press('t:ph', h.messageIdOf(card));
    await h.press('p:big_kit', h.messageIdOf(card));
    expect(h.olx.sent.at(-1)).toEqual({
      threadId: 't1',
      text: 'Ось фото великого комплекту аксесуарів:',
      photos: ['https://example.com/photos/big-kit-1.jpg', 'https://example.com/photos/big-kit-2.jpg'],
    });
  });

  it('"є" as the first message asks about availability; after the seller wrote it is an answer', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('LLM') };
    const h = createHarness({ drafter });
    await h.init();
    await h.buyerSays('є');
    expect(h.db.getDraft(1)!.text).toBe('Добрий день!\nТак, ноутбук в наявності.');
    await h.press(h.buttons(h.lastCard()!)[0]!.callback_data, h.messageIdOf(h.lastCard()!));
    await h.poller.tick();

    await h.buyerSays('Є');
    expect(h.db.getDraft(2)).toBeNull();
    expect(h.lastCard()!.payload.text).toContain('відповідь покупця на ваше запитання');
    expect(drafter.draft).not.toHaveBeenCalled();
  });

  it('a greeting alone is greeted back by the time of day; thanks are not answered', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Добрий день');
    expect(h.db.getDraft(1)!.text).toBe('Добрий день!');
    expect(h.db.getDraft(1)!.intent).toBe('hello');
    // The question that follows is answered without a second greeting.
    await h.buyerSays('Ще є?');
    expect(h.db.getDraft(2)!.text).toBe('Так, ноутбук в наявності.');

    const evening = createHarness({ startHourKyiv: 21 });
    await evening.init();
    await evening.buyerSays('Вітаю 🙂');
    expect(evening.db.getDraft(1)!.text).toBe('Добрий вечір!');

    const thanks = createHarness();
    await thanks.init();
    await thanks.buyerSays('Дякую');
    expect(thanks.db.getDraft(1)).toBeNull();
  });

  it('skip closes the draft', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Можна самовивіз?');
    const card = h.lastCard()!;
    const skip = h.buttons(card).find((b) => b.text === '⏭ Пропустити')!;
    await h.press(skip.callback_data, h.messageIdOf(card));
    expect(h.sent('editMessageText').at(-1)!.payload.text).toContain('пропущено');
    expect(h.olx.sent).toHaveLength(0);
  });

  it('edit: ForceReply prompt, the reply is sent instead of the draft', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Що в комплекті?');
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('Комплектація: ноутбук, зарядка, коробка');
    await h.press(h.buttons(card).find((b) => b.text === '✏️ Редагувати')!.callback_data, h.messageIdOf(card));
    const prompt = h.sent().at(-1)!;
    expect(prompt.payload.reply_markup).toMatchObject({ force_reply: true });

    await h.text('Ноутбук, зарядка і коробка. Ще дам мишку 🙂', { replyTo: h.messageIdOf(prompt) });
    expect(h.olx.sent.map((s) => s.text)).toEqual(['Ноутбук, зарядка і коробка. Ще дам мишку 🙂']);
    expect(h.db.getDraft(1)!.status).toBe('sent');
    // Owner-typed text starts the cooldown.
    expect(h.db.getThread('t1')!.lastOwnerMsgAt).toBe(h.clock.now);
  });

  it('price questions are only forwarded; owner answers via "Відповісти"', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Скільки коштує з доставкою?');
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('Без автовідповіді');
    expect(card.payload.text).toContain('питання про ціну');
    expect(h.buttons(card).map((b) => b.text)).not.toContain('✅ Надіслати');

    await h.press('t:reply', h.messageIdOf(card));
    const prompt = h.sent().at(-1)!;
    await h.text('9000 + доставка за тарифом НП', { replyTo: h.messageIdOf(prompt) });
    expect(h.olx.sent).toEqual([{ threadId: 't1', text: '9000 + доставка за тарифом НП' }]);
    expect(h.olx.markedRead).toContain('t1');
  });

  it('bargaining gets a "Торг відсутній" draft, combined with other answers', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Актуально? За 7000 віддасте?');
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('шаблон: наявність, торг');
    await h.press(h.buttons(card)[0]!.callback_data, h.messageIdOf(card));
    expect(h.olx.sent[0]!.text).toBe('Добрий день!\nТак, ноутбук в наявності.\nНа жаль, торг відсутній. У моєму профілі є й інші пропозиції на різний бюджет.');

    // Asking again later: answered once per thread → forwarded to the owner.
    h.clock.now += 3600_000;
    await h.buyerSays('А за 8000?');
    expect(h.lastCard()!.payload.text).toContain('вже відповідали');
  });

  it('adverts marked negotiable on OLX never get "Торг відсутній"', async () => {
    const h = createHarness();
    h.olx.adverts.get(ADVERT_ID)!.negotiable = true;
    await h.init();
    await h.buyerSays('Торг можливий?');
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('Без автовідповіді');
    expect(card.payload.text).toContain('вказано «торг»');
    expect(h.db.countDraftsByStatus()).toEqual({});
  });

  it('replying directly to a card also works', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Обмін цікавить?');
    const card = h.lastCard()!;
    await h.text('Ні, дякую', { replyTo: h.messageIdOf(card) });
    expect(h.olx.sent.map((s) => s.text)).toEqual(['Ні, дякую']);
  });

  it('attachments are forwarded without a reply', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Актуально?', 't1', { hasAttachments: true, attachments: [{ name: 'a.jpg', url: 'x' }] });
    expect(h.lastCard()!.payload.text).toContain('вкладення');
    expect(h.db.countDraftsByStatus()).toEqual({});
  });

  it('quick templates are sent from the submenu', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Цікаво, яка ціна?');
    const card = h.lastCard()!;
    await h.press('t:tpl', h.messageIdOf(card));
    const kb = h.apiCalls.filter((c) => c.method === 'editMessageReplyMarkup').at(-1)!;
    const sold = h.buttons(kb).find((b) => b.text === 'Продано')!;
    await h.press(sold.callback_data, h.messageIdOf(card));
    expect(h.olx.sent[0]!.text).toContain('уже замовили');
  });

  it('ignore thread: no more cards for it', async () => {
    const h = createHarness();
    await h.init();
    await h.buyerSays('Привіт, торг?');
    const card = h.lastCard()!;
    await h.press('t:ign', h.messageIdOf(card));
    expect(h.db.getThread('t1')!.ignored).toBe(true);
    const before = h.sent().length;
    await h.buyerSays('Алло?');
    expect(h.sent().length).toBe(before);
  });

  it('LLM drafts appear only in draft mode, for messages without a template', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('Добрий день! Ціну уточню й відпишу.') };
    const h = createHarness({ drafter });
    await h.init();
    await h.buyerSays('Можна номер телефону?');
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('LLM');
    expect(h.olx.sent).toHaveLength(0);
    expect(drafter.draft).toHaveBeenCalledOnce();

    h.settings.mode = 'auto';
    await h.buyerSays('А ще питання: є чохол?');
    expect(drafter.draft).toHaveBeenCalledOnce();
    expect(h.olx.sent).toHaveLength(0);
  });

  it('condition question without advert notes: LLM drafts the whole reply from the description', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('Добрий день! Так, ноутбук в наявності, стан ідеальний.') };
    const h = createHarness({ drafter, notes: null });
    await h.init();
    await h.buyerSays('Ще в наявності? Який стан, є подряпини?');

    expect(drafter.draft).toHaveBeenCalledOnce();
    const input = drafter.draft.mock.calls[0]![0];
    expect(input.advert?.description).toBe('Ноутбук в ідеальному стані');
    const draft = h.db.getDraft(1)!;
    expect(draft.source).toBe('llm');
    expect(draft.text).toBe('Добрий день! Так, ноутбук в наявності, стан ідеальний.');
    expect(h.lastCard()!.payload.text).toContain('відповідь за описом оголошення');
    expect(h.olx.sent).toHaveLength(0);
  });

  it('delivery question when the item category is unclear: LLM draft instead of guessing the terms', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('Добрий день! Так, в наявності. Умови доставки уточню.') };
    const h = createHarness({ drafter });
    h.olx.adverts.get(ADVERT_ID)!.title = 'Велосипед дитячий';
    await h.init();
    await h.buyerSays('В наявності? Відправите наложкою?');
    expect(drafter.draft).toHaveBeenCalledOnce();
    expect(h.db.getDraft(1)!.source).toBe('llm');
  });

  it('condition question without notes: falls back to the template draft when the LLM gives nothing', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue(null) };
    const h = createHarness({ drafter, notes: null });
    await h.init();
    await h.buyerSays('Ще в наявності? Який стан?');
    const draft = h.db.getDraft(1)!;
    expect(draft.source).toBe('rule');
    expect(draft.text).toContain('ноутбук в наявності');
  });

  it('condition question with advert notes: template, no LLM call', async () => {
    const drafter = { draft: vi.fn().mockResolvedValue('LLM') };
    const h = createHarness({ drafter });
    await h.init();
    await h.buyerSays('Який стан?');
    expect(drafter.draft).not.toHaveBeenCalled();
    expect(h.db.getDraft(1)!.text).toContain('Стан: як нова');
  });
});

describe('auto mode', () => {
  it('sends template replies immediately and sends a copy to Telegram', async () => {
    const h = createHarness({ mode: 'auto' });
    await h.init();
    await h.buyerSays('Відправите НП накладеним платежем?');
    expect(h.olx.sent).toHaveLength(1);
    expect(h.olx.sent[0]!.text).toBe('Добрий день!\nТак, відправляю накладеним платежем без передоплати.');
    expect(h.lastCard()!.payload.text).toContain('Автовідповідь надіслано');
  });

  it('on OLX send failure keeps the draft with buttons and allows a retry', async () => {
    const h = createHarness({ mode: 'auto' });
    await h.init();
    const spy = vi.spyOn(h.olx, 'sendMessage').mockRejectedValueOnce(new Error('OLX 500'));
    await h.buyerSays('Актуально?');
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('Не вдалося надіслати');
    expect(h.db.listAutoRepliedIntents('t1')).toEqual([]);
    expect(h.db.getDraft(1)!.status).toBe('pending');

    spy.mockRestore();
    await h.press(h.buttons(card)[0]!.callback_data, h.messageIdOf(card));
    expect(h.olx.sent).toHaveLength(1);
    expect(h.db.listAutoRepliedIntents('t1')).toEqual(['availability']);
  });

  it('does not answer when the owner wrote in the thread within the cooldown', async () => {
    const h = createHarness({ mode: 'auto' });
    await h.init();
    h.olx.addMessage('t1', 'sent', 'Привіт, так, продаю', '2026-11-19 09:50:00'); // owner, 10 min ago (UTC)
    await h.buyerSays('Де можна забрати?');
    expect(h.olx.sent).toHaveLength(0);
    expect(h.lastCard()!.payload.text).toContain('ви писали в цьому треді 10 хв тому');
  });

  it('quiet hours: postpones until the morning, then sends', async () => {
    const h = createHarness({ mode: 'auto', quietHours: { start: 23, end: 8 }, startHourKyiv: 23 });
    await h.init();
    await h.buyerSays('Ще продається?');
    expect(h.olx.sent).toHaveLength(0);
    const card = h.lastCard()!;
    expect(card.payload.text).toContain('Тихі години');
    expect(card.payload.text).toContain('08:00');

    h.clock.now += 4 * 3600_000; // 03:00
    await h.poller.tick();
    expect(h.olx.sent).toHaveLength(0);

    h.clock.now += 5 * 3600_000 + 60_000; // 08:01
    await h.poller.tick();
    expect(h.olx.sent).toHaveLength(1);
    expect(h.sent('editMessageText').at(-1)!.payload.text).toContain('після тихих годин');
  });

  it('evening message → "Добрий вечір!"; a reply postponed to the morning → "Добрий день!"', async () => {
    const evening = createHarness({ startHourKyiv: 20 });
    await evening.init();
    await evening.buyerSays('Актуально?');
    expect(evening.db.getDraft(1)!.text).toBe('Добрий вечір!\nТак, ноутбук в наявності.');

    const night = createHarness({ mode: 'auto', quietHours: { start: 23, end: 8 }, startHourKyiv: 23 });
    await night.init();
    await night.buyerSays('Актуально?');
    night.clock.now += 9 * 3600_000 + 60_000; // 08:01
    await night.poller.tick();
    expect(night.olx.sent[0]!.text).toBe('Добрий день!\nТак, ноутбук в наявності.');
  });

  it('quiet hours: a scheduled reply is dropped if the owner answered in the meantime', async () => {
    const h = createHarness({ mode: 'auto', quietHours: { start: 23, end: 8 }, startHourKyiv: 23 });
    await h.init();
    await h.buyerSays('Актуально?');
    h.clock.now += 60_000;
    h.olx.addMessage('t1', 'sent', 'Так!', '2026-11-19 21:01:00');
    h.clock.now += 9 * 3600_000;
    await h.poller.tick();
    expect(h.olx.sent).toHaveLength(0);
    expect(h.db.getDraft(1)!.status).toBe('superseded');
  });

  it('military buyer asking for a discount gets the polite wording, owner sees a note', async () => {
    const h = createHarness({ mode: 'auto' });
    await h.init();
    await h.buyerSays('Добрий день, я з ЗСУ');
    await h.buyerSays('Можна знижку?');
    expect(h.olx.sent.map((s) => s.text)).toEqual(['Добрий день!\nНа жаль, немає можливості зробити знижку.']);
    expect(h.lastCard()!.payload.text).toContain('покупець згадує військову службу');
  });

  it('forwarding works during quiet hours', async () => {
    const h = createHarness({ mode: 'auto', quietHours: { start: 23, end: 8 }, startHourKyiv: 2 });
    await h.init();
    await h.buyerSays('Обмін на планшет цікавить?');
    expect(h.lastCard()!.payload.text).toContain('Без автовідповіді');
  });
});

describe('telegram access and commands', () => {
  it('ignores chats that are not allowed', async () => {
    const h = createHarness();
    await h.init();
    await h.text('/status', { chatId: STRANGER_CHAT });
    await h.text('/mode auto', { chatId: STRANGER_CHAT });
    expect(h.apiCalls).toHaveLength(0);
    expect(h.settings.mode).toBe('draft');
  });

  it('/status, /mode, /pause, /resume, /templates', async () => {
    const h = createHarness();
    await h.init();
    await h.text('/status');
    const status = h.sent().at(-1)!.payload.text as string;
    expect(status).toContain('Режим:</b> draft');
    expect(status).toContain('Останній успішний poll');

    await h.text('/mode auto');
    expect(h.settings.mode).toBe('auto');
    await h.text('/pause');
    expect(h.poller.isPaused).toBe(true);
    await h.text('/resume');
    expect(h.poller.isPaused).toBe(false);
    await h.text('/templates');
    expect(h.sent().at(-1)!.payload.text).toContain('Швидкі шаблони');
  });

  it('/auth sends the OLX link', async () => {
    const h = createHarness();
    await h.text('/auth');
    expect(h.sent().at(-1)!.payload.text).toContain('https://www.olx.ua/oauth/authorize');
  });
});

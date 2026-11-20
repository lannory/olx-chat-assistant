/**
 * Keyword classifier for buyer messages (Ukrainian + Russian, case-insensitive).
 *
 * Safety first: price questions, exchange offers, attachments and anything unrecognised are never
 * auto-answered — they are only forwarded to the owner. Bargaining ("торг?", "скинете?", "за 7000?")
 * gets a fixed "no bargaining" answer, with a separate wording when the buyer mentions military service.
 */

/** Canonical order = order of paragraphs in a combined reply. */
export const AUTO_INTENTS = ['availability', 'delivery', 'pickup', 'condition', 'bargain', 'order', 'order_details'] as const;
export type Intent = (typeof AUTO_INTENTS)[number];

export type BlockReason = 'price' | 'exchange' | 'attachment' | 'empty' | 'paid' | 'unknown';

/** Blocked messages the owner handles himself without an LLM draft (nothing to answer in words). */
export const NO_LLM_BLOCKS: ReadonlySet<BlockReason> = new Set(['paid', 'empty']);

export interface Classification {
  /** Auto-answerable topics found in the message, in canonical order. */
  intents: Intent[];
  /** Why the message must not be auto-answered (null = may be answered). */
  blocked: BlockReason | null;
  /** The buyer mentions military service (ЗСУ, військовий, фронт…). */
  military: boolean;
  /** Prices the buyer offers ("8000", "6к?", "за 7 500", "пропоную 5 тисяч"), as written (5 = 5, not 5000). */
  offers: number[];
  /** Bargaining in words ("торг?", "скинете?", "крайня ціна?"), not only a number. */
  bargainExplicit: boolean;
}

/** `(?<!\p{L})` = start of a word for Cyrillic too (JS \b only knows ASCII). */
const W = '(?<!\\p{L})';
const re = (src: string) => new RegExp(src, 'iu');

/**
 * "остання ціна", "крайня ціна?", "ціна на віддачу", "на якій ціні зійдемось" — bargaining, not a
 * plain price question.
 */
const BARGAIN_PRICE_PHRASES = [
  new RegExp('(останн|последн|кінцев|конечн|мінімальн|минимальн|найнижч|крайн|край)\\p{L}*\\s+(цін|цен)\\p{L}*', 'giu'),
  new RegExp('(цін|цен)\\p{L}*\\s+(\\p{L}+\\s+)?(остаточн|окончательн|кінцев|конечн|крайн)\\p{L}*', 'giu'),
  new RegExp('(цін|цен)\\p{L}*\\s+(на\\s+)?(віддач|отдач)\\p{L}*', 'giu'),
  new RegExp('(цін|цен)\\p{L}*\\s+(\\p{L}+\\s+)?(зійт|зійд|сойт|сойд|домов|договор)\\p{L}*', 'giu'),
  new RegExp('(по|в)\\s+(ціні|цене)\\s+(\\p{L}+\\s+)?(скин|поступ|уступ|зійт|зійд|сойт|сойд)\\p{L}*', 'giu'),
];

// ---------- Price offers ----------

/** A number as buyers write prices: "8000", "8 000", "8.000", "6500.00", "8,5к", "5 тисяч". */
const NUM = '(\\d{1,3}(?:[ .]\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(к|k|тис\\p{L}*|тыс\\p{L}*)?';
const GREETING =
  '(привіт|привет|вітаю|добрий\\s+(день|вечір|ранок)|доброго\\s+(дня|вечора|ранку)|добрый\\s+(день|вечер)|доброе\\s+утро|доброй\\s+ночі|здравствуйте|здрасте)';
const OFFER_VERBS =
  '(беру|візьму|возьму|заберу|забираю|замовляю|замовлю|заказываю|закажу|можливо|можна|можно|ок|окей|пойдет|піде|підійде|норм|віддасте|відасте|отдадите|отдашь|віддаси|згодні|согласны|домовимось|договоримся)';
/** "10 хвилин", "2 шт", "13 модель", "128 гб", "12-го", "19:45" are not prices. */
const NOT_A_PRICE =
  '(?![\\s-]*(хв|мин|год|час|шт|дн|ден|тиж|нед|гб|gb|тб|tb|мм|см|рок|лет|числ|модел|верс|сер|поз|%|ти(?!\\p{L})|го(?!\\p{L})|й(?!\\p{L})|ї(?!\\p{L})|ої|\\d))';
const OFFER_PATTERNS = [
  // The whole message is a number: "8000", "7500?", "8000-?", "6к?", "доброго вечора 6500"
  new RegExp(`^(${GREETING}[\\s,!.]*)?(за\\s+)?${NUM}\\s*(грн|uah|₴)?[\\s\\-?!.)+]*$`, 'iu'),
  // "8500 беру", "5 відасте?", "2500 можливо?", "8500 зараз замовляю"
  new RegExp(`(?<![\\d\\p{L}:.,-])${NUM}${NOT_A_PRICE}\\s*(грн|uah|₴)?[\\s,]*(\\p{L}+\\s+)?${OFFER_VERBS}(?!\\p{L})`, 'iu'),
  // "пропоную 8000", "предлагаю 5 тысяч", "даю 6500", "можу запропонувати 8", "Нова пропозиція: 6500.00 грн"
  new RegExp(`(пропоную|предлагаю|запропонувати|предложить|даю|дам|пропозиці\\p{L}*|предложени\\p{L}*):?\\s+${NUM}`, 'iu'),
  // "за 7000", "за 7 000", "за 8к" (but not "за 10 хвилин")
  new RegExp(`${W}за\\s+(\\d{1,3}(?:[ .]\\d{3})+|\\d{3,}(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?\\s*(?:к|k|тис\\p{L}*|тыс\\p{L}*))(?![\\d\\p{L}])`, 'iu'),
];

function parseNumber(raw: string, unit: string | undefined): number | null {
  const grouped = /^\d{1,3}(?:[ .]\d{3})+$/.test(raw);
  const n = grouped ? Number(raw.replace(/[ .]/g, '')) : Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const v = unit ? n * 1000 : n;
  // Phone numbers, card numbers, years etc. are not offers.
  return v > 1_000_000 ? null : v;
}

/** Prices offered in the message. Small numbers ("5", "7.5") are returned as is: the caller scales them by the advert price. */
export function extractOffers(text: string): number[] {
  const t = normalize(text);
  const out: number[] = [];
  for (const p of OFFER_PATTERNS) {
    const m = p.exec(t);
    if (!m) continue;
    const num = /(\d{1,3}(?:[ .]\d{3})+|\d+(?:[.,]\d+)?)\s*(к|k|тис\p{L}*|тыс\p{L}*)?/iu.exec(m[0].replace(/^(за\s+)/iu, ''));
    const v = num ? parseNumber(num[1]!, num[2]) : null;
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}

const PATTERNS: Record<Intent, RegExp[]> = {
  availability: [
    re('актуальн'),
    re(`${W}(ще|щ[её]|еще|ещ[её])\\s+(прода|є(?!\\p{L})|есть|в\\s+наявн|в\\s+наличи|можна\\s+купит)`),
    re('наявн'),
    re('в\\s+наличи'),
    re(`${W}(не|вже|уже)\\s+продал`),
    re(`${W}продан[оаи]?\\s*\\?`),
    re(`${W}(є|есть)\\s+ще`),
  ],
  delivery: [
    re('доставк'),
    re('доставит'),
    re('доставите'),
    re(`${W}нов(а|ою|ой|ая|у|ій|ий)?\\s*пошт`),
    re(`${W}н\\.?\\s?п\\.?(?!\\p{L})`),
    re('відправ'),
    re('отправ'),
    re('пересил'),
    re('укрпошт'),
    re('накладен'),
    re('налож'),
    re('післяплат'),
    re(`${W}посилк`),
    re(`${W}посылк`),
  ],
  pickup: [
    re('самовив'),
    re('самовыв'),
    re('забрат'),
    re(`${W}заберу`),
    re('подивит'),
    re('посмотрет'),
    re('глянут'),
    re('зустрі'),
    re('встрет'),
    re('(де|где)\\s+(ви|вы)\\s+(знаходит|находит)'),
    re('(якому|каком)\\s+район'),
    re(`${W}(де|где)\\s+(можна|можно|ви|вы)?\\s*(забрат|подивит|посмотрет|купит)`),
  ],
  condition: [
    re('комплект'),
    re(`${W}(що|что)\\s+(є|есть|входить|входит|йде|идет|ид[её]т)\\s+(в|у|до)\\s`),
    re(`${W}стан(?!\\p{L})`),
    re(`${W}стан(і|ом|у)(?!\\p{L})`),
    re('состояни'),
    re('акумулятор'),
    re('аккумулятор'),
    re('батаре'),
    re('подряпин'),
    re('царапин'),
    re('потерт'),
    re('сколы|скол(?!\\p{L})|скол[иі]'),
    re(`${W}(все\\s+)?(працює|работает)`),
  ],
  bargain: [
    re('торг'),
    re('знижк'),
    re('скидк'),
    re(`${W}скин(ь|ьте|е|ете|ите|еш|ешь|у|ути|уть)(?!\\p{L})`),
    re('дешевш'),
    re('дешевле'),
    re('уступ'),
    re('поступит'),
    re('віддаст|віддаси|віддас|відаст|відаси'),
    re('отдадит|отдашь|отдаст'),
    re('домовим|договорим'),
    re('\\d\\s*(\\$|usd|дол|евро|євро|eur|€)'),
    ...BARGAIN_PRICE_PHRASES.map((p) => new RegExp(p.source, 'iu')),
    // Price offers ("8000", "за 7000", "пропоную 5к") are detected by extractOffers().
  ],
  order: [
    re(`${W}хочу\\s+(за)?(мовит|купит|придбат|взят|заказат|приобрест)`),
    // "можна замовити?" but not "чому я не можу замовити?"
    re(`(?<!не\\s)${W}(можна|можно|можу)\\s+(за)?(мовит|заказат)`),
    re(`${W}(замовляю|заказываю)(?!\\p{L})`),
    re(`${W}(беру|візьму|возьму|куплю)(?!\\p{L})`),
  ],
  // Detected separately (isOrderDetails): the whole message is the buyer's delivery details.
  order_details: [],
};

/** Delivery details (name, phone, branch): the buyer is ordering — the owner checks and ships. */
const PHONE = /\(?\+?\d(?:[\s\-().]*\d){8,}/;
const POSTAL = re('відділ|отдел|поштомат|почтомат|пошт|почт|пункт|(?<!\\p{L})нп(?!\\p{L})|№');
const BRANCH_NUMBER = re(
  `(відділенн\\p{L}*|отделени\\p{L}*|поштомат\\p{L}*|почтомат\\p{L}*|нов\\p{L}*\\s+(пошт|почт)\\p{L}*|${W}нп)\\s*(номер\\s*|№\\s*|#\\s*|n\\s*)?\\d+`,
);
/** "Карта банку: …, надішліть скріншот оплати" — someone asks *the seller* to pay: never thank for an order. */
const PAYMENT_REQUEST = re('карт\\p{L}*\\s+банк|скріншот|скриншот|реквізит|реквизит');
/** "Скинув", "Оплатив", "Закинув 500" — the buyer reports a payment. */
const PAID = re(`${W}(скинув|скинула|скинул|закинув|закинула|закинул|оплатив|оплатила|оплатил|переказав|переказала|перевел|перевела|оплачено)(?!\\p{L})`);

const MILITARY = [
  re('військов'),
  re('военн'),
  re('воєнн'),
  re(`${W}(зсу|всу|тро|ато|оос|убд|дпсу|нгу)(?!\\p{L})`),
  re('воїн|воин'),
  re('захисник|защитник'),
  re(`${W}(боєць|боец|бійц|бойц)`),
  re(`${W}(служу|служив|служил|служим)(?!\\p{L})`),
  re('на\\s+(службі|службе)'),
  // фронт, на фронті, фронтовик — but not "фронтальний екран"
  re(`${W}фронт(у|і|е|ом|ов\\p{L}*)?(?!\\p{L})`),
  re('передов|передок'),
  re('бригад'),
  re('батальйон|батальон'),
  re('мобілізов|мобилизов'),
  re('ветеран'),
  re('нацгвард'),
  re('прикордонник|пограничник'),
  re(`${W}арм(ія|ії|ію|ия|ии|ию|ійськ|ейск)`),
  re('солдат'),
];

const BLOCKERS: { reason: 'exchange' | 'price'; patterns: RegExp[] }[] = [
  {
    reason: 'exchange',
    patterns: [re('обмін'), re('обмен'), re('обміня'), re('обменя'), re(`${W}мiняю|${W}міняю|${W}меняю`)],
  },
  {
    reason: 'price',
    patterns: [
      re(`${W}цін(а|и|у|і|ою)?(?!\\p{L})`),
      re(`${W}цен(а|ы|у|е|ой)?(?!\\p{L})`),
      re(`${W}вартіст`),
      re(`${W}стоимост`),
      re('скільки\\s+(коштує|буде|хочете|просите|за)'),
      re('сколько\\s+(стоит|будет|хотите|просите|за)'),
      re(`${W}по\\s+чому`),
      re(`${W}почем`),
    ],
  },
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[’'`ʼ]/g, '’').replace(/\s+/g, ' ').trim();
}

export function isMilitary(text: string): boolean {
  const t = normalize(text);
  return MILITARY.some((p) => p.test(t));
}

export interface ClassifyOptions {
  /** Seller-specific words that mean pickup (district names etc.), as regex sources. */
  pickupWords?: readonly string[];
}

const extraPatterns = new Map<string, RegExp>();
function matchesAny(sources: readonly string[] | undefined, t: string): boolean {
  return (sources ?? []).some((s) => {
    let p = extraPatterns.get(s);
    if (!p) extraPatterns.set(s, (p = re(s)));
    return p.test(t);
  });
}

export function classify(text: string, hasAttachments = false, opts: ClassifyOptions = {}): Classification {
  const t = normalize(text);
  const offers = extractOffers(t);
  const bargainExplicit = PATTERNS.bargain.some((p) => p.test(t));
  let intents = AUTO_INTENTS.filter((intent) => {
    if (intent === 'bargain') return bargainExplicit || offers.length > 0;
    if (intent === 'pickup' && matchesAny(opts.pickupWords, t)) return true;
    return PATTERNS[intent].some((p) => p.test(t));
  });
  // "8500 беру" is a counter-offer, not an order at the advert price.
  if (intents.includes('bargain')) intents = intents.filter((i) => i !== 'order');
  const military = MILITARY.some((p) => p.test(t));
  const result = (blocked: BlockReason | null): Classification => ({ intents, blocked, military, offers, bargainExplicit });

  if (hasAttachments) return result('attachment');
  if (t === '') return result('empty');
  const question = t.includes('?');
  // Name + phone + branch: the buyer is ordering. Answer only that ("Дякую за замовлення"); the rest
  // of such a message ("давайте наложкою") is already decided, not a question.
  if (!question && !PAYMENT_REQUEST.test(t) && ((PHONE.test(t) && POSTAL.test(t)) || BRANCH_NUMBER.test(t))) {
    intents = ['order_details'];
    return result(null);
  }
  // "Скинув", but not "я б оплатив доставку".
  if (!question && PAID.test(t) && !/(?<!\p{L})(б|би|бы)(?!\p{L})/u.test(t)) return result('paid');
  // "остання ціна?" is bargaining; don't let the word "ціна" in it count as a price question.
  const withoutBargainPhrases = BARGAIN_PRICE_PHRASES.reduce((s, p) => s.replace(p, ' '), t);
  for (const b of BLOCKERS) {
    if (b.patterns.some((p) => p.test(withoutBargainPhrases))) return result(b.reason);
  }
  if (intents.length === 0) return result('unknown');
  return result(null);
}

/** What exactly a delivery question is about; picks a focused answer instead of the generic one. */
export type DeliveryTopic = 'olx' | 'cod' | 'ukrposhta';

const DELIVERY_TOPICS: Record<DeliveryTopic, RegExp> = {
  olx: re(`${W}(олх|olx|олкс)(?!\\p{L})`),
  cod: re('накладен|налож|післяплат|послеоплат|оплат\\p{L}*\\s+(при|на)\\s+(отриманн|получени|пошт)|без\\s+(перед|пред)\\s*оплат'),
  ukrposhta: re('укр\\s*пошт|укр\\s*почт|ukrposhta'),
};

export function deliveryTopics(text: string): DeliveryTopic[] {
  const t = normalize(text);
  return (Object.keys(DELIVERY_TOPICS) as DeliveryTopic[]).filter((k) => DELIVERY_TOPICS[k].test(t));
}

const GREETING_RE = new RegExp(GREETING, 'giu');
/** Words that only greet, thank or acknowledge ("Добре, дякую", "Зрозумів", "🤝", "+"). */
const ACK_WORDS = new Set([
  'дякую', 'дякуємо', 'спасибо', 'спасибі', 'благодарю', 'ок', 'окей', 'ok', 'okay', 'hello', 'hi', 'добре', 'добро',
  'хорошо', 'зрозумів', 'зрозуміла', 'зрозуміло', 'понял', 'поняла', 'понятно', 'ясно', 'супер', 'чудово', 'відмінно',
  'отлично', 'гаразд', 'домовились', 'договорились', 'шкода', 'жаль', 'а', 'і', 'и', 'тоді', 'тогда', 'вам', 'вас',
  'дуже', 'большое', 'велике', 'гарного', 'хорошего', 'дня', 'вечора', 'вечера', 'навзаєм', 'взаимно', '+',
  '🤝', '👍', '👌', '🙏', '🙂', '😊', '❤️', '💪',
]);

/** Greetings, thanks and acknowledgements with no question: nothing to answer, no auto reply, no LLM draft. */
export function isSmallTalk(text: string): boolean {
  const t = normalize(text);
  if (t === '' || t.includes('?')) return false;
  const words = t
    .replace(GREETING_RE, ' ')
    .replace(/[\s,.!)(:;-]+/gu, ' ')
    .replace(/️/g, '')
    .trim()
    .split(' ')
    .filter(Boolean);
  return words.every((w) => ACK_WORDS.has(w) || ACK_WORDS.has(`${w}️`));
}

export const BLOCK_REASON_LABELS: Record<BlockReason, string> = {
  price: 'питання про ціну',
  exchange: 'обмін',
  attachment: 'вкладення',
  empty: 'порожнє повідомлення',
  paid: 'покупець повідомляє про оплату',
  unknown: 'не розпізнано',
};

export const INTENT_LABELS: Record<Intent, string> = {
  availability: 'наявність',
  delivery: 'доставка НП',
  pickup: 'самовивіз',
  condition: 'стан / комплектація',
  bargain: 'торг',
  order: 'замовлення',
  order_details: 'дані для відправки',
};

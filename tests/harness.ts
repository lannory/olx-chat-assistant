/**
 * Full in-memory stack for integration tests: FakeOlx → Poller → Processor → TelegramBridge,
 * with the Telegram Bot API intercepted (no network).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Config } from '../src/config.js';
import type { Drafter } from '../src/llm/draft.js';
import { nullLogger } from '../src/logger.js';
import { Poller } from '../src/poller/poller.js';
import { Processor } from '../src/poller/processor.js';
import { JsonFileStore } from '../src/rules/jsonFileStore.js';
import { advertsConfigSchema, templatesSchema } from '../src/rules/templates.js';
import { ThreadContextService } from '../src/services/context.js';
import { ReplyService } from '../src/services/replies.js';
import { OlxSender } from '../src/services/sender.js';
import { RuntimeSettings } from '../src/settings.js';
import { TelegramBridge } from '../src/telegram/bot.js';
import { FakeOlx } from './fakeOlx.js';
import { memoryDb } from './helpers.js';

export const OWNER_CHAT = 111;
export const STRANGER_CHAT = 999;
export const ADVERT_ID = 123456789;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface HarnessOptions {
  mode?: 'draft' | 'auto';
  quietHours?: { start: number; end: number } | null;
  drafter?: Drafter | null;
  /** Kyiv wall time hour for the initial clock (UTC+2 in November). */
  startHourKyiv?: number;
  /** Notes for the test advert in adverts.config.json; null = the advert has no notes. */
  notes?: Record<string, string> | null;
}

export function createHarness(opts: HarnessOptions = {}) {
  const clock = { now: Date.UTC(2026, 10, 19, (opts.startHourKyiv ?? 12) - 2, 0, 0) };
  const now = () => clock.now;

  const db = memoryDb(now);
  const olx = new FakeOlx();
  olx.adverts.set(ADVERT_ID, {
    id: ADVERT_ID,
    title: 'Ноутбук Lenovo ThinkPad T480',
    description: 'Ноутбук в ідеальному стані',
    url: 'https://www.olx.ua/d/uk/obyavlenie/lenovo-t480-IDabc.html',
    status: 'active',
    priceValue: 9000,
    priceCurrency: 'UAH',
    negotiable: false,
  });
  olx.users.set(10, { id: 10, name: 'Олег' });

  const dir = mkdtempSync(join(tmpdir(), 'olxbot-h-'));
  const advertsPath = join(dir, 'adverts.config.json');
  writeFileSync(
    advertsPath,
    JSON.stringify({
      adverts:
        opts.notes === null
          ? {}
          : { [ADVERT_ID]: opts.notes ?? { condition: 'як нова', kit: 'ноутбук, зарядка, коробка', batteries: '2 шт' } },
    }),
  );
  const templates = new JsonFileStore('config/templates.example.json', templatesSchema, nullLogger).load();
  const advertsConfig = new JsonFileStore(advertsPath, advertsConfigSchema, nullLogger).load();

  const config = {
    OWNER_COOLDOWN_MIN: 30,
    QUIET_HOURS: opts.quietHours ?? null,
    TIMEZONE: 'Europe/Kyiv',
    SHIPPING_COD: true,
    SHIPPING_PREPAY: true,
    TG_HISTORY_SIZE: 5,
    TELEGRAM_ALLOWED_CHAT_IDS: [OWNER_CHAT],
    LLM_ENABLED: !!opts.drafter,
    POLL_INTERVAL_SEC: 90,
  } satisfies Partial<Config>;

  // --- Telegram bot with intercepted API ---
  const apiCalls: ApiCall[] = [];
  let msgSeq = 1000;
  const bot = new Bot('123:TEST', {
    botInfo: { id: 1, is_bot: true, first_name: 'OLX bot', username: 'olx_test_bot' } as unknown as UserFromGetMe,
  });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    apiCalls.push({ method, payload: p });
    let result: unknown = true;
    if (method === 'sendMessage') {
      result = { message_id: ++msgSeq, date: 0, chat: { id: p.chat_id, type: 'private', first_name: 'Owner' }, text: p.text };
    }
    return { ok: true, result } as never;
  });

  const settings = new RuntimeSettings(db, opts.mode ?? 'draft');
  const context = new ThreadContextService(db, olx, advertsConfig, nullLogger, now);
  const sender = new OlxSender(db, olx, now);

  // Notifier is the bridge, but the bridge needs ReplyService → late binding.
  const notifierRef: { current: TelegramBridge | null } = { current: null };
  const notifier = {
    threadCard: (...a: Parameters<TelegramBridge['threadCard']>) => notifierRef.current!.threadCard(...a),
    updateDraftCards: (...a: Parameters<TelegramBridge['updateDraftCards']>) => notifierRef.current!.updateDraftCards(...a),
    alert: (html: string) => notifierRef.current!.alert(html),
  };
  const replies = new ReplyService(db, sender, notifier, settings, nullLogger, now);
  const processor = new Processor({
    db,
    context,
    replies,
    notifier,
    settings,
    templates,
    drafter: opts.drafter ?? null,
    logger: nullLogger,
    config,
    now,
  });
  const poller = new Poller({
    db,
    olx,
    processor,
    logger: nullLogger,
    timezone: 'Europe/Kyiv',
    now,
    afterPoll: () => replies.dispatchScheduled(),
  });
  const oauth = {
    createAuthorizeUrl: () => 'https://www.olx.ua/oauth/authorize?client_id=c&state=s',
    exchangeCode: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: 0, scope: null }),
    hasTokens: () => true,
  };
  const bridge = new TelegramBridge({
    bot,
    db,
    olx,
    context,
    replies,
    sender,
    settings,
    poller,
    oauth,
    templates,
    config,
    logger: nullLogger,
    now,
  });
  notifierRef.current = bridge;

  let updateId = 1;
  const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Owner' });
  const from = (id: number) => ({ id, is_bot: false, first_name: 'Owner' });

  const h = {
    clock,
    db,
    olx,
    bot,
    bridge,
    poller,
    replies,
    settings,
    apiCalls,
    /** Creates a thread on the test advert and runs the baseline poll. */
    async init(threadKey = 't1') {
      olx.addThread(threadKey, { advertId: ADVERT_ID, interlocutorId: 10 });
      await poller.tick();
      apiCalls.length = 0;
    },
    async buyerSays(text: string, threadKey = 't1', extra = {}) {
      olx.addMessage(threadKey, 'received', text, kyivNow(clock.now), extra);
      await poller.tick();
    },
    sent(method = 'sendMessage') {
      return apiCalls.filter((c) => c.method === method);
    },
    lastCard() {
      const cards = h.sent().filter((c) => c.payload.reply_markup && (c.payload.text as string).includes('📦'));
      return cards.at(-1);
    },
    buttons(call: ApiCall | undefined): { text: string; callback_data: string }[] {
      const kb = (call?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] }) ?? {};
      return (kb.inline_keyboard ?? []).flat();
    },
    messageIdOf(call: ApiCall): number {
      const idx = apiCalls.indexOf(call);
      return 1000 + apiCalls.slice(0, idx + 1).filter((c) => c.method === 'sendMessage').length;
    },
    async press(data: string, messageId: number, chatId = OWNER_CHAT) {
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: `cb${updateId}`,
          from: from(chatId),
          chat_instance: 'ci',
          data,
          message: { message_id: messageId, date: 0, chat: chat(chatId), text: 'card' },
        },
      } as never);
    },
    async text(text: string, opts2: { replyTo?: number; chatId?: number } = {}) {
      const chatId = opts2.chatId ?? OWNER_CHAT;
      const isCommand = text.startsWith('/');
      await bot.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: updateId + 5000,
          date: 0,
          chat: chat(chatId),
          from: from(chatId),
          text,
          ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
          ...(opts2.replyTo
            ? { reply_to_message: { message_id: opts2.replyTo, date: 0, chat: chat(chatId), text: 'prompt' } }
            : {}),
        },
      } as never);
    },
  };
  return h;
}

/** Formats a timestamp as OLX does (Kyiv wall time, no zone). */
export function kyivNow(ts: number): string {
  const d = new Date(ts + 2 * 3600_000); // November: UTC+2
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

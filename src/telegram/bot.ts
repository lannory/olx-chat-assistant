/**
 * Telegram side: forwards thread cards, handles buttons, ForceReply answers and commands.
 * Only chats listed in TELEGRAM_ALLOWED_CHAT_IDS are served; everything else is ignored.
 */
import { Bot, GrammyError, type Context } from 'grammy';
import type { Config } from '../config.js';
import type { Db, DraftRow, ThreadRow } from '../db/index.js';
import type { Logger } from '../logger.js';
import type { CardStatus, Notifier } from '../notify.js';
import type { OAuthService } from '../olx/oauth.js';
import type { OlxApi } from '../olx/olxClient.js';
import { INTENT_LABELS } from '../rules/classifier.js';
import type { JsonFileStore } from '../rules/jsonFileStore.js';
import type { PhotoSet, templatesSchema } from '../rules/templates.js';
import type { ThreadContextService } from '../services/context.js';
import { statusLabel, type ReplyService } from '../services/replies.js';
import type { OlxSender } from '../services/sender.js';
import type { RuntimeSettings } from '../settings.js';
import { formatLocal } from '../time.js';
import {
  actionableDraft,
  esc,
  photoSetsKeyboard,
  quickTemplatesKeyboard,
  renderCard,
  threadKeyboard,
  type CardData,
} from './format.js';

export interface PollerControl {
  readonly isPaused: boolean;
  setPaused(paused: boolean): void;
  lastSuccessAt(): number | null;
}

export interface BridgeDeps {
  bot: Bot;
  db: Db;
  olx: Pick<OlxApi, 'markAsRead'>;
  context: ThreadContextService;
  replies: ReplyService;
  sender: OlxSender;
  settings: RuntimeSettings;
  poller: PollerControl;
  oauth: Pick<OAuthService, 'createAuthorizeUrl' | 'exchangeCode' | 'hasTokens'>;
  templates: JsonFileStore<typeof templatesSchema>;
  config: Pick<Config, 'TELEGRAM_ALLOWED_CHAT_IDS' | 'TIMEZONE' | 'TG_HISTORY_SIZE' | 'QUIET_HOURS' | 'LLM_ENABLED' | 'POLL_INTERVAL_SEC'>;
  logger: Logger;
  now?: () => number;
}

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export const BOT_COMMANDS = [
  { command: 'status', description: 'Стан: останній poll, непрочитані, режим' },
  { command: 'mode', description: 'Режим: /mode draft або /mode auto' },
  { command: 'pause', description: 'Призупинити роботу з OLX' },
  { command: 'resume', description: 'Відновити роботу' },
  { command: 'templates', description: 'Показати шаблони відповідей' },
  { command: 'auth', description: 'Авторизувати застосунок в OLX' },
  { command: 'help', description: 'Довідка' },
];

const HELP = `Я пересилаю повідомлення з OLX і відповідаю на типові питання.

<b>Кнопки під карткою</b>
✅ Надіслати / ✏️ Редагувати / ⏭ Пропустити — дії з чернеткою
💬 Відповісти — написати покупцю свій текст (або просто зробіть reply на картку)
📋 Шаблони — швидкі відповіді
👁 Прочитано — позначити тред прочитаним в OLX
🔕 Ігнорувати тред — більше не пересилати цей тред

<b>Команди</b>
/status — стан бота
/mode draft|auto — режим відповідей
/pause, /resume — пауза
/templates — шаблони
/auth — (повторна) авторизація в OLX`;

export class TelegramBridge implements Notifier {
  private readonly allowed: Set<number>;
  private readonly now: () => number;

  constructor(private readonly d: BridgeDeps) {
    this.allowed = new Set(d.config.TELEGRAM_ALLOWED_CHAT_IDS);
    this.now = d.now ?? Date.now;
    this.register();
  }

  // ---------------- Notifier ----------------

  async threadCard(thread: ThreadRow, status: CardStatus): Promise<void> {
    const data = await this.cardData(thread);
    const draft = actionableDraft(status);
    const text = renderCard(data, status);
    const reply_markup = threadKeyboard(thread, draft, this.photoSetsFor(thread).length > 0);
    for (const chatId of this.allowed) {
      try {
        const msg = await this.d.bot.api.sendMessage(chatId, text, { ...HTML, reply_markup });
        this.d.db.linkTelegramMessage(chatId, msg.message_id, thread.uuid, status.kind === 'forward' ? null : (status.draft.id ?? null));
        if (draft) this.d.db.setDraftTelegramMessage(draft.id, chatId, msg.message_id);
      } catch (err) {
        this.d.logger.error({ err, chatId }, 'failed to send thread card');
      }
    }
  }

  async updateDraftCards(draft: DraftRow, status: CardStatus): Promise<void> {
    const thread = this.d.db.getThread(draft.threadUuid);
    if (!thread) return;
    const data = await this.cardData(thread);
    const text = renderCard(data, status);
    const reply_markup = threadKeyboard(thread, actionableDraft(status), this.photoSetsFor(thread).length > 0);
    for (const { chatId, messageId } of this.d.db.listTelegramLinksForDraft(draft.id)) {
      try {
        await this.d.bot.api.editMessageText(chatId, messageId, text, { ...HTML, reply_markup });
      } catch (err) {
        if (!isNotModified(err)) this.d.logger.error({ err, chatId, messageId }, 'failed to update card');
      }
    }
  }

  async alert(html: string): Promise<void> {
    for (const chatId of this.allowed) {
      try {
        await this.d.bot.api.sendMessage(chatId, html, HTML);
      } catch (err) {
        this.d.logger.error({ err, chatId }, 'failed to send alert');
      }
    }
  }

  // ---------------- data ----------------

  private async cardData(thread: ThreadRow): Promise<CardData> {
    const { context, db, config, logger } = this.d;
    let advert = db.getAdvert(thread.advertId);
    let buyerName = thread.interlocutorName;
    try {
      advert = await context.getAdvert(thread.advertId);
      buyerName = await context.getInterlocutorName(thread);
    } catch (err) {
      logger.warn({ err }, 'card data: OLX unavailable, using cached data');
    }
    return {
      thread,
      advert,
      buyerName,
      history: db.lastMessages(thread.uuid, config.TG_HISTORY_SIZE),
      timezone: config.TIMEZONE,
    };
  }

  // ---------------- handlers ----------------

  private register(): void {
    const { bot, logger } = this.d;

    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
      if (chatId === undefined || !this.allowed.has(chatId)) {
        logger.warn({ chatId, from: ctx.from?.id }, 'ignoring update from a chat that is not allowed');
        return;
      }
      await next();
    });

    bot.command(['start', 'help'], (ctx) => ctx.reply(`${HELP}\n\nВаш chat_id: <code>${ctx.chat.id}</code>`, HTML));
    bot.command('status', (ctx) => ctx.reply(this.statusText(), HTML));
    bot.command('mode', (ctx) => this.onMode(ctx, ctx.match.trim()));
    bot.command('pause', async (ctx) => {
      this.d.poller.setPaused(true);
      await ctx.reply('⏸ Пауза: OLX не опитується, відповіді не надсилаються. /resume — продовжити.');
    });
    bot.command('resume', async (ctx) => {
      this.d.poller.setPaused(false);
      await ctx.reply('▶️ Працюю далі.');
    });
    bot.command('templates', (ctx) => ctx.reply(this.templatesText(), HTML));
    bot.command('auth', (ctx) => this.onAuth(ctx, ctx.match.trim()));

    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));

    bot.catch((err) => logger.error({ err: err.error, update: err.ctx.update.update_id }, 'Telegram handler error'));
  }

  private statusText(): string {
    const { db, settings, poller, oauth, config } = this.d;
    const last = poller.lastSuccessAt();
    const unread = db.countUnreadThreads();
    const drafts = db.countDraftsByStatus();
    const ago = last ? Math.round((this.now() - last) / 60_000) : null;
    const stale = last !== null && this.now() - last > config.POLL_INTERVAL_SEC * 3 * 1000;
    return [
      `<b>Режим:</b> ${settings.mode}${poller.isPaused ? ' · ⏸ <b>пауза</b>' : ''}`,
      `<b>Останній успішний poll:</b> ${last ? `${formatLocal(last, config.TIMEZONE)} (${ago} хв тому)${stale ? ' ⚠️' : ''}` : 'ще не було'}`,
      `<b>Непрочитані:</b> ${unread.threads} тредів, ${unread.messages} повідомлень`,
      `<b>Чернетки:</b> очікують ${drafts.pending ?? 0}, заплановані ${drafts.scheduled ?? 0}`,
      `<b>OLX авторизація:</b> ${oauth.hasTokens() ? '✅' : '❌ потрібна (/auth)'}`,
      `<b>Тихі години:</b> ${config.QUIET_HOURS ? `${config.QUIET_HOURS.start}:00–${config.QUIET_HOURS.end}:00` : 'вимкнено'}`,
      `<b>LLM-чернетки:</b> ${config.LLM_ENABLED ? 'увімкнено' : 'вимкнено'}`,
    ].join('\n');
  }

  private templatesText(): string {
    const t = this.d.templates.get();
    const labels: Record<keyof typeof t.intents, string> = { ...INTENT_LABELS, bargain_military: 'торг (покупець — військовий)' };
    const intents = (Object.keys(t.intents) as (keyof typeof t.intents)[])
      .map((k) => `<b>${esc(labels[k])}</b>\n<blockquote>${esc(t.intents[k])}</blockquote>`)
      .join('\n');
    const quick = t.quick.map((q) => `• <b>${esc(q.label)}</b>: ${esc(q.text)}`).join('\n');
    return `<b>Шаблони автовідповідей</b>\n${intents}\n\n<b>Швидкі шаблони</b>\n${quick || '—'}\n\n<i>Редагуйте templates.json — зміни підхоплюються без перезапуску.</i>`;
  }

  private async onMode(ctx: Context, arg: string): Promise<void> {
    if (arg === 'draft' || arg === 'auto') {
      this.d.settings.mode = arg;
      await ctx.reply(
        arg === 'auto'
          ? '🤖 Режим <b>auto</b>: шаблонні відповіді йдуть одразу, вам — копія.'
          : '✍️ Режим <b>draft</b>: нічого не надсилаю сам, лише пропоную чернетки.',
        HTML,
      );
      return;
    }
    await ctx.reply(`Поточний режим: <b>${this.d.settings.mode}</b>\nЗмінити: /mode draft або /mode auto`, HTML);
  }

  private async onAuth(ctx: Context, arg: string): Promise<void> {
    if (!arg) {
      const url = this.d.oauth.createAuthorizeUrl();
      await ctx.reply(
        `Відкрийте посилання, увійдіть в OLX і дозвольте доступ:\n${esc(url)}\n\n` +
          'Якщо після входу браузер не відкрив сторінку бота, скопіюйте адресу з рядка браузера ' +
          '(з <code>?code=…&amp;state=…</code>) і надішліть її сюди: <code>/auth &lt;адреса&gt;</code>. Код діє 10 хвилин.',
        HTML,
      );
      return;
    }
    let code: string | null = null;
    let state: string | null = null;
    try {
      const u = new URL(arg);
      code = u.searchParams.get('code');
      state = u.searchParams.get('state');
    } catch {
      /* not a URL */
    }
    if (!code || !state) {
      await ctx.reply('Надішліть повну адресу після входу в OLX, з параметрами code і state.');
      return;
    }
    try {
      await this.d.oauth.exchangeCode(code, state);
      await ctx.reply('✅ OLX авторизовано. Починаю опитування.');
    } catch (err) {
      this.d.logger.error({ err }, 'manual OAuth exchange failed');
      await ctx.reply(`❌ Не вдалося: ${esc(String((err as Error).message))}. Спробуйте /auth ще раз.`, HTML);
    }
  }

  private async onCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const msg = ctx.callbackQuery?.message;
    if (!msg) return void (await ctx.answerCallbackQuery());
    const chatId = msg.chat.id;
    const link = this.d.db.getTelegramLink(chatId, msg.message_id);
    const thread = link ? this.d.db.getThread(link.threadUuid) : null;
    if (!link || !thread) {
      await ctx.answerCallbackQuery({ text: 'Тред не знайдено (стара картка?)', show_alert: true });
      return;
    }

    const [kind, action, idStr] = data.split(':');
    try {
      if (kind === 'd') return await this.onDraftAction(ctx, action ?? '', Number(idStr), thread);
      if (kind === 'q') return await this.onQuickTemplate(ctx, action ?? '', thread, link.draftId);
      if (kind === 'p') return await this.onPhotoSet(ctx, action ?? '', thread, link.draftId);
      if (kind === 't') return await this.onThreadAction(ctx, action ?? '', thread, link.draftId);
      await ctx.answerCallbackQuery();
    } catch (err) {
      this.d.logger.error({ err, data }, 'callback failed');
      await ctx.answerCallbackQuery({ text: `Помилка: ${String((err as Error).message).slice(0, 150)}`, show_alert: true });
    }
  }

  private async onDraftAction(ctx: Context, action: string, draftId: number, thread: ThreadRow): Promise<void> {
    const draft = this.d.db.getDraft(draftId);
    if (!draft || draft.threadUuid !== thread.uuid) {
      await ctx.answerCallbackQuery({ text: 'Чернетку не знайдено', show_alert: true });
      return;
    }
    if (action === 'send') {
      const res = await this.d.replies.sendDraft(draftId, 'button');
      if (res.ok) {
        await ctx.answerCallbackQuery({ text: '✅ Надіслано в OLX' });
        await this.updateDraftCards(res.draft, { kind: 'draft_sent', draft: res.draft });
      } else {
        await ctx.answerCallbackQuery({ text: `Не надіслано: ${res.error}`.slice(0, 200), show_alert: true });
        if (res.draft?.status === 'pending') {
          await this.updateDraftCards(res.draft, { kind: 'send_failed', draft: res.draft, error: res.error });
        }
      }
      return;
    }
    if (action === 'skip') {
      const skipped = this.d.replies.skipDraft(draftId);
      if (!skipped) {
        await ctx.answerCallbackQuery({ text: `Чернетка вже ${statusLabel(draft.status)}` });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Пропущено' });
      await this.updateDraftCards(skipped, { kind: 'draft_skipped', draft: skipped });
      return;
    }
    if (action === 'edit') {
      if (draft.status !== 'pending' && draft.status !== 'scheduled') {
        await ctx.answerCallbackQuery({ text: `Чернетка вже ${statusLabel(draft.status)}` });
        return;
      }
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(
        `✏️ Надішліть новий текст <b>відповіддю на це повідомлення</b> — він одразу піде покупцю${draft.photos.length ? ` разом із ${draft.photos.length} фото` : ''}.\nПоточна чернетка (можна скопіювати):\n<code>${esc(draft.text)}</code>`,
        { ...HTML, reply_markup: { force_reply: true, input_field_placeholder: 'Новий текст відповіді' } },
      );
      this.d.db.linkTelegramMessage(prompt.chat.id, prompt.message_id, thread.uuid, draft.id);
      return;
    }
    await ctx.answerCallbackQuery();
  }

  private async onQuickTemplate(ctx: Context, id: string, thread: ThreadRow, linkedDraftId: number | null): Promise<void> {
    const tpl = this.d.templates.get().quick.find((q) => q.id === id);
    if (!tpl) {
      await ctx.answerCallbackQuery({ text: 'Шаблон не знайдено (templates.json змінено?)', show_alert: true });
      return;
    }
    await this.sendOwnerText(thread, tpl.text);
    await ctx.answerCallbackQuery({ text: `✅ Надіслано: ${tpl.label}` });
    await this.restoreKeyboard(ctx, thread, linkedDraftId);
    await ctx.reply(`✅ Надіслано в OLX:\n<blockquote>${esc(tpl.text)}</blockquote>`, {
      ...HTML,
      reply_parameters: { message_id: ctx.callbackQuery!.message!.message_id },
    });
  }

  private async onThreadAction(ctx: Context, action: string, thread: ThreadRow, linkedDraftId: number | null): Promise<void> {
    switch (action) {
      case 'reply': {
        await ctx.answerCallbackQuery();
        const prompt = await ctx.reply(
          `💬 Напишіть відповідь покупцю <b>відповіддю на це повідомлення</b>.`,
          { ...HTML, reply_markup: { force_reply: true, input_field_placeholder: 'Текст для покупця' } },
        );
        this.d.db.linkTelegramMessage(prompt.chat.id, prompt.message_id, thread.uuid, null);
        return;
      }
      case 'tpl': {
        const quick = this.d.templates.get().quick;
        if (quick.length === 0) {
          await ctx.answerCallbackQuery({ text: 'У templates.json немає швидких шаблонів', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: quickTemplatesKeyboard(quick) });
        return;
      }
      case 'ph': {
        const sets = this.photoSetsFor(thread);
        if (sets.length === 0) {
          await ctx.answerCallbackQuery({ text: 'Для цього оголошення немає наборів фото в templates.json', show_alert: true });
          return;
        }
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup({ reply_markup: photoSetsKeyboard(sets) });
        return;
      }
      case 'back':
        await ctx.answerCallbackQuery();
        await this.restoreKeyboard(ctx, thread, linkedDraftId);
        return;
      case 'read':
        await this.d.olx.markAsRead(thread.uuid);
        await ctx.answerCallbackQuery({ text: '👁 Позначено прочитаним в OLX' });
        return;
      case 'ign':
      case 'unign': {
        const ignored = action === 'ign';
        this.d.db.setThreadIgnored(thread.uuid, ignored);
        if (ignored) await this.closeOpenDrafts(thread.uuid, 'тред ігнорується');
        await ctx.answerCallbackQuery({ text: ignored ? '🔕 Тред ігнорується' : '🔔 Тред знову активний' });
        await this.restoreKeyboard(ctx, this.d.db.getThread(thread.uuid)!, linkedDraftId);
        return;
      }
      default:
        await ctx.answerCallbackQuery();
    }
  }

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) {
      await ctx.reply('Невідома команда. /help — довідка.');
      return;
    }
    const replyTo = ctx.message?.reply_to_message;
    const link = replyTo ? this.d.db.getTelegramLink(ctx.chat!.id, replyTo.message_id) : null;
    const thread = link ? this.d.db.getThread(link.threadUuid) : null;
    if (!link || !thread) {
      await ctx.reply('Щоб відповісти покупцю, натисніть «💬 Відповісти» під карткою або зробіть reply на картку.');
      return;
    }

    const draft = link.draftId ? this.d.db.getDraft(link.draftId) : null;
    try {
      if (draft && (draft.status === 'pending' || draft.status === 'scheduled')) {
        const res = await this.d.replies.sendDraft(draft.id, 'edit', text);
        if (!res.ok) {
          await ctx.reply(`❌ Не надіслано: ${esc(res.error)}`, HTML);
          return;
        }
        await this.updateDraftCards(res.draft, { kind: 'draft_sent', draft: res.draft });
        await this.closeOpenDrafts(thread.uuid, 'ви відповіли вручну');
      } else {
        await this.sendOwnerText(thread, text);
      }
      await ctx.reply('✅ Надіслано в OLX');
    } catch (err) {
      this.d.logger.error({ err, thread: thread.uuid }, 'failed to send owner reply');
      await ctx.reply(`❌ Не вдалося надіслати в OLX: ${esc(String((err as Error).message))}`, HTML);
    }
  }

  /** Sends the owner's own text, closes pending drafts of the thread and marks it read. */
  private async sendOwnerText(thread: ThreadRow, text: string, photos: readonly string[] = []): Promise<void> {
    await this.d.sender.send(thread.uuid, text, 'owner', photos);
    await this.closeOpenDrafts(thread.uuid, 'ви відповіли вручну');
    try {
      await this.d.olx.markAsRead(thread.uuid);
    } catch (err) {
      this.d.logger.warn({ err }, 'mark-as-read after reply failed');
    }
  }

  private async closeOpenDrafts(threadUuid: string, reason: string): Promise<void> {
    for (const d of this.d.replies.supersedeOpenDrafts(threadUuid)) {
      await this.updateDraftCards(d, { kind: 'draft_superseded', draft: d, reason });
    }
  }

  private async restoreKeyboard(ctx: Context, thread: ThreadRow, draftId: number | null): Promise<void> {
    const draft = draftId ? this.d.db.getDraft(draftId) : null;
    const open = draft && (draft.status === 'pending' || draft.status === 'scheduled') ? draft : null;
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: threadKeyboard(thread, open, this.photoSetsFor(thread).length > 0) });
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  }

  /** Photo sets that fit the thread's advert (own ones and those for any advert). */
  private photoSetsFor(thread: ThreadRow): PhotoSet[] {
    return this.d.templates.get().photos.filter((p) => p.adverts.length === 0 || p.adverts.includes(thread.advertId));
  }

  private async onPhotoSet(ctx: Context, id: string, thread: ThreadRow, linkedDraftId: number | null): Promise<void> {
    const set = this.photoSetsFor(thread).find((p) => p.id === id);
    if (!set) {
      await ctx.answerCallbackQuery({ text: 'Набір фото не знайдено (templates.json змінено?)', show_alert: true });
      return;
    }
    await this.sendOwnerText(thread, set.text, set.urls);
    await ctx.answerCallbackQuery({ text: `✅ Надіслано: ${set.label}` });
    await this.restoreKeyboard(ctx, thread, linkedDraftId);
    await ctx.reply(`✅ Надіслано в OLX (${set.urls.length} фото):\n<blockquote>${esc(set.text)}</blockquote>`, {
      ...HTML,
      reply_parameters: { message_id: ctx.callbackQuery!.message!.message_id },
    });
  }
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes('message is not modified');
}

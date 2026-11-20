/**
 * Entry point: wires everything together, starts the HTTP server, the Telegram bot and the poller,
 * and shuts down gracefully on SIGINT/SIGTERM.
 */
import { existsSync } from 'node:fs';
import { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { Db } from './db/index.js';
import { GeminiDrafter } from './llm/draft.js';
import { createLogger } from './logger.js';
import { defaultRetry, realSleep, type HttpDeps } from './olx/http.js';
import { OAuthService } from './olx/oauth.js';
import { OlxClient } from './olx/olxClient.js';
import { Poller, type PollAlert } from './poller/poller.js';
import { Processor } from './poller/processor.js';
import { JsonFileStore } from './rules/jsonFileStore.js';
import { advertsConfigSchema, templatesSchema } from './rules/templates.js';
import { buildServer } from './server.js';
import { ThreadContextService } from './services/context.js';
import { ReplyService } from './services/replies.js';
import { OlxSender } from './services/sender.js';
import { RuntimeSettings } from './settings.js';
import { BOT_COMMANDS, TelegramBridge } from './telegram/bot.js';
import { esc } from './telegram/format.js';
import { formatLocal } from './time.js';
import type { Notifier } from './notify.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\nПеревірте .env (приклад — .env.example).\n`);
    process.exit(1);
  }
})();
const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development' && process.stdout.isTTY);

async function main(): Promise<void> {
  const db = new Db(config.DB_PATH);
  const http: HttpDeps = { fetch, logger, sleep: realSleep, random: Math.random, now: Date.now, retry: defaultRetry };

  const oauth = new OAuthService(
    {
      baseUrl: config.OLX_BASE_URL,
      clientId: config.OLX_CLIENT_ID,
      clientSecret: config.OLX_CLIENT_SECRET,
      redirectUri: config.OLX_REDIRECT_URI,
      scope: config.OLX_SCOPE,
    },
    db,
    http,
  );
  const olx = new OlxClient(config.OLX_BASE_URL, oauth, http);

  // The real files hold business data and are not in git: they are created from *.example.json.
  for (const [path, example] of [
    [config.TEMPLATES_PATH, 'config/templates.example.json'],
    [config.ADVERTS_CONFIG_PATH, 'config/adverts.config.example.json'],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${path} not found: copy ${example} to it and fill in your own data`);
  }
  const templates = new JsonFileStore(config.TEMPLATES_PATH, templatesSchema, logger).load();
  const advertsConfig = new JsonFileStore(config.ADVERTS_CONFIG_PATH, advertsConfigSchema, logger).load();
  const settings = new RuntimeSettings(db, config.MODE);
  const context = new ThreadContextService(db, olx, advertsConfig, logger);
  const sender = new OlxSender(db, olx);

  // The Telegram bridge is the notifier, but it also needs the reply service → late binding.
  let bridge: TelegramBridge | null = null;
  const notifier: Notifier = {
    threadCard: (t, s) => bridge!.threadCard(t, s),
    updateDraftCards: (d, s) => bridge!.updateDraftCards(d, s),
    alert: (html) => bridge!.alert(html),
  };

  const replies = new ReplyService(db, sender, notifier, settings, logger);
  const drafter =
    config.LLM_ENABLED && config.GEMINI_API_KEY
      ? new GeminiDrafter({
          apiKey: config.GEMINI_API_KEY,
          model: config.LLM_MODEL,
          logger,
          sellerContext: () => templates.get().llm.seller_context,
        })
      : null;
  const processor = new Processor({ db, context, replies, notifier, settings, templates, drafter, logger, config });

  // --- alerts (throttled per kind) ---
  const lastAlertAt = new Map<string, number>();
  const throttled = async (key: string, everyMs: number, html: () => string) => {
    const last = lastAlertAt.get(key) ?? 0;
    if (Date.now() - last < everyMs) return;
    lastAlertAt.set(key, Date.now());
    await notifier.alert(html());
  };
  const authAlert = (reason: string) =>
    throttled('auth', 6 * 3600_000, () =>
      [
        '⚠️ <b>OLX: потрібна авторизація</b>',
        esc(reason),
        '',
        `Відкрийте посилання й увійдіть в OLX:\n${esc(oauth.createAuthorizeUrl())}`,
        'Або надішліть /auth, щоб отримати нове посилання.',
      ].join('\n'),
    );
  oauth.onAuthFailure((reason) => authAlert(reason));

  const onAlert = async (a: PollAlert) => {
    switch (a.kind) {
      case 'auth_required':
        return authAlert(a.reason);
      case 'blocked':
        return throttled('blocked', 30 * 60_000, () =>
          `⛔ <b>OLX тимчасово блокує запити з цього IP</b> (перевищено ліміт). Пауза до ${formatLocal(a.retryAt, config.TIMEZONE)}.`,
        );
      case 'failing':
        return throttled('failing', 3600_000, () =>
          `⚠️ <b>OLX не відповідає</b>: ${a.consecutiveFailures} спроб поспіль.\nОстання помилка: <code>${esc(a.error.slice(0, 300))}</code>`,
        );
      case 'recovered':
        lastAlertAt.delete('failing');
        return notifier.alert('✅ Зв’язок з OLX відновлено.');
      case 'baseline':
        return notifier.alert(
          `🔄 <b>Перша синхронізація</b>: ${a.threads} тредів (з непрочитаними: ${a.unreadThreads}).\n` +
            'Старі повідомлення пропущено — реагую лише на нові.',
        );
    }
  };

  const poller = new Poller({
    db,
    olx,
    processor,
    logger,
    timezone: config.TIMEZONE,
    onAlert,
    afterPoll: () => replies.dispatchScheduled(),
  });

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bridge = new TelegramBridge({ bot, db, olx, context, replies, sender, settings, poller, oauth, templates, config, logger });

  const app = buildServer({
    oauth,
    logger,
    lastPollOkAt: () => poller.lastSuccessAt(),
    pollIntervalSec: config.POLL_INTERVAL_SEC,
    onAuthorized: async () => {
      lastAlertAt.delete('auth');
      await notifier.alert('✅ OLX авторизовано. Починаю опитування.');
      void poller.tick();
    },
  });

  // --- start ---
  await app.listen({ port: config.PORT, host: config.HOST });
  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS).catch((err) => logger.warn({ err }, 'setMyCommands failed'));
  const botRun = bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (info) => logger.info({ username: info.username }, 'Telegram bot started'),
  });
  botRun.catch((err) => {
    logger.fatal({ err }, 'Telegram bot stopped with an error');
    void shutdown('telegram-error', 1);
  });

  logger.info({ mode: settings.mode, interval: config.POLL_INTERVAL_SEC, llm: !!drafter }, 'OLX autoresponder started');
  if (!oauth.hasTokens()) await authAlert('Застосунок ще не підключено до вашого акаунта OLX.');
  poller.start(config.POLL_INTERVAL_SEC);

  // --- graceful shutdown ---
  let shuttingDown = false;
  async function shutdown(signal: string, code = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, exiting');
      process.exit(1);
    }, 15_000);
    force.unref();
    try {
      await poller.stop(); // waits for an in-flight poll (and any sends it is doing)
      if (bot.isRunning()) await bot.stop();
      await app.close();
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      code = 1;
    }
    logger.info('bye');
    process.exit(code);
  }
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

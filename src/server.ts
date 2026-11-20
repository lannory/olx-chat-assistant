/**
 * HTTP surface: only the OAuth callback and a healthcheck.
 * There is deliberately no public "start authorization" endpoint: the authorize link (with a fresh
 * `state`) is sent to the owner in Telegram (/auth), so nobody else can connect their OLX account.
 */
import Fastify from 'fastify';
import type { Logger } from './logger.js';
import type { OAuthService } from './olx/oauth.js';

export interface ServerDeps {
  oauth: Pick<OAuthService, 'exchangeCode' | 'hasTokens'>;
  logger: Logger;
  lastPollOkAt: () => number | null;
  pollIntervalSec: number;
  onAuthorized?: () => void | Promise<void>;
  now?: () => number;
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style>` +
  `</head><body><h1>${title}</h1><p>${body}</p></body></html>`;

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function buildServer(deps: ServerDeps) {
  const now = deps.now ?? Date.now;
  const app = Fastify({ loggerInstance: deps.logger });

  // logLevel 'warn' keeps docker healthchecks out of the info log.
  app.get('/health', { logLevel: 'warn' }, async (_req, reply) => {
    const last = deps.lastPollOkAt();
    const staleAfterMs = deps.pollIntervalSec * 5 * 1000;
    return reply.send({
      status: 'ok',
      authorized: deps.oauth.hasTokens(),
      lastPollOkAt: last ? new Date(last).toISOString() : null,
      pollStale: last === null ? null : now() - last > staleAfterMs,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/oauth/callback',
    async (req, reply) => {
      reply.type('text/html; charset=utf-8');
      const { code, state, error, error_description } = req.query;
      if (error) {
        return reply.code(400).send(page('Авторизацію скасовано', escHtml(error_description ?? error)));
      }
      if (!code || !state) {
        return reply.code(400).send(page('Помилка', 'Немає параметрів code/state. Почніть заново командою /auth у Telegram.'));
      }
      try {
        await deps.oauth.exchangeCode(code, state);
      } catch (err) {
        deps.logger.error({ err }, 'OAuth callback failed');
        return reply
          .code(400)
          .send(page('Помилка авторизації', `${escHtml(String((err as Error).message))}<br>Спробуйте ще раз: /auth у Telegram.`));
      }
      try {
        await deps.onAuthorized?.();
      } catch (err) {
        deps.logger.error({ err }, 'onAuthorized hook failed');
      }
      return reply.send(page('Готово ✅', 'OLX підключено. Можна закрити цю сторінку й повернутися в Telegram.'));
    },
  );

  return app;
}

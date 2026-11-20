import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

/** "23-8" → { start: 23, end: 8 }; empty string disables quiet hours. */
const quietHours = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === '' || v === 'off') return null;
    const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(v);
    const start = Number(m?.[1]);
    const end = Number(m?.[2]);
    if (!m || start > 23 || end > 23 || start === end) {
      ctx.addIssue({ code: 'custom', message: 'QUIET_HOURS must look like "23-8" (hours 0-23) or be empty' });
      return z.NEVER;
    }
    return { start, end };
  });

const chatIds = z
  .string()
  .trim()
  .min(1, 'TELEGRAM_ALLOWED_CHAT_IDS is required')
  .transform((v, ctx) => {
    const ids = v.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    if (ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n))) {
      ctx.addIssue({ code: 'custom', message: 'TELEGRAM_ALLOWED_CHAT_IDS must be comma-separated integers' });
      return z.NEVER;
    }
    return ids;
  });

export const modeSchema = z.enum(['draft', 'auto']);
export type Mode = z.infer<typeof modeSchema>;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DB_PATH: z.string().default('./data/olx-bot.db'),

    OLX_BASE_URL: z.url().default('https://www.olx.ua'),
    OLX_CLIENT_ID: z.string().min(1),
    OLX_CLIENT_SECRET: z.string().min(1),
    OLX_REDIRECT_URI: z.url(),
    OLX_SCOPE: z.string().default('v2 read write'),

    POLL_INTERVAL_SEC: z.coerce.number().int().min(30).default(90),
    MODE: modeSchema.default('draft'),
    OWNER_COOLDOWN_MIN: z.coerce.number().int().min(0).default(30),
    QUIET_HOURS: quietHours.default(null),
    TIMEZONE: z.string().default('Europe/Kyiv'),
    /** Скільки останніх повідомлень треду показувати в Telegram. */
    TG_HISTORY_SIZE: z.coerce.number().int().min(1).max(10).default(5),

    SHIPPING_COD: bool.default(true),
    SHIPPING_PREPAY: bool.default(true),

    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_ALLOWED_CHAT_IDS: chatIds,

    TEMPLATES_PATH: z.string().default('./config/templates.json'),
    ADVERTS_CONFIG_PATH: z.string().default('./config/adverts.config.json'),

    LLM_ENABLED: bool.default(false),
    GEMINI_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().default('gemini-3.5-flash-lite'),
  })
  .superRefine((c, ctx) => {
    if (c.LLM_ENABLED && !c.GEMINI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'required when LLM_ENABLED=true' });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty strings in .env mean "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = configSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

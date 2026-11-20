import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  OLX_CLIENT_ID: 'id',
  OLX_CLIENT_SECRET: 'secret',
  OLX_REDIRECT_URI: 'https://bot.example.com/oauth/callback',
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_ALLOWED_CHAT_IDS: '111, -222',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.MODE).toBe('draft');
    expect(c.POLL_INTERVAL_SEC).toBe(90);
    expect(c.QUIET_HOURS).toBeNull();
    expect(c.LLM_ENABLED).toBe(false);
    expect(c.TELEGRAM_ALLOWED_CHAT_IDS).toEqual([111, -222]);
    expect(c.OLX_SCOPE).toBe('v2 read write');
  });

  it('parses quiet hours and booleans; empty strings count as unset', () => {
    const c = loadConfig({ ...base, QUIET_HOURS: '23-8', SHIPPING_COD: 'false', MODE: 'auto', POLL_INTERVAL_SEC: '' });
    expect(c.QUIET_HOURS).toEqual({ start: 23, end: 8 });
    expect(c.SHIPPING_COD).toBe(false);
    expect(c.MODE).toBe('auto');
    expect(c.POLL_INTERVAL_SEC).toBe(90);
  });

  it('rejects bad values with readable messages', () => {
    expect(() => loadConfig({ ...base, QUIET_HOURS: '25-8' })).toThrow(/QUIET_HOURS/);
    expect(() => loadConfig({ ...base, TELEGRAM_ALLOWED_CHAT_IDS: 'me' })).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
    expect(() => loadConfig({ ...base, LLM_ENABLED: 'true' })).toThrow(/GEMINI_API_KEY/);
    expect(() => loadConfig({ ...base, MODE: 'yolo' })).toThrow(/MODE/);
  });
});

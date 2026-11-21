import { describe, expect, it } from 'vitest';
import { isQuietTime, parseOlxDate, quietEndAfter, tzOffsetMs } from '../src/time.js';

const TZ = 'Europe/Kyiv';

describe('time helpers', () => {
  it('knows Kyiv offsets in winter and summer', () => {
    expect(tzOffsetMs(Date.UTC(2026, 0, 15, 12), TZ)).toBe(2 * 3600_000);
    expect(tzOffsetMs(Date.UTC(2026, 6, 15, 12), TZ)).toBe(3 * 3600_000);
  });

  it('parses OLX "YYYY-MM-DD HH:mm:ss" as UTC (what the API actually returns)', () => {
    expect(parseOlxDate('2026-11-19 10:00:00')).toBe(Date.UTC(2026, 10, 19, 10, 0, 0));
    expect(parseOlxDate('2026-07-01 10:00:00')).toBe(Date.UTC(2026, 6, 1, 10, 0, 0));
  });

  it('parses ISO with zone as-is and rejects garbage', () => {
    expect(parseOlxDate('2026-11-19T10:00:00+02:00')).toBe(Date.UTC(2026, 10, 19, 8));
    expect(parseOlxDate('yesterday')).toBeNull();
  });

  it('detects quiet hours across midnight', () => {
    const q = { start: 23, end: 8 };
    const at = (h: number) => Date.UTC(2026, 10, 19, h - 2); // Kyiv = UTC+2 in November
    expect(isQuietTime(at(23), q, TZ)).toBe(true);
    expect(isQuietTime(at(3), q, TZ)).toBe(true);
    expect(isQuietTime(at(8), q, TZ)).toBe(false);
    expect(isQuietTime(at(22), q, TZ)).toBe(false);
    expect(isQuietTime(at(12), null, TZ)).toBe(false);
  });

  it('supports non-wrapping windows', () => {
    const q = { start: 13, end: 15 };
    expect(isQuietTime(Date.UTC(2026, 10, 19, 12), q, TZ)).toBe(true); // 14:00 Kyiv
    expect(isQuietTime(Date.UTC(2026, 10, 19, 13), q, TZ)).toBe(false); // 15:00 Kyiv
  });

  it('finds the end of the quiet window', () => {
    const q = { start: 23, end: 8 };
    // 23:30 Kyiv on Nov 19 → 08:00 Kyiv on Nov 20 (06:00 UTC)
    expect(quietEndAfter(Date.UTC(2026, 10, 19, 21, 30), q, TZ)).toBe(Date.UTC(2026, 10, 20, 6, 0));
    // 03:00 Kyiv → same day 08:00
    expect(quietEndAfter(Date.UTC(2026, 10, 20, 1, 0), q, TZ)).toBe(Date.UTC(2026, 10, 20, 6, 0));
  });
});

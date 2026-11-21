/** Timezone helpers built on Intl (no extra deps). */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function wallTime(ts: number, tz: string): WallTime {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of `tz` from UTC at instant `ts`, in ms (Kyiv summer: +3h). */
export function tzOffsetMs(ts: number, tz: string): number {
  const w = wallTime(ts, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Converts a wall-clock time in `tz` to a UTC timestamp. */
export function zonedToUtc(w: WallTime, tz: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  let ts = guess - tzOffsetMs(guess, tz);
  // Second pass fixes the guess around DST transitions.
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

/**
 * Parses OLX timestamps. The API returns "YYYY-MM-DD HH:mm:ss" without a zone, and it is UTC: messages
 * arrive within one poll interval, yet read as Kyiv wall time they looked 2 h (3 h in summer) older.
 * ISO strings with an explicit zone are parsed as-is. Returns null if unparseable.
 */
export function parseOlxDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(value.trim());
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export interface QuietHours {
  start: number;
  end: number;
}

/** True if `ts` falls into [start, end) in `tz`; the window may wrap midnight (23-8). */
export function isQuietTime(ts: number, quiet: QuietHours | null, tz: string): boolean {
  if (!quiet) return false;
  const h = wallTime(ts, tz).hour;
  return quiet.start < quiet.end ? h >= quiet.start && h < quiet.end : h >= quiet.start || h < quiet.end;
}

/** The next instant (> ts) when the quiet window ends, i.e. `end:00` local time. */
export function quietEndAfter(ts: number, quiet: QuietHours, tz: string): number {
  const w = wallTime(ts, tz);
  for (let addDays = 0; addDays <= 2; addDays++) {
    const day = new Date(Date.UTC(w.year, w.month - 1, w.day + addDays));
    const candidate = zonedToUtc(
      { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: quiet.end, minute: 0, second: 0 },
      tz,
    );
    if (candidate > ts) return candidate;
  }
  throw new Error('unreachable: quiet window end not found');
}

export function formatLocal(ts: number, tz: string): string {
  const w = wallTime(ts, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    redact: {
      paths: ['*.access_token', '*.refresh_token', '*.client_secret', 'headers.authorization', '*.headers.authorization'],
      censor: '[redacted]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } } : {}),
  });
}

/** Silent logger for tests. */
export const nullLogger: Logger = pino({ level: 'silent' });

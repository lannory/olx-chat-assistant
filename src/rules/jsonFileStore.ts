import { readFileSync, statSync } from 'node:fs';
import type { z } from 'zod';
import type { Logger } from '../logger.js';

/**
 * A JSON config file validated by zod and re-read automatically when it changes on disk, so
 * templates and advert notes can be edited without restarting the service.
 * A broken edit keeps the last valid version (and logs an error) instead of crashing.
 */
export class JsonFileStore<S extends z.ZodType> {
  private value: z.output<S> | null = null;
  private mtimeMs = -1;

  constructor(
    private readonly path: string,
    private readonly schema: S,
    private readonly logger: Logger,
  ) {}

  /** Loads the file eagerly; throws if the initial version is missing or invalid. */
  load(): this {
    this.reload(true);
    return this;
  }

  get(): z.output<S> {
    let mtime: number;
    try {
      mtime = statSync(this.path).mtimeMs;
    } catch (err) {
      if (this.value === null) throw err;
      return this.value;
    }
    if (mtime !== this.mtimeMs) this.reload(this.value === null);
    return this.value as z.output<S>;
  }

  private reload(strict: boolean): void {
    try {
      const mtime = statSync(this.path).mtimeMs;
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      const parsed = this.schema.safeParse(raw);
      if (!parsed.success) throw new Error(`${this.path}: ${parsed.error.message}`);
      this.value = parsed.data;
      this.mtimeMs = mtime;
      this.logger.info({ path: this.path }, 'config file loaded');
    } catch (err) {
      if (strict) throw err;
      this.logger.error({ err, path: this.path }, 'config file is invalid; keeping the previous version');
      try {
        this.mtimeMs = statSync(this.path).mtimeMs; // don't spam the log on every call
      } catch {
        /* ignore */
      }
    }
  }
}

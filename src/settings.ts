/** Runtime settings that can be changed from Telegram and survive restarts (stored in the DB). */
import { modeSchema, type Mode } from './config.js';
import type { Db } from './db/index.js';

const MODE_KEY = 'mode';

export class RuntimeSettings {
  constructor(
    private readonly db: Db,
    private readonly defaultMode: Mode,
  ) {}

  get mode(): Mode {
    const parsed = modeSchema.safeParse(this.db.getSetting(MODE_KEY));
    return parsed.success ? parsed.data : this.defaultMode;
  }

  set mode(m: Mode) {
    this.db.setSetting(MODE_KEY, m);
  }
}

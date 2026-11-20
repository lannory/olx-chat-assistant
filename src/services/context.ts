/**
 * Data needed to answer / forward a thread: advert (cached), buyer name (cached), advert notes.
 * All lookups are best-effort: OLX failures fall back to cached or empty data.
 */
import type { AdvertRow, Db, ThreadRow } from '../db/index.js';
import type { Logger } from '../logger.js';
import { OlxAuthRequiredError, OlxBlockedError } from '../olx/errors.js';
import type { OlxApi } from '../olx/olxClient.js';
import type { JsonFileStore } from '../rules/jsonFileStore.js';
import type { AdvertNotes, advertsConfigSchema } from '../rules/templates.js';

const ADVERT_TTL_MS = 6 * 3600_000;

export class ThreadContextService {
  constructor(
    private readonly db: Db,
    private readonly olx: OlxApi,
    private readonly advertsConfig: JsonFileStore<typeof advertsConfigSchema>,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async getAdvert(advertId: number): Promise<AdvertRow | null> {
    const cached = this.db.getAdvert(advertId);
    if (cached && this.now() - cached.fetchedAt < ADVERT_TTL_MS) return cached;
    try {
      const a = await this.olx.getAdvert(advertId);
      this.db.upsertAdvert(a);
      return this.db.getAdvert(advertId);
    } catch (err) {
      if (err instanceof OlxAuthRequiredError || err instanceof OlxBlockedError) throw err;
      this.logger.warn({ err, advertId }, 'could not fetch advert; using cache');
      return cached;
    }
  }

  async getInterlocutorName(thread: ThreadRow): Promise<string | null> {
    if (thread.interlocutorName) return thread.interlocutorName;
    try {
      const u = await this.olx.getUser(thread.interlocutorId);
      if (u.name) this.db.setInterlocutorName(thread.uuid, u.name);
      return u.name ?? null;
    } catch (err) {
      if (err instanceof OlxAuthRequiredError || err instanceof OlxBlockedError) throw err;
      this.logger.warn({ err, userId: thread.interlocutorId }, 'could not fetch interlocutor name');
      return null;
    }
  }

  getNotes(advertId: number): AdvertNotes | null {
    return this.advertsConfig.get().adverts[String(advertId)] ?? null;
  }
}

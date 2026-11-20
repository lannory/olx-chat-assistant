/**
 * Posts messages to OLX threads and records them, so the poller can tell bot/owner messages sent
 * through this service apart from ones the owner typed in the OLX app.
 */
import type { Db } from '../db/index.js';
import type { OlxApi } from '../olx/olxClient.js';

export class OlxSender {
  constructor(
    private readonly db: Db,
    private readonly olx: OlxApi,
    private readonly now: () => number = Date.now,
  ) {}

  async send(threadUuid: string, text: string, author: 'bot' | 'owner'): Promise<void> {
    const body = text.trim();
    if (!body) throw new Error('Empty message');
    // Record first: a concurrent poll may already see the message before send() resolves.
    const outgoingId = this.db.recordOutgoing(threadUuid, body, author);
    try {
      await this.olx.sendMessage(threadUuid, body);
    } catch (err) {
      this.db.deleteOutgoing(outgoingId);
      throw err;
    }
    if (author === 'owner') this.db.touchOwnerMessage(threadUuid, this.now());
  }
}

import { describe, expect, it, vi } from 'vitest';
import { Db, type MessageRow, type ThreadRow } from '../src/db/index.js';
import { nullLogger } from '../src/logger.js';
import { OlxAuthRequiredError, OlxBlockedError } from '../src/olx/errors.js';
import { Poller, SETTING_BASELINE_DONE, type MessageProcessor, type PollAlert } from '../src/poller/poller.js';
import { FakeOlx } from './fakeOlx.js';
import { memoryDb } from './helpers.js';

class RecordingProcessor implements MessageProcessor {
  batches: { thread: ThreadRow; messages: MessageRow[] }[] = [];
  constructor(private readonly db: Db) {}
  async handleNewMessages(thread: ThreadRow, messages: MessageRow[]) {
    this.batches.push({ thread, messages });
    for (const m of messages) this.db.markMessageProcessed(m.uuid);
  }
}

function setup(now = () => Date.UTC(2026, 10, 19, 12)) {
  const db = memoryDb(now);
  const olx = new FakeOlx();
  const processor = new RecordingProcessor(db);
  const alerts: PollAlert[] = [];
  const poller = new Poller({ db, olx, processor, logger: nullLogger, timezone: 'Europe/Kyiv', now, onAlert: (a) => void alerts.push(a) });
  return { db, olx, processor, poller, alerts };
}

describe('Poller', () => {
  it('first pass is a baseline: stores history as processed, answers nothing', async () => {
    const { olx, poller, processor, db, alerts } = setup();
    olx.addThread('t1');
    olx.addMessage('t1', 'received', 'Актуально?');
    const stats = await poller.pollOnce();
    expect(stats.baseline).toBe(true);
    expect(processor.batches).toHaveLength(0);
    expect(db.listUnprocessedMessages('t1')).toHaveLength(0);
    expect(db.getSetting(SETTING_BASELINE_DONE)).toBe('1');
    expect(alerts).toEqual([{ kind: 'baseline', threads: 1, unreadThreads: 1 }]);
  });

  it('processes only new buyer messages after the baseline, exactly once', async () => {
    const { olx, poller, processor } = setup();
    olx.addThread('t1');
    olx.addMessage('t1', 'received', 'старе');
    await poller.pollOnce();

    olx.addMessage('t1', 'received', 'Ще продається?');
    olx.addMessage('t1', 'received', 'Можна НП?');
    await poller.pollOnce();
    expect(processor.batches).toHaveLength(1);
    expect(processor.batches[0]!.messages.map((m) => m.text)).toEqual(['Ще продається?', 'Можна НП?']);

    // Same data again (unread still > 0): fetched, but nothing new to process.
    await poller.pollOnce();
    expect(processor.batches).toHaveLength(1);
  });

  it('dedup survives a restart (new Poller, same DB)', async () => {
    const { olx, poller, db, processor } = setup();
    olx.addThread('t1');
    await poller.pollOnce();
    olx.addMessage('t1', 'received', 'Привіт');
    await poller.pollOnce();
    expect(processor.batches).toHaveLength(1);

    const processor2 = new RecordingProcessor(db);
    const poller2 = new Poller({ db, olx, processor: processor2, logger: nullLogger, timezone: 'Europe/Kyiv' });
    await poller2.pollOnce();
    expect(processor2.batches).toHaveLength(0);
  });

  it('skips threads whose total_count did not change and have no unread', async () => {
    const { olx, poller } = setup();
    olx.addThread('t1');
    olx.addMessage('t1', 'sent', 'hi');
    await poller.pollOnce();
    olx.calls.length = 0;
    await poller.pollOnce();
    expect(olx.calls).toEqual(['listAllThreads']);
  });

  it('picks up new messages even if the owner already read them on the phone (unread = 0)', async () => {
    const { olx, poller, processor } = setup();
    olx.addThread('t1');
    await poller.pollOnce();
    olx.addMessage('t1', 'received', 'Де забрати?');
    await olx.markAsRead('t1');
    await poller.pollOnce();
    expect(processor.batches).toHaveLength(1);
  });

  it('records owner messages typed in the OLX app, but not bot-sent ones', async () => {
    const { olx, poller, db } = setup();
    olx.addThread('t1');
    await poller.pollOnce();

    db.recordOutgoing('t1', 'Так, актуально', 'bot');
    olx.addMessage('t1', 'sent', 'Так, актуально', '2026-11-19 13:00:00');
    await poller.pollOnce();
    expect(db.getThread('t1')!.lastOwnerMsgAt).toBeNull();

    olx.addMessage('t1', 'sent', 'Набери мене', '2026-11-19 13:30:00');
    await poller.pollOnce();
    expect(db.getThread('t1')!.lastOwnerMsgAt).toBe(Date.UTC(2026, 10, 19, 11, 30));
  });

  it('a failing thread does not block others and is retried next time', async () => {
    const { olx, poller, processor } = setup();
    olx.addThread('t1');
    olx.addThread('t2');
    await poller.pollOnce();
    olx.addMessage('t1', 'received', 'a');
    olx.addMessage('t2', 'received', 'b');
    olx.failMessagesFor.add('t1');
    const stats = await poller.pollOnce();
    expect(stats.failedThreads).toBe(1);
    expect(processor.batches.map((b) => b.thread.uuid)).toEqual(['t2']);

    olx.failMessagesFor.clear();
    await poller.pollOnce();
    expect(processor.batches.map((b) => b.thread.uuid)).toEqual(['t2', 't1']);
  });

  it('retries messages left unprocessed by a crash', async () => {
    const { olx, poller, db } = setup();
    olx.addThread('t1');
    await poller.pollOnce();
    olx.addMessage('t1', 'received', 'x');
    const crashing: MessageProcessor = { handleNewMessages: vi.fn().mockRejectedValue(new Error('crash')) };
    const p2 = new Poller({ db, olx, processor: crashing, logger: nullLogger, timezone: 'Europe/Kyiv' });
    await p2.pollOnce();
    expect(db.listUnprocessedMessages('t1')).toHaveLength(1);

    const ok = new RecordingProcessor(db);
    await new Poller({ db, olx, processor: ok, logger: nullLogger, timezone: 'Europe/Kyiv' }).pollOnce();
    expect(ok.batches).toHaveLength(1);
  });

  it('ignored threads are not fetched', async () => {
    const { olx, poller, db } = setup();
    olx.addThread('t1');
    await poller.pollOnce();
    db.setThreadIgnored('t1', true);
    olx.addMessage('t1', 'received', 'spam');
    olx.calls.length = 0;
    await poller.pollOnce();
    expect(olx.calls).toEqual(['listAllThreads']);
  });

  it('tick: honours pause, alerts on auth and blocks polling after HTML 403', async () => {
    let now = Date.UTC(2026, 10, 19, 12);
    const { olx, poller, alerts } = setup(() => now);
    const spy = vi.spyOn(olx, 'listAllThreads');

    poller.setPaused(true);
    await poller.tick();
    expect(spy).not.toHaveBeenCalled();
    poller.setPaused(false);

    spy.mockRejectedValueOnce(new OlxAuthRequiredError('no tokens'));
    await poller.tick();
    expect(alerts.at(-1)).toEqual({ kind: 'auth_required', reason: 'no tokens' });

    spy.mockRejectedValueOnce(new OlxBlockedError(now + 30 * 60_000));
    await poller.tick();
    expect(alerts.at(-1)!.kind).toBe('blocked');
    const callsAfterBlock = spy.mock.calls.length;
    now += 10 * 60_000;
    await poller.tick();
    expect(spy.mock.calls.length).toBe(callsAfterBlock);
    now += 21 * 60_000;
    await poller.tick();
    expect(spy.mock.calls.length).toBe(callsAfterBlock + 1);
  });

  it('tick: alerts after 3 consecutive failures and on recovery', async () => {
    const { olx, poller, alerts } = setup();
    const spy = vi.spyOn(olx, 'listAllThreads');
    spy.mockRejectedValue(new Error('down'));
    await poller.tick();
    await poller.tick();
    expect(alerts).toHaveLength(0);
    await poller.tick();
    expect(alerts[0]).toMatchObject({ kind: 'failing', consecutiveFailures: 3 });
    spy.mockReset();
    spy.mockResolvedValue([]);
    await poller.tick();
    expect(alerts.map((a) => a.kind)).toContain('recovered');
  });
});

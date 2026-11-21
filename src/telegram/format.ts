/** Rendering of Telegram thread cards (HTML parse mode) and their inline keyboards. */
import { InlineKeyboard } from 'grammy';
import type { AdvertRow, DraftRow, MessageRow, ThreadRow } from '../db/index.js';
import type { CardStatus } from '../notify.js';
import { INTENT_LABELS } from '../rules/classifier.js';
import { formatPrice } from '../rules/templates.js';
import { draftIntents } from '../services/replies.js';
import { formatLocal, wallTime } from '../time.js';

export const MAX_TG_TEXT = 4096;
const MAX_HISTORY_MSG = 600;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface CardData {
  thread: ThreadRow;
  advert: AdvertRow | null;
  buyerName: string | null;
  history: MessageRow[];
  timezone: string;
}

function hhmm(ts: number, tz: string): string {
  const w = wallTime(ts, tz);
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

function header(d: CardData): string {
  const title = d.advert?.title ?? `Оголошення #${d.thread.advertId}`;
  const price = d.advert ? formatPrice(d.advert.priceValue, d.advert.priceCurrency) : '';
  const titleHtml = d.advert?.url ? `<a href="${esc(d.advert.url)}"><b>${esc(title)}</b></a>` : `<b>${esc(title)}</b>`;
  const buyer = d.buyerName ? esc(d.buyerName) : `покупець #${d.thread.interlocutorId}`;
  const lines = [`📦 ${titleHtml}${price ? ` — ${esc(price)}` : ''}`, `👤 ${buyer}`];
  if (d.thread.ignored) lines.push('🔕 <i>тред ігнорується</i>');
  return lines.join('\n');
}

function historyBlock(d: CardData): string {
  if (d.history.length === 0) return '';
  return d.history
    .map((m) => {
      const icon = m.author === 'buyer' ? '👤' : m.author === 'bot' ? '🤖' : '🧑';
      const att = m.hasAttachments ? ' 📎<i>вкладення</i>' : '';
      const text = m.text ? esc(clip(m.text, MAX_HISTORY_MSG)) : '';
      return `${icon} <i>${hhmm(m.createdAt, d.timezone)}</i> ${text}${att}`;
    })
    .join('\n');
}

function draftSource(d: DraftRow): string {
  if (d.source === 'llm') return 'LLM';
  const intents = draftIntents(d).map((i) => INTENT_LABELS[i]);
  return `шаблон: ${intents.join(', ') || d.intent}`;
}

const quote = (text: string) => `<blockquote>${esc(clip(text, 1500))}</blockquote>`;
/** Draft text plus a note about attached photos. */
const draftQuote = (d: DraftRow) => `${quote(d.text)}${d.photos.length ? `\n📷 <i>+ ${d.photos.length} фото</i>` : ''}`;

export function statusBlock(s: CardStatus, tz: string): string {
  switch (s.kind) {
    case 'forward':
      return `📨 <b>Без автовідповіді</b>: ${esc(s.reason)}`;
    case 'draft':
      return [`✍️ <b>Чернетка</b> (${esc(draftSource(s.draft))})`, s.note ? `<i>${esc(s.note)}</i>` : '', draftQuote(s.draft)]
        .filter(Boolean)
        .join('\n');
    case 'scheduled':
      return `🌙 <b>Тихі години</b>: надішлю о ${esc(formatLocal(s.draft.scheduledFor ?? 0, tz))}\n${draftQuote(s.draft)}`;
    case 'auto_sent':
      return [`🤖 <b>Автовідповідь надіслано</b>${s.note ? ` (${esc(s.note)})` : ''}`, draftQuote(s.draft)].join('\n');
    case 'send_failed':
      return `❌ <b>Не вдалося надіслати</b>: ${esc(s.error)}\n${draftQuote(s.draft)}`;
    case 'draft_sent':
      return `✅ <b>Надіслано</b>\n${draftQuote(s.draft)}`;
    case 'draft_skipped':
      return `⏭ <b>Чернетку пропущено</b>`;
    case 'draft_superseded':
      return `↩️ <b>Чернетку скасовано</b>: ${esc(s.reason)}`;
  }
}

export function renderCard(d: CardData, s: CardStatus): string {
  const parts = [header(d), historyBlock(d), statusBlock(s, d.timezone)].filter(Boolean);
  let text = parts.join('\n\n');
  // Keep under Telegram's limit by trimming the history first.
  let history = d.history;
  while (text.length > MAX_TG_TEXT && history.length > 1) {
    history = history.slice(1);
    text = [header(d), historyBlock({ ...d, history }), statusBlock(s, d.timezone)].filter(Boolean).join('\n\n');
  }
  return clip(text, MAX_TG_TEXT);
}

/** Draft id of the card, if its draft is still actionable. */
export function actionableDraft(s: CardStatus): DraftRow | null {
  if (s.kind === 'draft' || s.kind === 'scheduled' || s.kind === 'send_failed') return s.draft;
  return null;
}

/** `photos`: there are photo sets for this thread's advert (shows the "📷 Фото" button). */
export function threadKeyboard(thread: ThreadRow, draft: DraftRow | null, photos = false): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (draft) {
    kb.text(draft.status === 'scheduled' ? '✅ Надіслати зараз' : '✅ Надіслати', `d:send:${draft.id}`)
      .text('✏️ Редагувати', `d:edit:${draft.id}`)
      .text(draft.status === 'scheduled' ? '✖️ Скасувати' : '⏭ Пропустити', `d:skip:${draft.id}`)
      .row();
  }
  kb.text('💬 Відповісти', 't:reply').text('📋 Шаблони', 't:tpl');
  if (photos) kb.text('📷 Фото', 't:ph');
  kb.row();
  kb.text('👁 Прочитано', 't:read');
  kb.text(thread.ignored ? '🔔 Не ігнорувати' : '🔕 Ігнорувати тред', thread.ignored ? 't:unign' : 't:ign');
  return kb;
}

export function quickTemplatesKeyboard(quick: { id: string; label: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  quick.forEach((q, i) => {
    kb.text(q.label, `q:${q.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (quick.length % 2 === 1) kb.row();
  return kb.text('⬅️ Назад', 't:back');
}

export function photoSetsKeyboard(sets: { id: string; label: string; urls: string[] }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of sets) kb.text(`📷 ${s.label} (${s.urls.length})`, `p:${s.id}`).row();
  return kb.text('⬅️ Назад', 't:back');
}

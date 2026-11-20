/**
 * Zod schemas for OLX Partner API v2 responses (developer.olx.ua/swagger/v2/partner_api.yaml).
 *
 * Notes from the spec:
 *  - Thread.id / Message.id / Message.thread_id are deprecated; `uuid` / `thread_uuid` are preferred.
 *    We fall back to the numeric id only if uuid is missing.
 *  - The spec declares GET /threads and GET /threads/{id}/messages as plain arrays, while GET /adverts/{id}
 *    is wrapped in {"data": ...}. We accept both shapes everywhere.
 *  - created_at looks like "2018-01-30 08:26:36" (no timezone).
 */
import { z } from 'zod';

const looseString = z.string().nullish().transform((v) => v ?? '');

/** Accepts `T` or `{ data: T }`. */
export function unwrapData<T extends z.ZodType>(schema: T) {
  return z.union([
    z.object({ data: schema }).transform((o) => (o as { data: z.output<T> }).data),
    schema,
  ]) as unknown as z.ZodType<z.output<T>>;
}

export const threadSchema = z
  .object({
    id: z.number().int().nullish(),
    uuid: z.string().min(1).nullish(),
    advert_id: z.coerce.number().int(),
    interlocutor_id: z.coerce.number().int(),
    total_count: z.coerce.number().int().default(0),
    unread_count: z.coerce.number().int().default(0),
    created_at: z.string().nullish(),
    is_favourite: z.boolean().nullish(),
  })
  .refine((t) => t.uuid || t.id !== null && t.id !== undefined, { message: 'thread has neither uuid nor id' })
  .transform((t) => ({
    key: t.uuid ?? String(t.id),
    legacyId: t.id ?? null,
    advertId: t.advert_id,
    interlocutorId: t.interlocutor_id,
    totalCount: t.total_count,
    unreadCount: t.unread_count,
    createdAt: t.created_at ?? null,
    isFavourite: t.is_favourite ?? false,
  }));
export type OlxThread = z.output<typeof threadSchema>;

const fileRef = z.object({ name: z.string().nullish(), url: z.string().nullish() });

export const messageSchema = z
  .object({
    id: z.number().int().nullish(),
    uuid: z.string().min(1).nullish(),
    thread_id: z.number().int().nullish(),
    thread_uuid: z.string().nullish(),
    created_at: z.string(),
    type: z.string(),
    text: looseString,
    is_read: z.boolean().nullish(),
    attachments: z.array(fileRef).nullish(),
    cvs: z.array(fileRef).nullish(),
  })
  .refine((m) => m.uuid || m.id !== null && m.id !== undefined, { message: 'message has neither uuid nor id' })
  .transform((m) => ({
    key: m.uuid ?? String(m.id),
    type: m.type,
    text: m.text,
    createdAt: m.created_at,
    isRead: m.is_read ?? false,
    attachments: m.attachments ?? [],
    hasAttachments: (m.attachments?.length ?? 0) > 0 || (m.cvs?.length ?? 0) > 0,
  }));
export type OlxMessage = z.output<typeof messageSchema>;

export const advertSchema = z
  .object({
    id: z.coerce.number().int(),
    title: z.string(),
    description: looseString,
    url: z.string().nullish(),
    status: z.string().nullish(),
    price: z
      .object({
        value: z.coerce.number().nullish(),
        currency: z.string().nullish(),
        negotiable: z.boolean().nullish(),
      })
      .nullish(),
  })
  .transform((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    url: a.url ?? null,
    status: a.status ?? null,
    priceValue: a.price?.value ?? null,
    priceCurrency: a.price?.currency ?? null,
    negotiable: a.price?.negotiable ?? null,
  }));
export type OlxAdvert = z.output<typeof advertSchema>;

export const userSchema = z.object({
  id: z.coerce.number().int(),
  name: z.string().nullish(),
});
export type OlxUser = z.output<typeof userSchema>;

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.coerce.number().positive(),
  token_type: z.string().optional(),
  scope: z.string().nullish(),
});
export type TokenResponse = z.output<typeof tokenResponseSchema>;

export const threadListSchema = unwrapData(z.array(threadSchema));
export const messageListSchema = unwrapData(z.array(messageSchema));
export const advertResponseSchema = unwrapData(advertSchema);
export const userResponseSchema = unwrapData(userSchema);

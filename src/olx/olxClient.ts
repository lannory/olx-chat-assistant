/**
 * Typed client for the OLX Partner API v2 (https://www.olx.ua/api/partner).
 * Every call sends `Authorization: Bearer` and `Version: 2.0`. On 401 the token is refreshed and the
 * request is retried exactly once. 429/5xx/network errors are retried with backoff (see http.ts).
 */
import type { z } from 'zod';
import { OlxApiError } from './errors.js';
import { fetchWithRetry, parseResponse, type HttpDeps, type RawRequest } from './http.js';
import type { OAuthService } from './oauth.js';
import {
  advertResponseSchema,
  messageListSchema,
  threadListSchema,
  unwrapData,
  threadSchema,
  userResponseSchema,
  type OlxAdvert,
  type OlxMessage,
  type OlxThread,
  type OlxUser,
} from './schemas.js';

export const API_VERSION = '2.0';

export interface ListThreadsParams {
  advertId?: number;
  interlocutorId?: number;
  offset?: number;
  limit?: number;
}

export interface OlxApi {
  listThreads(params?: ListThreadsParams): Promise<OlxThread[]>;
  listAllThreads(pageSize?: number): Promise<OlxThread[]>;
  getThread(threadId: string): Promise<OlxThread>;
  getMessages(threadId: string): Promise<OlxMessage[]>;
  sendMessage(threadId: string, text: string): Promise<void>;
  markAsRead(threadId: string): Promise<void>;
  getAdvert(advertId: number): Promise<OlxAdvert>;
  getUser(userId: number): Promise<OlxUser>;
}

export class OlxClient implements OlxApi {
  private readonly apiBase: string;

  constructor(
    baseUrl: string,
    private readonly auth: Pick<OAuthService, 'getAccessToken' | 'refresh'>,
    private readonly http: HttpDeps,
  ) {
    this.apiBase = new URL('/api/partner', baseUrl).toString().replace(/\/$/, '');
  }

  listThreads(params: ListThreadsParams = {}): Promise<OlxThread[]> {
    const query = new URLSearchParams();
    if (params.advertId !== undefined) query.set('advert_id', String(params.advertId));
    if (params.interlocutorId !== undefined) query.set('interlocutor_id', String(params.interlocutorId));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.call('GET', `/threads${qs ? `?${qs}` : ''}`, threadListSchema);
  }

  /**
   * Walks all pages of /threads. Stops on a short page, or when a page brings no new threads
   * (protects against a server that ignores offset), or after `maxPages`.
   */
  async listAllThreads(pageSize = 50, maxPages = 40): Promise<OlxThread[]> {
    const seen = new Map<string, OlxThread>();
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.listThreads({ offset: page * pageSize, limit: pageSize });
      let added = 0;
      for (const t of batch) {
        if (!seen.has(t.key)) {
          seen.set(t.key, t);
          added++;
        }
      }
      if (batch.length < pageSize || added === 0) break;
    }
    return [...seen.values()];
  }

  getThread(threadId: string): Promise<OlxThread> {
    return this.call('GET', `/threads/${encodeURIComponent(threadId)}`, unwrapData(threadSchema));
  }

  getMessages(threadId: string): Promise<OlxMessage[]> {
    return this.call('GET', `/threads/${encodeURIComponent(threadId)}/messages`, messageListSchema);
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    await this.call('POST', `/threads/${encodeURIComponent(threadId)}/messages`, null, { text });
  }

  async markAsRead(threadId: string): Promise<void> {
    await this.call('POST', `/threads/${encodeURIComponent(threadId)}/commands`, null, { command: 'mark-as-read' });
  }

  getAdvert(advertId: number): Promise<OlxAdvert> {
    return this.call('GET', `/adverts/${advertId}`, advertResponseSchema);
  }

  getUser(userId: number): Promise<OlxUser> {
    return this.call('GET', `/users/${userId}`, userResponseSchema);
  }

  private async call<S extends z.ZodType>(
    method: RawRequest['method'],
    path: string,
    schema: S | null,
    body?: unknown,
  ): Promise<z.output<S>> {
    const url = `${this.apiBase}${path}`;
    let token = await this.auth.getAccessToken();
    for (let authRetry = 0; ; authRetry++) {
      const res = await fetchWithRetry(
        { method, url, body, headers: { Authorization: `Bearer ${token}`, Version: API_VERSION } },
        this.http,
      );
      if (res.status === 401 && authRetry === 0) {
        void res.body?.cancel().catch(() => undefined);
        this.http.logger.info({ url }, 'OLX returned 401, refreshing token and retrying once');
        token = (await this.auth.refresh()).accessToken;
        continue;
      }
      try {
        return await parseResponse(res, schema, url);
      } catch (err) {
        if (err instanceof OlxApiError) this.http.logger.debug({ status: err.status, body: err.body }, 'OLX error body');
        throw err;
      }
    }
  }
}

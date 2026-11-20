/**
 * OLX OAuth2 (authorization_code + refresh_token), per developer.olx.ua/docs/authorization-in-api:
 *  - authorize:  {base}/oauth/authorize?client_id&response_type=code&state&scope[&redirect_uri]
 *  - token:      POST {base}/api/open/oauth/token (also used for refresh), JSON body
 *  - the code lives 10 minutes; refresh tokens live 30 days and are rotated on refresh,
 *    so the new refresh_token from every response must be persisted.
 */
import { randomBytes } from 'node:crypto';
import type { Db, StoredTokens } from '../db/index.js';
import { OlxApiError, OlxAuthRequiredError } from './errors.js';
import { fetchWithRetry, parseResponse, type HttpDeps } from './http.js';
import { tokenResponseSchema, type TokenResponse } from './schemas.js';

export interface OAuthConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

/** Refresh this long before the access token expires. */
const REFRESH_SKEW_MS = 5 * 60_000;
/**
 * How long an authorize link (its `state`) stays usable. Links are sent to Telegram and may be
 * opened hours later; the OLX `code` itself still expires 10 minutes after consent.
 */
export const STATE_TTL_MS = 24 * 3600_000;

export type AuthFailureHandler = (reason: string) => void | Promise<void>;

export class OAuthService {
  private refreshing: Promise<StoredTokens> | null = null;
  private failureHandlers: AuthFailureHandler[] = [];

  constructor(
    private readonly cfg: OAuthConfig,
    private readonly db: Db,
    private readonly http: HttpDeps,
  ) {}

  /** Registers a callback fired when tokens become unusable and re-authorization is required. */
  onAuthFailure(handler: AuthFailureHandler): void {
    this.failureHandlers.push(handler);
  }

  get tokenUrl(): string {
    return new URL('/api/open/oauth/token', this.cfg.baseUrl).toString();
  }

  /** Builds the OLX consent URL and stores a fresh `state` for CSRF protection. */
  createAuthorizeUrl(): string {
    const state = randomBytes(16).toString('hex');
    this.db.createOAuthState(state);
    const url = new URL('/oauth/authorize', this.cfg.baseUrl);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('scope', this.cfg.scope);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    return url.toString();
  }

  /** Exchanges the authorization code for tokens after validating `state`. */
  async exchangeCode(code: string, state: string): Promise<StoredTokens> {
    if (!this.db.consumeOAuthState(state, STATE_TTL_MS)) {
      throw new Error('Invalid or expired OAuth state. Start the authorization again.');
    }
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      scope: this.cfg.scope,
      redirect_uri: this.cfg.redirectUri,
    });
    this.http.logger.info('OLX authorization completed, tokens stored');
    return tokens;
  }

  hasTokens(): boolean {
    return this.db.getTokens() !== null;
  }

  /** Returns a valid access token, refreshing it proactively when close to expiry. */
  async getAccessToken(): Promise<string> {
    const t = this.db.getTokens();
    if (!t) throw new OlxAuthRequiredError();
    if (t.expiresAt - REFRESH_SKEW_MS > this.http.now()) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  /**
   * Refreshes tokens. Concurrent callers share one in-flight refresh (important: OLX rotates
   * refresh tokens, so two parallel refreshes would invalidate each other).
   */
  refresh(): Promise<StoredTokens> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredTokens> {
    const current = this.db.getTokens();
    if (!current) throw new OlxAuthRequiredError();
    try {
      const tokens = await this.tokenRequest({
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: current.refreshToken,
      });
      this.http.logger.info('OLX access token refreshed');
      return tokens;
    } catch (err) {
      // 400/401 from the token endpoint (invalid_grant, invalid_client…) is permanent: re-auth needed.
      if (err instanceof OlxApiError && (err.status === 400 || err.status === 401)) {
        const reason = err.message;
        this.http.logger.error({ status: err.status }, 'OLX token refresh rejected; re-authorization required');
        await this.notifyFailure(reason);
        throw new OlxAuthRequiredError(`OLX token refresh failed: ${reason}`);
      }
      throw err;
    }
  }

  private async notifyFailure(reason: string): Promise<void> {
    for (const h of this.failureHandlers) {
      try {
        await h(reason);
      } catch (err) {
        this.http.logger.error({ err }, 'auth failure handler threw');
      }
    }
  }

  private async tokenRequest(body: Record<string, string>): Promise<StoredTokens> {
    const url = this.tokenUrl;
    const res = await fetchWithRetry({ method: 'POST', url, body }, this.http);
    const parsed: TokenResponse = await parseResponse(res, tokenResponseSchema, url);
    const tokens: StoredTokens = {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresAt: this.http.now() + parsed.expires_in * 1000,
      scope: parsed.scope ?? null,
    };
    this.db.saveTokens(tokens);
    return tokens;
  }
}

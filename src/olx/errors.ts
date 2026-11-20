export class OlxApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'OlxApiError';
  }
}

/** No valid tokens: the owner has to (re-)authorize the app in OLX. */
export class OlxAuthRequiredError extends Error {
  constructor(message = 'OLX authorization required') {
    super(message);
    this.name = 'OlxAuthRequiredError';
  }
}

/**
 * OLX (CloudFront) blocked our IP: per docs, >4500 requests / 5 min → HTML 403 for 30 minutes.
 */
export class OlxBlockedError extends Error {
  constructor(readonly retryAt: number) {
    super('OLX blocked requests from this IP (HTML 403, rate limit). Pausing.');
    this.name = 'OlxBlockedError';
  }
}

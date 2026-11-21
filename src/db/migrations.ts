/**
 * Ordered list of schema migrations. Each entry runs once; the applied version is kept in
 * `PRAGMA user_version`. SQL is kept ANSI-ish (no SQLite-only types) so it ports to PostgreSQL.
 * All timestamps are unix epoch milliseconds.
 */
export const migrations: string[] = [
  /* 1 */ `
  CREATE TABLE oauth_tokens (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    access_token  TEXT    NOT NULL,
    refresh_token TEXT    NOT NULL,
    expires_at    BIGINT  NOT NULL,
    scope         TEXT,
    updated_at    BIGINT  NOT NULL
  );

  CREATE TABLE oauth_states (
    state      TEXT   PRIMARY KEY,
    created_at BIGINT NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE threads (
    uuid              TEXT    PRIMARY KEY,
    legacy_id         BIGINT,
    advert_id         BIGINT  NOT NULL,
    interlocutor_id   BIGINT  NOT NULL,
    interlocutor_name TEXT,
    total_count       INTEGER NOT NULL DEFAULT 0,
    unread_count      INTEGER NOT NULL DEFAULT 0,
    last_seen_total   INTEGER NOT NULL DEFAULT 0,
    ignored           INTEGER NOT NULL DEFAULT 0,
    last_owner_msg_at BIGINT,
    updated_at        BIGINT  NOT NULL
  );

  -- Every message the poller has seen. processed_at marks it as handled (dedup across restarts).
  CREATE TABLE messages (
    uuid            TEXT    PRIMARY KEY,
    thread_uuid     TEXT    NOT NULL,
    type            TEXT    NOT NULL,           -- sent | received
    author          TEXT,                       -- buyer | owner | bot (for type=sent: owner|bot)
    text            TEXT    NOT NULL DEFAULT '',
    has_attachments INTEGER NOT NULL DEFAULT 0,
    created_at      BIGINT  NOT NULL,
    processed_at    BIGINT
  );
  CREATE INDEX idx_messages_thread ON messages (thread_uuid, created_at);

  -- Messages this service posted to OLX (by the bot or by the owner via Telegram).
  -- Used to tell bot-sent messages apart from ones the owner typed in the OLX app.
  CREATE TABLE outgoing (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_uuid TEXT    NOT NULL,
    text        TEXT    NOT NULL,
    author      TEXT    NOT NULL,               -- bot | owner
    sent_at     BIGINT  NOT NULL,
    matched_uuid TEXT
  );
  CREATE INDEX idx_outgoing_thread ON outgoing (thread_uuid, sent_at);

  CREATE TABLE auto_replies (
    thread_uuid  TEXT   NOT NULL,
    intent       TEXT   NOT NULL,
    message_uuid TEXT   NOT NULL,
    sent_at      BIGINT NOT NULL,
    PRIMARY KEY (thread_uuid, intent)
  );

  CREATE TABLE drafts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_uuid   TEXT    NOT NULL,
    message_uuid  TEXT    NOT NULL,
    intent        TEXT    NOT NULL,
    text          TEXT    NOT NULL,
    source        TEXT    NOT NULL,             -- rule | llm
    status        TEXT    NOT NULL,             -- pending | scheduled | sent | skipped | superseded
    scheduled_for BIGINT,
    tg_chat_id    BIGINT,
    tg_message_id BIGINT,
    created_at    BIGINT  NOT NULL,
    updated_at    BIGINT  NOT NULL
  );
  CREATE INDEX idx_drafts_status ON drafts (status, scheduled_for);

  -- Telegram message → OLX thread, so a reply to a forwarded card goes to the right thread.
  CREATE TABLE tg_links (
    tg_chat_id    BIGINT NOT NULL,
    tg_message_id BIGINT NOT NULL,
    thread_uuid   TEXT   NOT NULL,
    draft_id      INTEGER,
    created_at    BIGINT NOT NULL,
    PRIMARY KEY (tg_chat_id, tg_message_id)
  );

  CREATE TABLE adverts_cache (
    id             BIGINT PRIMARY KEY,
    title          TEXT   NOT NULL,
    description    TEXT   NOT NULL DEFAULT '',
    price_value    DOUBLE PRECISION,
    price_currency TEXT,
    negotiable     INTEGER,
    url            TEXT,
    status         TEXT,
    fetched_at     BIGINT NOT NULL
  );
  `,
  /* 2: photo URLs sent together with a draft (JSON array of strings) */ `
  ALTER TABLE drafts ADD COLUMN photos TEXT;
  `,
];

-- 0009_auth_sessions.sql
-- Refresh-token sessions backing the short-lived access tokens.
--
-- One row per login. Each /auth/refresh rotates the row in place: a new
-- secret hash is written and last_used_at is bumped. Only the SHA-256 of the
-- refresh secret is ever stored, so a dump of this table cannot be replayed.
--
-- Two independent deadlines end a session:
--   * idle     -> now() - last_used_at > AUTH_SESSION_IDLE_TIMEOUT_MS
--   * absolute -> now() > absolute_expires_at
-- Both are enforced in the service on every refresh; the columns here are
-- what those checks read.
--
-- auth-service applies the same DDL itself at boot (idempotent), so this file
-- exists for teams driving schema with a migration tool instead.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id                  TEXT PRIMARY KEY,          -- session id, also the refresh-token prefix
  user_id             TEXT NOT NULL,
  refresh_token_hash  TEXT NOT NULL,             -- sha256 of the current secret
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,      -- refresh-token expiry
  absolute_expires_at TIMESTAMPTZ NOT NULL,      -- hard ceiling from login
  rotations           INTEGER NOT NULL DEFAULT 0,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT,                      -- logout | logout_all | session_idle_timeout
                                                 -- | session_absolute_timeout | refresh_token_reuse
                                                 -- | password_reset | password_changed
  ip                  TEXT,
  user_agent          TEXT,
  browser             TEXT,
  os                  TEXT,
  device              TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions (user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_hash ON auth_sessions (refresh_token_hash);


-- Notifications move from fire-and-forget to a durable Postgres queue.
-- notification-service INSERTs jobs; notification-worker claims them with
-- FOR UPDATE SKIP LOCKED so N worker replicas never process the same row.
CREATE TABLE IF NOT EXISTS notification_jobs (
  id           TEXT PRIMARY KEY,
  channel      TEXT NOT NULL,                    -- 'email' | 'sms'
  recipient    TEXT NOT NULL,
  subject      TEXT,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued|processing|sent|dead
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error   TEXT,
  trace_id     TEXT,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by    TEXT,
  locked_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The claim query filters on (status, run_at) and orders by run_at; this
-- index is what keeps SKIP LOCKED cheap as the dead/sent rows accumulate.
CREATE INDEX IF NOT EXISTS idx_notification_jobs_claim ON notification_jobs (status, run_at);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_trace ON notification_jobs (trace_id);


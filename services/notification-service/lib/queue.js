'use strict';
// Postgres-backed notification queue, shared by server.js (producer) and
// worker.js (consumer). Falls back to an in-process queue when DATABASE_URL
// is unset so `docker compose up` still works without the database — the
// same pattern invoice-service uses.
const crypto = require('crypto');

// Mirrored in db/migrations/0007_notification_jobs.sql. Idempotent, so both
// the API and the workers can run it on boot without racing each other.
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS notification_jobs (
    id           TEXT PRIMARY KEY,
    channel      TEXT NOT NULL,
    recipient    TEXT NOT NULL,
    subject      TEXT,
    body         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'queued',
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error   TEXT,
    trace_id     TEXT,
    template     TEXT,
    payload      JSONB,
    run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_by    TEXT,
    locked_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_notification_jobs_claim ON notification_jobs (status, run_at);
  CREATE INDEX IF NOT EXISTS idx_notification_jobs_trace ON notification_jobs (trace_id);
`;

// `id` is ambiguous inside UPDATE ... FROM claimed, so the claim query needs
// the table-qualified variant; everything else uses the bare one.
const cols = (p = '') => `${p}id, ${p}channel, ${p}recipient, ${p}subject, ${p}body, ${p}status,
  ${p}template, ${p}payload,
  ${p}attempts, ${p}max_attempts AS "maxAttempts", ${p}last_error AS "lastError",
  ${p}trace_id AS "traceId", ${p}run_at AS "runAt",
  ${p}created_at AS "createdAt", ${p}updated_at AS "updatedAt"`;
const ROW = cols();
const ROW_J = cols('j.');

const newJobId = () => 'ntf-' + crypto.randomBytes(6).toString('hex');

function createQueue({ pool, logger }) {
  if (!pool) return memoryQueue({ logger });

  return {
    mode: 'postgres',

    async init() { await pool.query(MIGRATION); },

    async enqueue({ channel, recipient, subject, body, traceId, maxAttempts, template, payload }) {
      const { rows } = await pool.query(
        `INSERT INTO notification_jobs (id, channel, recipient, subject, body, trace_id, max_attempts, template, payload)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, 5),$8,$9) RETURNING ${ROW}`,
        [newJobId(), channel, recipient, subject || null, body || '', traceId || null, maxAttempts || null,
         template || null, payload ? JSON.stringify(payload) : null]);
      return rows[0];
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${ROW} FROM notification_jobs WHERE id = $1`, [id]);
      return rows[0] || null;
    },

    // Atomic claim. SKIP LOCKED means a row already locked by another worker
    // is stepped over rather than waited on, so replicas scale linearly and
    // no job is ever delivered twice concurrently.
    async claim(workerId, batchSize) {
      const { rows } = await pool.query(
        `WITH claimed AS (
           SELECT id FROM notification_jobs
           WHERE status = 'queued' AND run_at <= now()
           ORDER BY run_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE notification_jobs j
            SET status = 'processing', attempts = j.attempts + 1,
                locked_by = $1, locked_at = now(), updated_at = now()
           FROM claimed
          WHERE j.id = claimed.id
          RETURNING ${ROW_J}`,
        [workerId, batchSize]);
      return rows;
    },

    async markSent(id) {
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'sent', last_error = NULL, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1`, [id]);
    },

    // Requeue with backoff, or park the job as 'dead' once it has burned
    // through max_attempts so it stops consuming worker cycles forever.
    async markFailed(id, message, backoffSeconds) {
      const { rows } = await pool.query(
        `UPDATE notification_jobs
            SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
                run_at = CASE WHEN attempts >= max_attempts THEN run_at
                              ELSE now() + ($2 || ' seconds')::interval END,
                last_error = $3, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1
          RETURNING status, attempts`,
        [id, String(backoffSeconds), String(message).slice(0, 500)]);
      return rows[0] || null;
    },

    // Put a job back WITHOUT charging it an attempt. Used for failures that
    // are not the message's fault (SMTP unreachable, bad credentials), where
    // counting attempts would dead-letter the whole backlog over one config
    // error. claim() already incremented, so this undoes that.
    async requeue(id, delaySeconds, message) {
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'queued', attempts = GREATEST(0, attempts - 1),
                run_at = now() + ($2 || ' seconds')::interval,
                last_error = $3, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1`,
        [id, String(delaySeconds), String(message).slice(0, 500)]);
    },

    // Errors that can never succeed on retry (invalid recipient, unknown
    // channel) skip the backoff ladder entirely.
    async markDead(id, message) {
      await pool.query(
        `UPDATE notification_jobs
            SET status = 'dead', last_error = $2, locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1`, [id, String(message).slice(0, 500)]);
    },

    // A worker killed mid-delivery leaves its rows in 'processing' forever.
    // Any surviving worker sweeps them back to 'queued' after the lock ages
    // out (at-least-once delivery — the mock providers are idempotent).
    async reclaimStale(staleSeconds) {
      const { rowCount } = await pool.query(
        `UPDATE notification_jobs
            SET status = 'queued', locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE status = 'processing' AND locked_at < now() - ($1 || ' seconds')::interval`,
        [String(staleSeconds)]);
      return rowCount;
    },

    async stats() {
      const { rows } = await pool.query(
        `SELECT status, count(*)::int AS count FROM notification_jobs GROUP BY status`);
      return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {});
    },

    async ping() { await pool.query('SELECT 1'); }
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback. Single-process only: an in-process worker will drain it,
// but a separate worker container has no shared state, hence the loud warning.
function memoryQueue({ logger }) {
  const jobs = new Map();
  if (logger) {
    logger.warn({ event: 'queue_memory_mode' },
      'DATABASE_URL unset — using in-memory queue; separate worker replicas will NOT see these jobs');
  }
  const now = () => new Date();

  return {
    mode: 'memory',
    async init() {},
    async enqueue({ channel, recipient, subject, body, traceId, maxAttempts, template, payload }) {
      const job = {
        id: newJobId(), channel, recipient, subject: subject || null, body: body || '',
        status: 'queued', attempts: 0, maxAttempts: maxAttempts || 5, lastError: null,
        traceId: traceId || null, template: template || null, payload: payload || null,
        runAt: now(), createdAt: now(), updatedAt: now()
      };
      jobs.set(job.id, job);
      return job;
    },
    async get(id) { return jobs.get(id) || null; },
    async claim(workerId, batchSize) {
      const claimed = [];
      for (const job of jobs.values()) {
        if (claimed.length >= batchSize) break;
        if (job.status === 'queued' && job.runAt <= now()) {
          Object.assign(job, { status: 'processing', attempts: job.attempts + 1, lockedBy: workerId, updatedAt: now() });
          claimed.push({ ...job });
        }
      }
      return claimed;
    },
    async markSent(id) {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: 'sent', lastError: null, updatedAt: now() });
    },
    async markFailed(id, message, backoffSeconds) {
      const job = jobs.get(id);
      if (!job) return null;
      const dead = job.attempts >= job.maxAttempts;
      Object.assign(job, {
        status: dead ? 'dead' : 'queued',
        runAt: dead ? job.runAt : new Date(Date.now() + backoffSeconds * 1000),
        lastError: String(message).slice(0, 500),
        updatedAt: now()
      });
      return { status: job.status, attempts: job.attempts };
    },
    async requeue(id, delaySeconds, message) {
      const job = jobs.get(id);
      if (job) Object.assign(job, {
        status: 'queued', attempts: Math.max(0, job.attempts - 1),
        runAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: String(message).slice(0, 500), updatedAt: now()
      });
    },
    async markDead(id, message) {
      const job = jobs.get(id);
      if (job) Object.assign(job, { status: 'dead', lastError: String(message).slice(0, 500), updatedAt: now() });
    },
    async reclaimStale() { return 0; },
    async stats() {
      return [...jobs.values()].reduce((acc, j) => ({ ...acc, [j.status]: (acc[j.status] || 0) + 1 }), {});
    },
    async ping() {}
  };
}

module.exports = { createQueue, MIGRATION };


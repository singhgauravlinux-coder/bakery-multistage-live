'use strict';
// notification-worker — the consumer half of the notification service.
//
// Runs from the SAME image as server.js (different CMD), so it inherits the
// service's image tag, CI pipeline and overlay pinning for free. Deployed as
// its own Deployment (k8s/base/services/notification-worker.yaml) so delivery
// throughput scales independently of API traffic: every replica polls the
// notification_jobs table and claims rows with FOR UPDATE SKIP LOCKED, which
// makes horizontal scaling a matter of bumping `replicas`.
const crypto = require('crypto');
const http = require('http');
const pino = require('pino');
const { Pool } = require('pg');
const { createQueue } = require('./lib/queue');
const { deliver, verify: verifySmtp, close: closeProviders } = require('./lib/providers');

const SERVICE_NAME = process.env.SERVICE_NAME || 'notification-worker';
const DATABASE_URL = process.env.DATABASE_URL || '';
const WORKER_ID = `${process.env.HOSTNAME || 'local'}-${crypto.randomBytes(3).toString('hex')}`;

// Probe port. The worker serves no business traffic and has no k8s Service in
// front of it; this exists purely so kubelet can run liveness/readiness.
const PROBE_PORT = Number(process.env.WORKER_PROBE_PORT || 3110);

const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE || 10);      // jobs claimed per tick
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);     // in-flight deliveries per replica
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 1000);
const IDLE_INTERVAL_MS = Number(process.env.WORKER_IDLE_INTERVAL_MS || 5000);
const BACKOFF_BASE_S = Number(process.env.WORKER_BACKOFF_BASE_SECONDS || 5);
const BACKOFF_MAX_S = Number(process.env.WORKER_BACKOFF_MAX_SECONDS || 900);
const STALE_LOCK_S = Number(process.env.WORKER_STALE_LOCK_SECONDS || 300);
const SHUTDOWN_GRACE_MS = Number(process.env.WORKER_SHUTDOWN_GRACE_MS || 15000);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0', workerId: WORKER_ID },
  formatters: { level: (label) => ({ level: label }) }
});

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: Math.max(2, CONCURRENCY) }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));
const queue = createQueue({ pool, logger });

const state = { running: true, ready: false, inFlight: 0, processed: 0, failed: 0, deferred: 0, dead: 0, lastTickAt: null };

// Exponential backoff with full jitter — without the jitter, a provider
// outage synchronises every retry in the cluster into a thundering herd.
function backoffSeconds(attempts) {
  const ceiling = Math.min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1));
  return Math.max(1, Math.round(Math.random() * ceiling));
}

async function processJob(job) {
  // Every log line carries the originating request's traceId, so a delivery
  // in the worker can be joined to the API call that queued it.
  const log = logger.child({ traceId: job.traceId, jobId: job.id, channel: job.channel });
  const startedAt = Date.now();
  try {
    await deliver(job);
    await queue.markSent(job.id);
    state.processed += 1;
    log.info({
      event: 'notification_sent', to: job.recipient, attempts: job.attempts,
      durationMs: Date.now() - startedAt
    }, 'notification dispatched');
  } catch (err) {
    const delay = backoffSeconds(job.attempts);

    // Three outcomes, in order of severity:
    //   permanent      -> dead-letter now (bad recipient, unknown channel)
    //   infrastructure -> requeue WITHOUT charging an attempt (SMTP down or
    //                     credentials rejected: every job fails identically,
    //                     so charging attempts would dead-letter the entire
    //                     backlog over one config error)
    //   transient      -> normal backoff ladder, attempt consumed
    if (err.infrastructure) {
      await queue.requeue(job.id, delay, err.message).catch((dbErr) =>
        log.error({ event: 'job_bookkeeping_failed', message: dbErr.message }, 'could not requeue job'));
      state.deferred += 1;
      log.error({
        event: 'notification_deferred', to: job.recipient, attempts: job.attempts,
        retryInSeconds: delay, message: err.message, durationMs: Date.now() - startedAt
      }, 'delivery infrastructure unavailable — job requeued without consuming an attempt');
      return;
    }

    const result = await (err.permanent
      ? queue.markDead(job.id, err.message).then(() => ({ status: 'dead' }))
      : queue.markFailed(job.id, err.message, delay)
    ).catch((dbErr) => {
      log.error({ event: 'job_bookkeeping_failed', message: dbErr.message }, 'could not record failure');
      return null;
    });
    const dead = result && result.status === 'dead';
    if (dead) state.dead += 1; else state.failed += 1;
    log[dead ? 'error' : 'warn']({
      event: dead ? 'notification_dead_lettered' : 'notification_retry_scheduled',
      to: job.recipient, attempts: job.attempts, maxAttempts: job.maxAttempts,
      permanent: err.permanent || undefined,
      retryInSeconds: dead ? undefined : delay, message: err.message,
      durationMs: Date.now() - startedAt
    }, dead ? 'giving up on notification' : 'delivery failed, will retry');
  }
}

// Bounded fan-out: claim a batch, run at most CONCURRENCY deliveries at once.
async function runBatch(jobs) {
  const pending = [...jobs];
  const lanes = Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
    while (pending.length) {
      const job = pending.shift();
      state.inFlight += 1;
      try { await processJob(job); } finally { state.inFlight -= 1; }
    }
  });
  await Promise.all(lanes);
}

async function tick() {
  const reclaimed = await queue.reclaimStale(STALE_LOCK_S);
  if (reclaimed) logger.warn({ event: 'stale_jobs_reclaimed', count: reclaimed }, 'requeued jobs from a dead worker');

  const jobs = await queue.claim(WORKER_ID, BATCH_SIZE);
  state.lastTickAt = new Date().toISOString();
  if (!jobs.length) return 0;

  logger.debug({ event: 'batch_claimed', count: jobs.length }, 'claimed notification jobs');
  await runBatch(jobs);
  return jobs.length;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop() {
  while (state.running) {
    try {
      const count = await tick();
      state.ready = true;
      // Poll fast while there is work, slowly when the queue is empty.
      await sleep(count ? POLL_INTERVAL_MS : IDLE_INTERVAL_MS);
    } catch (err) {
      state.ready = false;
      logger.error({ event: 'worker_tick_failed', message: err.message }, 'worker loop error, backing off');
      await sleep(IDLE_INTERVAL_MS);
    }
  }
}

// --- Probe server --------------------------------------------------------
const probeServer = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (path === '/health') {
    return res.end(JSON.stringify({ status: 'ok', service: SERVICE_NAME, workerId: WORKER_ID }));
  }
  if (path === '/ready') {
    return queue.ping()
      .then(() => res.end(JSON.stringify({
        ready: state.ready, service: SERVICE_NAME, workerId: WORKER_ID,
        storage: queue.mode, inFlight: state.inFlight, processed: state.processed,
        failed: state.failed, deferred: state.deferred, dead: state.dead, lastTickAt: state.lastTickAt
      })))
      .catch(() => {
        res.statusCode = 503;
        res.end(JSON.stringify({ ready: false, service: SERVICE_NAME, storage: queue.mode }));
      });
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Route not found' }));
});

async function start() {
  if (!pool) {
    logger.warn({ event: 'worker_memory_mode' },
      'DATABASE_URL unset — this worker has no shared queue to drain; set DATABASE_URL in any real deployment');
  }
  await queue.init().catch((err) =>
    logger.warn({ event: 'migration_deferred', message: err.message }, 'notification_jobs migration will run when the database is up'));

  // Non-blocking: a bad credential shows up in the logs at boot, but jobs
  // still queue and retry rather than being lost.
  await verifySmtp(logger);

  probeServer.listen(PROBE_PORT, () => logger.info({
    event: 'worker_started', probePort: PROBE_PORT, batchSize: BATCH_SIZE,
    concurrency: CONCURRENCY, storage: queue.mode
  }, `${SERVICE_NAME} polling for jobs`));

  loop();
}

// Graceful drain: stop claiming immediately, let in-flight deliveries finish
// (anything still stuck is reclaimed by the stale-lock sweep on another pod).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (!state.running) return;
    state.running = false;
    logger.info({ event: 'shutdown', signal, inFlight: state.inFlight }, 'draining in-flight notifications');
    probeServer.close();
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (state.inFlight > 0 && Date.now() < deadline) await sleep(200);
    closeProviders();
    if (pool) await pool.end().catch(() => {});
    logger.info({ event: 'shutdown_complete', processed: state.processed, failed: state.failed, deferred: state.deferred, dead: state.dead }, 'worker stopped');
    process.exit(0);
  });
}

if (require.main === module) start();

module.exports = { tick, processJob, queue, state };


'use strict';
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Pool } = require('pg');
const { createQueue } = require('./lib/queue');
const { templateNames, render } = require('./lib/templates');

const SERVICE_NAME = process.env.SERVICE_NAME || 'notification-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

// This process is the producer half of the service: it validates and durably
// enqueues notifications, and notification-worker replicas drain the queue.
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 5 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));
const queue = createQueue({ pool, logger });

const app = express();
app.set('trust proxy', true);
app.use(express.json());
// --- Trace ID propagation -------------------------------------------------
// Accept X-Trace-Id from the caller (falling back to X-Request-Id), otherwise
// mint one. The id is echoed on the response and stamped on every log line so
// a single request can be followed across the gateway and every service.
app.use((req, res, next) => {
  const incoming = String(req.headers['x-trace-id'] || req.headers['x-request-id'] || '')
    .trim().replace(/[^\w.:-]/g, '').slice(0, 128);
  req.traceId = incoming || `trace-${crypto.randomUUID()}`;
  res.setHeader('X-Trace-Id', req.traceId);
  next();
});
// Probe/status endpoints are polled every few seconds by Kubernetes and the
// gateway health aggregator and would drown out real traffic in the logs.
const LOG_IGNORED_PATHS = new Set(['/health', '/ready']);

app.use(pinoHttp({
  logger,
  // Two flat, grep-able lines per request — 'request received' with the full
  // request detail, and 'request completed/failed' with status + duration —
  // every line carrying traceId / requestUri / client fields at the top level.
  autoLogging: { ignore: (req) => LOG_IGNORED_PATHS.has((req.url || '').split('?')[0]) },
  customAttributeKeys: { responseTime: 'durationMs' },
  customLogLevel: (req, res, err) =>
    (err || res.statusCode >= 500) ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
  customReceivedMessage: (req) => `request received: ${req.method} ${req.originalUrl || req.url}`,
  customSuccessMessage: (req, res) => `request completed: ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res) => `request failed: ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode}`,
  // Drop the bulky nested req/res dumps; the useful fields are emitted flat
  // via customProps so lines match the platform-wide log shape.
  serializers: { req: () => undefined, res: (res) => ({ statusCode: res.statusCode }) },
  customProps: (req) => {
    // pino-http applies customProps to the request child logger AND to the
    // completion log; the guard binds the fields exactly once per request.
    if (req._logPropsBound) return {};
    req._logPropsBound = true;
    return {
      traceId: req.traceId,
      requestId: req.headers['x-request-id'] || undefined,
      requestUri: req.originalUrl || req.url,
      method: req.method,
      query: Object.keys(req.query || {}).length ? req.query : undefined,
      contentLength: req.headers['content-length'] ? Number(req.headers['content-length']) : undefined,
      clientIp: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 256) : undefined
    };
  }
}));

// Sample data for /notify/templates/:name/preview. Realistic values, so the
// preview shows the layout under content of the length it will really carry.
const SAMPLES = {
  'verification-code': {
    code: '561924', purpose: 'password change', expiresMinutes: 10, customerName: 'Gaurav'
  },
  'order-confirmation': {
    orderId: 'CE-1042', customerName: 'Gaurav', currency: '₹',
    items: [
      { name: 'Sourdough, seeded', qty: 2, price: 320 },
      { name: 'Cardamom bun', qty: 4, price: 480 },
      { name: 'Salted butter, 200g', qty: 1, price: 210 }
    ],
    subtotal: 1010, delivery: 60, total: 1070,
    readyAt: 'today from 4pm', fulfilment: 'delivery',
    address: '14 Brigade Road, Bengaluru 560001',
    orderUrl: 'https://crumb-and-ember.example/orders/CE-1042'
  },
  'rider-picked-up': {
    orderId: 'CE-1042', customerName: 'Gaurav', currency: '₹',
    riderName: 'Priya',
    etaMinutes: 18,
    items: [
      { name: 'Sourdough, seeded', qty: 2 },
      { name: 'Cardamom bun', qty: 4 }
    ],
    address: '14 Brigade Road, Bengaluru 560001',
    trackingUrl: 'https://crumb-and-ember.example/orders/CE-1042/track'
  },
  'order-delivered': {
    orderId: 'CE-1042', customerName: 'Gaurav', currency: '₹',
    riderName: 'Priya',
    items: [
      { name: 'Sourdough, seeded', qty: 2 },
      { name: 'Cardamom bun', qty: 4 }
    ],
    reorderUrl: 'https://crumb-and-ember.example/?reorder=CE-1042'
  }
};

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await queue.ping();
    res.json({ ready: true, service: SERVICE_NAME, storage: queue.mode });
  } catch (err) {
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: queue.mode });
  }
});

// --- Email and SMS fan-out ------------------------------------------------
// These endpoints no longer deliver inline — they persist the job and return
// 202 immediately. notification-worker replicas claim and dispatch it, which
// is what makes the 202 honest: a job survives a crash here, and a slow
// provider can no longer stall the caller's request thread.
async function enqueueHandler(channel, req, res, next) {
  try {
    const { to, subject, body, maxAttempts, template, data } = req.body || {};
    if (!to) return res.status(400).json({ error: 'recipient (to) is required' });
    // Reject an unknown template at enqueue time. Catching it here gives the
    // caller a 400 they can act on, instead of a job that queues cleanly and
    // then dead-letters somewhere they are not looking.
    if (template && !templateNames.includes(template)) {
      return res.status(400).json({ error: `unknown template: ${template}`, available: templateNames });
    }

    const job = await queue.enqueue({
      channel,
      recipient: String(to),
      subject: subject ? String(subject) : null,
      body: body ? String(body) : '',
      traceId: req.traceId,
      maxAttempts: Number.isInteger(maxAttempts) ? maxAttempts : undefined,
      template: template || undefined,
      payload: data || undefined
    });

    req.log.info({
      event: 'notification_enqueued', jobId: job.id, channel, to, template: template || undefined,
      subject: channel === 'email' ? (subject || '(no subject)') : undefined
    }, 'notification queued for delivery');

    res.status(202).json({
      status: 'queued', channel, to, jobId: job.id, traceId: req.traceId
    });
  } catch (err) { next(err); }
}

app.post('/notify/email', (req, res, next) => enqueueHandler('email', req, res, next));
app.post('/notify/sms', (req, res, next) => enqueueHandler('sms', req, res, next));
app.post('/notify/push', (req, res, next) => enqueueHandler('push', req, res, next));

// Delivery is asynchronous now, so callers (and on-call) need a way to see
// where a given notification got to.
// Render a template to HTML without sending anything — for designers
// iterating on the mail and for a quick eyeball after a copy change.
app.get('/notify/templates', (req, res) => res.json({ templates: templateNames }));
app.get('/notify/templates/:name/preview', (req, res, next) => {
  try {
    const sample = SAMPLES[req.params.name];
    if (!sample) return res.status(404).json({ error: 'Unknown template', available: templateNames });
    const out = render(req.params.name, sample);
    if (req.query.format === 'text') return res.type('text/plain').send(out.text);
    res.type('html').send(out.html);
  } catch (err) { next(err); }
});

app.get('/notify/jobs/:id', async (req, res, next) => {
  try {
    const job = await queue.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Notification job not found' });
    res.json(job);
  } catch (err) { next(err); }
});

// Queue depth by status — a cheap signal for whether the workers are keeping
// up, and what to alert on (rising `queued`, any `dead`).
app.get('/notify/queue/stats', async (req, res, next) => {
  try {
    const counts = await queue.stats();
    res.json({ service: SERVICE_NAME, storage: queue.mode, counts });
  } catch (err) { next(err); }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error', traceId: req.traceId });
});

function start() {
  const server = app.listen(PORT, () => {
    logger.info({ event: 'service_started', port: PORT, storage: queue.mode }, `${SERVICE_NAME} listening`);
    queue.init().catch((err) =>
      logger.warn({ event: 'migration_deferred', message: err.message }, 'notification_jobs migration will run when the database is up'));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
      server.close(async () => { if (pool) await pool.end().catch(() => {}); process.exit(0); });
    });
  }
  return server;
}

if (require.main === module) start();

module.exports = { app, queue };


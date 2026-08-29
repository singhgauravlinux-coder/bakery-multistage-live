'use strict';
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Pool } = require('pg');
const { clientInfo } = require('./lib/client-info');
const { createAuditLogger } = require('./lib/audit');

const SERVICE_NAME = process.env.SERVICE_NAME || 'invoice-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3007';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 5 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));

// Self-migrating (idempotent) — mirrored in db/migrations/0006_invoices.sql.
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS invoices (
    id          TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL,
    amount      NUMERIC(10,2) NOT NULL,
    currency    TEXT NOT NULL DEFAULT 'EUR',
    customer    TEXT NOT NULL DEFAULT 'walk-in',
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_in_days INTEGER NOT NULL DEFAULT 14
  );
  CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices (order_id);
`;

const ROW = `id, order_id AS "orderId", amount, currency, customer, issued_at AS "issuedAt", due_in_days AS "dueInDays"`;

const memoryInvoices = new Map();

const store = pool ? {
  mode: 'postgres',
  async init() { await pool.query(MIGRATION); },
  async create(inv) {
    const { rows } = await pool.query(
      `INSERT INTO invoices (id, order_id, amount, currency, customer)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${ROW}`,
      [inv.id, inv.orderId, inv.amount, inv.currency, inv.customer]);
    return rows[0];
  },
  async get(id) {
    const { rows } = await pool.query(`SELECT ${ROW} FROM invoices WHERE id = $1`, [id]);
    return rows[0] || null;
  },
  async byOrder(orderId) {
    const { rows } = await pool.query(`SELECT ${ROW} FROM invoices WHERE order_id = $1`, [orderId]);
    return rows[0] || null;
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async init() {},
  async create(inv) {
    const record = { ...inv, issuedAt: new Date().toISOString(), dueInDays: 14 };
    memoryInvoices.set(inv.id, record);
    return record;
  },
  async get(id) { return memoryInvoices.get(id) || null; },
  async byOrder(orderId) {
    for (const inv of memoryInvoices.values()) if (inv.orderId === orderId) return inv;
    return null;
  },
  async ping() {}
};

const audit = createAuditLogger({ pool, logger, service: SERVICE_NAME });

// Resolve an order from the order service so the invoice amount can be
// derived server-side when the client doesn't provide one.
async function fetchOrder(orderId, log, traceId) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${ORDER_SERVICE_URL}/orders/${encodeURIComponent(orderId)}`, {
      signal: ctrl.signal,
      headers: traceId ? { 'x-trace-id': traceId } : {}
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    log.warn({ event: 'order_lookup_failed', orderId, message: err.message }, 'order service unreachable');
    return null;
  }
}

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
    const info = clientInfo(req);
    return {
      traceId: req.traceId,
      requestId: info.requestId,
      requestUri: info.endpoint,
      method: req.method,
      query: Object.keys(req.query || {}).length ? req.query : undefined,
      contentLength: req.headers['content-length'] ? Number(req.headers['content-length']) : undefined,
      clientIp: info.ip,
      browser: info.browser,
      os: info.os,
      device: info.device,
      userAgent: info.userAgent ? info.userAgent.slice(0, 256) : undefined
    };
  }
}));

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

// --- Invoices ------------------------------------------------------------
// Root cause of the historical `POST /invoices` 400: the checkout UI sent
// only { orderId } while this endpoint required { orderId, amount }. The
// endpoint now resolves the amount (and payment state) from the order
// service when the caller omits it, and returns precise field-level errors.
app.post('/invoices', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { orderId, amount, currency, customer } = req.body || {};
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required', details: { orderId: 'missing' } });
    }

    const existing = await store.byOrder(String(orderId));
    if (existing) return res.status(200).json(existing); // idempotent per order

    let resolvedAmount = amount === undefined || amount === null ? null : Number(amount);
    let resolvedCurrency = currency || null;
    const order = await fetchOrder(orderId, req.log, req.traceId);
    if (order) {
      // Never invoice an order that hasn't been paid (COD invoices carry
      // the amount due on delivery).
      const payable = order.paymentStatus === 'paid' || order.paymentStatus === 'cod_pending' || order.paymentStatus === undefined;
      if (!payable) {
        audit.record({ ...info, action: 'invoice', success: false, statusCode: 409, failureReason: 'order_not_paid', metadata: { orderId } });
        return res.status(409).json({ error: 'Order has not been paid yet — invoice refused', paymentStatus: order.paymentStatus });
      }
      if (resolvedAmount === null && order.amount !== null && order.amount !== undefined) resolvedAmount = Number(order.amount);
      if (!resolvedCurrency && order.currency) resolvedCurrency = order.currency;
    }
    if (resolvedAmount === null || !Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      audit.record({ ...info, action: 'invoice', success: false, statusCode: 422, failureReason: 'amount_unresolvable', metadata: { orderId } });
      return res.status(422).json({
        error: 'amount could not be determined — provide a positive amount or reference an order with a stored total',
        details: { amount: 'missing_or_invalid' }
      });
    }

    const invoice = await store.create({
      id: 'inv-' + crypto.randomBytes(5).toString('hex'),
      orderId: String(orderId),
      amount: Number(resolvedAmount.toFixed(2)),
      currency: resolvedCurrency || 'EUR',
      customer: customer || (order && order.userId) || 'walk-in'
    });
    req.log.info({
      event: 'invoice_issued', invoiceId: invoice.id, orderId, amount: invoice.amount,
      ip: info.ip, requestId: info.requestId, browser: info.browser, device: info.device
    }, 'invoice created');
    audit.record({ ...info, action: 'invoice', success: true, statusCode: 201, metadata: { invoiceId: invoice.id, orderId, amount: invoice.amount } });
    res.status(201).json(invoice);
  } catch (err) { next(err); }
});

app.get('/invoices/:id', async (req, res, next) => {
  try {
    const invoice = await store.get(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json(invoice);
  } catch (err) { next(err); }
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars -- Express error signature
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error', traceId: req.traceId });
});

function start() {
  const server = app.listen(PORT, () => {
    logger.info({ event: 'service_started', port: PORT, storage: store.mode }, `${SERVICE_NAME} listening`);
    store.init().catch((err) =>
      logger.warn({ event: 'migration_deferred', message: err.message }, 'invoices migration will run when the database is up'));
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

module.exports = { app, store };


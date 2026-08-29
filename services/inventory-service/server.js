'use strict';
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'inventory-service';
const PORT = Number(process.env.PORT || 3000);

// All logs are structured JSON on stdout (12-factor), ready for
// Fluent Bit / Loki / ELK collection from the container runtime.
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) }
});

const app = express();
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

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', (req, res) => res.json({ ready: true, service: SERVICE_NAME }));

// --- Stock levels per product per day ---
const stock = { 'p-1': 24, 'p-2': 18, 'p-3': 60, 'p-4': 40, 'p-5': 48, 'p-6': 30, 'p-7': 26, 'p-8': 12, 'p-9': 36, 'p-10': 80, 'p-11': 20, 'p-12': 10 };

app.get('/stock', (req, res) => res.json(stock));

app.get('/stock/:productId', (req, res) => {
  const qty = stock[req.params.productId];
  if (qty === undefined) return res.status(404).json({ error: 'Unknown product' });
  res.json({ productId: req.params.productId, quantity: qty, status: qty === 0 ? 'sold_out' : qty < 10 ? 'low' : 'in_stock' });
});

app.post('/stock/adjust', (req, res) => {
  const { productId, delta } = req.body || {};
  if (stock[productId] === undefined) return res.status(404).json({ error: 'Unknown product' });
  stock[productId] = Math.max(0, stock[productId] + Number(delta || 0));
  req.log.info({ event: 'stock_adjusted', productId, delta, newQuantity: stock[productId] }, 'stock level changed');
  res.json({ productId, quantity: stock[productId] });
});

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error', traceId: req.traceId });
});

const server = app.listen(PORT, () => logger.info({ event: 'service_started', port: PORT }, `${SERVICE_NAME} listening`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    logger.info({ event: 'shutdown', signal }, 'shutting down gracefully');
    server.close(() => process.exit(0));
  });
}


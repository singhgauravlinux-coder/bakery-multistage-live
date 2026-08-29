'use strict';
const crypto = require('crypto');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');

const SERVICE_NAME = process.env.SERVICE_NAME || 'delivery-service';
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

// --- Bike delivery and pickup slots ---
const deliveries = new Map();
// Kept separate from `deliveries` so a scheduled Node Timeout object never
// ends up spread into a JSON response.
const pickupTimers = new Map();    // orderId -> Timeout, fires the "rider-picked-up" notification
const deliveredTimers = new Map(); // orderId -> Timeout, fires the "order-delivered" notification

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://order-service:3007';
const PRODUCT_CATALOG_SERVICE_URL = process.env.PRODUCT_CATALOG_SERVICE_URL || 'http://product-catalog-service:3003';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:3010';
const PICKUP_NOTIFICATIONS_ENABLED = (process.env.PICKUP_NOTIFICATIONS_ENABLED || 'true') === 'true';
const DELIVERED_NOTIFICATIONS_ENABLED = (process.env.DELIVERED_NOTIFICATIONS_ENABLED || 'true') === 'true';
const SMS_NOTIFICATIONS_ENABLED = (process.env.SMS_NOTIFICATIONS_ENABLED || 'true') === 'true';
const PUSH_NOTIFICATIONS_ENABLED = (process.env.PUSH_NOTIFICATIONS_ENABLED || 'true') === 'true';
const RIDER_NAMES = ['Priya', 'Marcus', 'Ana', 'Leo', 'Sara', 'Dev', 'Noor', 'Tom'];

// --- Live tracking --------------------------------------------------------
// Deliveries are stateless on the server: rather than running a background
// job to mutate status, each read derives "where things are right now" from
// the scheduled/eta timestamps. That keeps horizontal scaling trivial (any
// pod can answer any GET) while still giving the storefront a live-feeling
// tracker as the client polls.
const SHOP_LOCATION = { lat: 51.5074, lng: -0.1278 }; // Crumb & Ember counter

const BIKE_STAGES = [
  { key: 'preparing', label: 'Baking & boxing your order', at: 0 },
  { key: 'rider_assigned', label: 'Rider assigned, heading to the shop', at: 0.2 },
  { key: 'out_for_delivery', label: 'Out for delivery', at: 0.4 },
  { key: 'delivered', label: 'Delivered', at: 1 }
];
const PICKUP_STAGES = [
  { key: 'preparing', label: 'Baking & boxing your order', at: 0 },
  { key: 'ready_for_pickup', label: 'Ready for pickup at the counter', at: 0.3 }
];
const BIKE_LEG_START = BIKE_STAGES.find((s) => s.key === 'out_for_delivery').at;

// Small deterministic hash so the same order+address always gets the same
// simulated drop-off point (no real geocoding dependency for this demo).
function hashToUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

function destinationFor(orderId, address) {
  const angle = hashToUnit(`${orderId}|${address}|angle`) * Math.PI * 2;
  const distanceKm = 0.6 + hashToUnit(`${orderId}|${address}|dist`) * 2.4; // 0.6-3km from the shop
  const dLat = (distanceKm / 111) * Math.sin(angle);
  const dLng = (distanceKm / (111 * Math.cos((SHOP_LOCATION.lat * Math.PI) / 180))) * Math.cos(angle);
  return { lat: Number((SHOP_LOCATION.lat + dLat).toFixed(6)), lng: Number((SHOP_LOCATION.lng + dLng).toFixed(6)) };
}

function lerp(a, b, t) { return a + (b - a) * t; }

function riderNameFor(orderId) {
  return RIDER_NAMES[Math.floor(hashToUnit(`${orderId}|rider`) * RIDER_NAMES.length)];
}

// Small best-effort JSON GET with a short timeout — a slow/unreachable
// upstream here should never hold up the delivery tracker itself.
async function fetchJSON(url, { timeoutMs = 3000, traceId } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: traceId ? { 'x-trace-id': traceId } : {} });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// order.items is [{ productId, quantity }] — resolve display names from the
// catalog so the email reads like a menu, not a database dump. Falls back to
// the raw productId per-item if the catalog can't be reached in time.
async function resolveOrderItems(order, traceId) {
  const items = Array.isArray(order.items) ? order.items : [];
  return Promise.all(items.map(async (it) => {
    const product = await fetchJSON(`${PRODUCT_CATALOG_SERVICE_URL}/products/${encodeURIComponent(it.productId)}`, { traceId });
    return { name: (product && product.name) || it.productId, qty: it.quantity };
  }));
}

// Fires once, the moment a bike delivery's live status flips to
// "out_for_delivery" — i.e. the rider has the order in hand. Best-effort
// end to end: an unreachable order/catalog/notification service just means
// a skipped notification, never a failed delivery.
async function sendChannelNotification(channel, to, template, data, log, traceId) {
  if (!to) return;
  let res;
  try {
    res = await fetch(`${NOTIFICATION_SERVICE_URL}/notify/${channel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(traceId ? { 'x-trace-id': traceId } : {}) },
      body: JSON.stringify({ to, template, data })
    });
  } catch (err) {
    log.warn({ event: `${channel}_notification_failed`, orderId: data.orderId, template, message: err.message },
      `${channel} notification: notification-service unreachable`);
    return;
  }
  if (res.ok) {
    log.info({ event: `${channel}_notification_sent`, orderId: data.orderId, template }, `${channel} notification queued`);
  } else {
    log.warn({ event: `${channel}_notification_rejected`, orderId: data.orderId, template, status: res.status },
      `notification service rejected the ${channel} request`);
  }
}

// Shared by both the pickup and delivered notifications — resolves order +
// item details once, then fans the same event out across every enabled
// channel. Email always uses the order's account email; SMS only fires if
// the shopper gave a phone number at checkout.
async function notifyOrderEvent(template, delivery, log, traceId) {
  const order = await fetchJSON(`${ORDER_SERVICE_URL}/orders/${encodeURIComponent(delivery.orderId)}`, { traceId });
  if (!order || !order.userId) {
    log.warn({ event: 'notification_skipped', orderId: delivery.orderId, template, reason: 'order not found' }, 'skipping notification');
    return;
  }
  const items = await resolveOrderItems(order, traceId);
  const riderName = riderNameFor(delivery.orderId);
  const data = {
    orderId: delivery.orderId,
    currency: order.currency,
    riderName,
    items,
    address: delivery.address
  };
  if (template === 'rider-picked-up') {
    data.etaMinutes = Math.max(1, Math.round((Date.parse(delivery.eta) - Date.now()) / 60000));
  }

  const jobs = [sendChannelNotification('email', order.userId, template, data, log, traceId)];
  if (SMS_NOTIFICATIONS_ENABLED && order.phone) {
    jobs.push(sendChannelNotification('sms', order.phone, template, data, log, traceId));
  }
  if (PUSH_NOTIFICATIONS_ENABLED) {
    // No push-subscription store exists yet, so the account id stands in
    // for a device token. Swap this for a stored subscription id once
    // account-level push opt-in exists — the call shape won't change.
    jobs.push(sendChannelNotification('push', order.userId, template, data, log, traceId));
  }
  await Promise.all(jobs);
}

function computeLiveState(delivery) {
  const stages = delivery.mode === 'bike' ? BIKE_STAGES : PICKUP_STAGES;
  const scheduledAtMs = Date.parse(delivery.scheduledAt);
  const etaMs = Date.parse(delivery.eta);
  const totalMs = Math.max(etaMs - scheduledAtMs, 1);
  const fraction = Math.max(0, (Date.now() - scheduledAtMs) / totalMs);
  const clamped = Math.min(fraction, 1);

  const current = stages.reduce((acc, s) => (fraction >= s.at ? s : acc), stages[0]);
  const history = stages
    .filter((s) => fraction >= s.at)
    .map((s) => ({ status: s.key, label: s.label, at: new Date(scheduledAtMs + s.at * totalMs).toISOString() }));

  const live = {
    status: current.key,
    statusLabel: current.label,
    progressPercent: Math.round(clamped * 100),
    etaSecondsRemaining: Math.max(0, Math.round((etaMs - Date.now()) / 1000)),
    history
  };

  if (delivery.mode === 'bike') {
    const legT = Math.max(0, Math.min(1, (clamped - BIKE_LEG_START) / (1 - BIKE_LEG_START)));
    live.origin = SHOP_LOCATION;
    live.destination = delivery.destination;
    live.position = fraction < BIKE_LEG_START
      ? SHOP_LOCATION
      : { lat: Number(lerp(SHOP_LOCATION.lat, delivery.destination.lat, legT).toFixed(6)),
          lng: Number(lerp(SHOP_LOCATION.lng, delivery.destination.lng, legT).toFixed(6)) };
  }

  return live;
}

app.post('/deliveries', (req, res) => {
  const { orderId, address } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  const mode = address ? 'bike' : 'pickup';
  const scheduledAt = new Date();
  const etaMinutes = mode === 'bike'
    ? Number(process.env.BIKE_ETA_MINUTES || 45)
    : Number(process.env.PICKUP_ETA_MINUTES || 20);
  const delivery = {
    orderId,
    address: address || 'pickup at counter',
    mode,
    scheduledAt: scheduledAt.toISOString(),
    eta: new Date(scheduledAt.getTime() + etaMinutes * 60000).toISOString(),
    destination: mode === 'bike' ? destinationFor(orderId, address) : undefined
  };
  deliveries.set(orderId, delivery);
  req.log.info({ event: 'delivery_scheduled', orderId, mode: delivery.mode }, 'delivery scheduled');

  // Two notification moments for a bike order, both scheduled for the exact
  // instant the live tracker's own status calculation would report them:
  // pickup when the out_for_delivery leg begins, delivered at the full eta.
  if (mode === 'bike') {
    const existingPickup = pickupTimers.get(orderId);
    if (existingPickup) clearTimeout(existingPickup);
    const existingDelivered = deliveredTimers.get(orderId);
    if (existingDelivered) clearTimeout(existingDelivered);

    if (PICKUP_NOTIFICATIONS_ENABLED) {
      const pickupDelayMs = Math.max(0, BIKE_LEG_START * etaMinutes * 60000);
      const timer = setTimeout(() => {
        pickupTimers.delete(orderId);
        notifyOrderEvent('rider-picked-up', delivery, req.log, req.traceId).catch((err) =>
          req.log.warn({ event: 'pickup_notification_error', orderId, message: err.message }, 'pickup notification failed'));
      }, pickupDelayMs);
      timer.unref(); // a pending notification should never block graceful shutdown
      pickupTimers.set(orderId, timer);
    }

    if (DELIVERED_NOTIFICATIONS_ENABLED) {
      const deliveredDelayMs = Math.max(0, etaMinutes * 60000);
      const timer = setTimeout(() => {
        deliveredTimers.delete(orderId);
        notifyOrderEvent('order-delivered', delivery, req.log, req.traceId).catch((err) =>
          req.log.warn({ event: 'delivered_notification_error', orderId, message: err.message }, 'delivered notification failed'));
      }, deliveredDelayMs);
      timer.unref();
      deliveredTimers.set(orderId, timer);
    }
  }

  res.status(201).json({ ...delivery, ...computeLiveState(delivery) });
});

app.get('/deliveries/:orderId', (req, res) => {
  const delivery = deliveries.get(req.params.orderId);
  if (!delivery) return res.status(404).json({ error: 'No delivery for that order' });
  res.json({ ...delivery, ...computeLiveState(delivery) });
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
    for (const timer of pickupTimers.values()) clearTimeout(timer);
    for (const timer of deliveredTimers.values()) clearTimeout(timer);
    server.close(() => process.exit(0));
  });
}


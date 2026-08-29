'use strict';
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { clientInfo } = require('./lib/client-info');
const { createAuditLogger } = require('./lib/audit');
const { createSecurePayload } = require('./lib/secure-payload');

const SERVICE_NAME = process.env.SERVICE_NAME || 'auth-service';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'dev-only-secret-change-me';

// --- Session lifetime knobs ---------------------------------------------
// The access token is now deliberately SHORT lived; the browser silently
// renews it with a long-lived, single-use refresh token (POST /auth/refresh).
// Two independent timeouts bound how long a session can survive:
//   * idle   — max gap between two refreshes before the session dies
//   * absolute — hard ceiling from login, regardless of activity
// All four are env-tunable so dev/uat/prod can pick their own policy.
const ACCESS_TOKEN_TTL_MS = Number(
  process.env.AUTH_ACCESS_TOKEN_TTL_MS || process.env.AUTH_TOKEN_TTL_MS || 15 * 60 * 1000);
const REFRESH_TOKEN_TTL_MS = Number(process.env.AUTH_REFRESH_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const SESSION_IDLE_TIMEOUT_MS = Number(process.env.AUTH_SESSION_IDLE_TIMEOUT_MS || 30 * 60 * 1000);
const SESSION_ABSOLUTE_TTL_MS = Number(process.env.AUTH_SESSION_ABSOLUTE_TTL_MS || 12 * 60 * 60 * 1000);
// Kept as an alias so existing call sites / logs stay readable.
const TOKEN_TTL_MS = ACCESS_TOKEN_TTL_MS;
const SESSION_SWEEP_INTERVAL_MS = Number(process.env.AUTH_SESSION_SWEEP_INTERVAL_MS || 10 * 60 * 1000);

const RESET_TOKEN_TTL_MS = Number(process.env.AUTH_RESET_TOKEN_TTL_MS || 15 * 60 * 1000);
const CHANGE_TOKEN_TTL_MS = Number(process.env.AUTH_CHANGE_TOKEN_TTL_MS || 10 * 60 * 1000);
const UNLOCK_TOKEN_TTL_MS = Number(process.env.AUTH_UNLOCK_TOKEN_TTL_MS || 30 * 60 * 1000);
const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS || 5);
const NOTIFY_URL = process.env.NOTIFY_SERVICE_URL || 'http://notification-service:3010';
// Public origin of the storefront, used to build the link inside the
// verification email (e.g. https://dev.bakery.local). Relative by default so
// the demo keeps working without extra configuration.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
// How often the browser should re-check verification status. Sent to the
// client so the polling cadence is server-controlled, not hard-coded in HTML.
const VERIFY_POLL_INTERVAL_MS = Number(process.env.AUTH_VERIFY_POLL_INTERVAL_MS || 5000);
// The demo stack has no real mail transport (notification-service is a mock
// dispatcher), so security tokens/OTPs are additionally returned in API
// responses to keep the UI flows usable. MUST be "false" in production.
const RETURN_DEBUG_TOKENS = (process.env.AUTH_RETURN_DEBUG_TOKENS || 'true') === 'true';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: SERVICE_NAME, version: process.env.SERVICE_VERSION || '1.0.0' },
  formatters: { level: (label) => ({ level: label }) },
  redact: ['req.headers.authorization']
});

if (TOKEN_SECRET === 'dev-only-secret-change-me')
  logger.warn({ event: 'insecure_config' }, 'AUTH_TOKEN_SECRET is not set — using an insecure default');

// --- Password hashing (scrypt, no native deps) --------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
function verifyPassword(password, stored) {
  try {
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// --- Stateless JWTs (RFC 7519, HS256), scoped by purpose -----------------
// Tokens are now standards-compliant JSON Web Tokens so they can be
// inspected on jwt.io and verified by any JWT library. One signer/verifier
// pair covers session, forgot-password reset, change-password (OTP-bound)
// and email-verification tokens; the `purpose` claim prevents a token
// issued for one flow being replayed in another.
const JWT_ISSUER = process.env.AUTH_JWT_ISSUER || 'crumb-and-ember-auth';
const JWT_HEADER_B64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const jwtSign = (input) => crypto.createHmac('sha256', TOKEN_SECRET).update(input).digest('base64url');

function signScopedToken(userId, purpose, ttlMs, extra) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: JWT_ISSUER, sub: userId, purpose,
    iat: now, exp: now + Math.ceil(ttlMs / 1000),
    jti: crypto.randomUUID(), ...(extra || {})
  };
  const body = `${JWT_HEADER_B64}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${jwtSign(body)}`;
}
function verifyScopedToken(token, purpose) {
  try {
    const parts = String(token).split('.');
    if (parts.length === 2) return verifyLegacyToken(parts, purpose); // pre-JWT sessions
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sig] = parts;
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
    if (header.alg !== 'HS256') return null; // never accept alg:none / downgrade
    const expected = Buffer.from(jwtSign(`${headerB64}.${payloadB64}`));
    const given = Buffer.from(sig);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!data.sub || Math.floor(Date.now() / 1000) > data.exp) return null;
    if ((data.purpose || 'session') !== purpose) return null;
    return data;
  } catch { return null; }
}
// Tokens minted before the JWT migration were `payload.sig` (2 parts, ms
// expiry). Accept them until they age out so existing logins keep working.
function verifyLegacyToken([payload, sig], purpose) {
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!data.sub || Date.now() > data.exp) return null;
  if ((data.purpose || 'session') !== purpose) return null;
  return data;
}
// Access tokens now carry `sid` — the auth_sessions row they belong to —
// so a refresh/logout can revoke everything issued under that login.
const signToken = (userId, sessionId) =>
  signScopedToken(userId, 'session', ACCESS_TOKEN_TTL_MS, sessionId ? { sid: sessionId } : undefined);
const verifyToken = (token) => {
  const data = verifyScopedToken(token, 'session');
  return data ? data.sub : null;
};
const sessionClaims = (token) => verifyScopedToken(token, 'session');

// --- Refresh tokens ------------------------------------------------------
// Opaque, high-entropy and presented as `<sessionId>.<secret>`. Only the
// SHA-256 of the secret is stored, so a database leak cannot be replayed.
// The session id travels in the clear on purpose: when a rotated (already
// consumed) token is presented we can still find the family and kill it.
function mintRefreshToken(sessionId) {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { token: `${sessionId}.${secret}`, hash: sha256(secret) };
}
function splitRefreshToken(refreshToken) {
  const raw = String(refreshToken || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  return { sessionId: raw.slice(0, dot), hash: sha256(raw.slice(dot + 1)) };
}
// Everything the browser needs to run its own countdown without guessing.
function sessionEnvelope(session, accessToken, refreshToken) {
  const idleExpiresAt = new Date(new Date(session.lastUsedAt).getTime() + SESSION_IDLE_TIMEOUT_MS);
  return {
    token: accessToken,
    tokenType: 'Bearer',
    refreshToken,
    sessionId: session.id,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
    refreshExpiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
    absoluteTimeoutMs: SESSION_ABSOLUTE_TTL_MS,
    idleExpiresAt: idleExpiresAt.toISOString(),
    absoluteExpiresAt: new Date(session.absoluteExpiresAt).toISOString()
  };
}

// --- Storage: PostgreSQL when DATABASE_URL is set, in-memory otherwise ---
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 10 }) : null;
if (pool) pool.on('error', (err) => logger.error({ event: 'pg_pool_error', message: err.message }, 'postgres pool error'));
// Set once store.init() has actually applied the migration successfully.
// /ready stays 503 until this is true, so k8s never routes login traffic
// to a pod whose accounts/audit tables are missing the security columns.
let migrationReady = !pool;

// Self-migrating (idempotent): init.sql only runs on the FIRST postgres
// boot, so existing clusters would miss the security columns/tables.
// Mirrored by db/migrations/000{1,2,3}_*.sql for migration-tool users.
const MIGRATION = `
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS failed_login_attempts   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_failed_login_at    TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS locked_at               TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_hash       TEXT;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS unlock_token_expires_at TIMESTAMPTZ;
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified          BOOLEAN NOT NULL DEFAULT false;

  CREATE TABLE IF NOT EXISTS login_history (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT,
    email      TEXT,
    success    BOOLEAN NOT NULL,
    failure_reason TEXT,
    ip         TEXT,
    user_agent TEXT,
    browser    TEXT,
    os         TEXT,
    device     TEXT,
    request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_login_history_user    ON login_history (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_history_email   ON login_history (email, created_at DESC);

  CREATE TABLE IF NOT EXISTS security_audit_logs (
    id             BIGSERIAL PRIMARY KEY,
    service        TEXT NOT NULL,
    action         TEXT NOT NULL,
    user_id        TEXT,
    email          TEXT,
    ip             TEXT,
    user_agent     TEXT,
    browser        TEXT,
    os             TEXT,
    device         TEXT,
    endpoint       TEXT,
    method         TEXT,
    request_id     TEXT,
    status_code    INTEGER,
    success        BOOLEAN NOT NULL DEFAULT true,
    failure_reason TEXT,
    metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user    ON security_audit_logs (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_action  ON security_audit_logs (action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_request ON security_audit_logs (request_id);

  -- Refresh-token sessions. One row per login; the row is rotated in place
  -- on every /auth/refresh (new secret hash, bumped last_used_at) so a
  -- stolen-and-replayed refresh token is detectable. Mirrored by
  -- db/migrations/0009_auth_sessions.sql for migration-tool users.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    refresh_token_hash  TEXT NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    absolute_expires_at TIMESTAMPTZ NOT NULL,
    rotations           INTEGER NOT NULL DEFAULT 0,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT,
    ip                  TEXT,
    user_agent          TEXT,
    browser             TEXT,
    os                  TEXT,
    device              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions (user_id, revoked_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_hash ON auth_sessions (refresh_token_hash);
`;

const ACCOUNT_ROW = `email, user_id AS "userId", name, password_hash AS "passwordHash",
  failed_login_attempts AS "failedLoginAttempts", last_failed_login_at AS "lastFailedLoginAt",
  locked_at AS "lockedAt", unlock_token_expires_at AS "unlockTokenExpiresAt",
  email_verified AS "emailVerified"`;

const SESSION_ROW = `id, user_id AS "userId", refresh_token_hash AS "refreshTokenHash",
  issued_at AS "issuedAt", last_used_at AS "lastUsedAt", expires_at AS "expiresAt",
  absolute_expires_at AS "absoluteExpiresAt", rotations,
  revoked_at AS "revokedAt", revoked_reason AS "revokedReason"`;

const memoryAccounts = new Map();
const memoryLoginHistory = [];
const memorySessions = new Map();

function newMemoryAccount(email, name, passwordHash) {
  return {
    email, name, passwordHash,
    userId: 'u-' + (memoryAccounts.size + 1),
    failedLoginAttempts: 0, lastFailedLoginAt: null,
    lockedAt: null, unlockTokenHash: null, unlockTokenExpiresAt: null,
    emailVerified: false
  };
}

const store = pool ? {
  mode: 'postgres',
  async init() { await pool.query(MIGRATION); },
  async find(email) {
    const { rows } = await pool.query(`SELECT ${ACCOUNT_ROW} FROM accounts WHERE email = $1`, [email]);
    return rows[0] || null;
  },
  async findById(userId) {
    const { rows } = await pool.query(`SELECT ${ACCOUNT_ROW} FROM accounts WHERE user_id = $1`, [userId]);
    return rows[0] || null;
  },
  async create(email, name, passwordHash) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (email, user_id, name, password_hash)
       VALUES ($1, 'u-' || substr(md5(random()::text), 1, 8), $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING user_id AS "userId"`, [email, name, passwordHash]);
    return rows[0] || null;
  },
  async updatePassword(userId, passwordHash) {
    const { rowCount } = await pool.query(
      'UPDATE accounts SET password_hash = $1 WHERE user_id = $2', [passwordHash, userId]);
    return rowCount > 0;
  },
  async recordFailedLogin(email) {
    const { rows } = await pool.query(
      `UPDATE accounts
       SET failed_login_attempts = failed_login_attempts + 1, last_failed_login_at = now()
       WHERE email = $1
       RETURNING failed_login_attempts AS "failedLoginAttempts"`, [email]);
    return rows[0] ? rows[0].failedLoginAttempts : 0;
  },
  async lock(email, unlockTokenHash, expiresAt) {
    await pool.query(
      `UPDATE accounts SET locked_at = now(), unlock_token_hash = $2, unlock_token_expires_at = $3
       WHERE email = $1`, [email, unlockTokenHash, expiresAt]);
  },
  async resetLoginFailures(userId) {
    await pool.query(
      `UPDATE accounts SET failed_login_attempts = 0, last_failed_login_at = NULL,
         locked_at = NULL, unlock_token_hash = NULL, unlock_token_expires_at = NULL
       WHERE user_id = $1`, [userId]);
  },
  async unlockByTokenHash(tokenHash) {
    const { rows } = await pool.query(
      `UPDATE accounts SET failed_login_attempts = 0, last_failed_login_at = NULL,
         locked_at = NULL, unlock_token_hash = NULL, unlock_token_expires_at = NULL
       WHERE unlock_token_hash = $1 AND unlock_token_expires_at > now()
       RETURNING user_id AS "userId", email`, [tokenHash]);
    return rows[0] || null;
  },
  async setEmailVerified(userId) {
    const { rowCount } = await pool.query(
      'UPDATE accounts SET email_verified = true WHERE user_id = $1', [userId]);
    return rowCount > 0;
  },
  async addLoginHistory(h) {
    await pool.query(
      `INSERT INTO login_history (user_id, email, success, failure_reason, ip, user_agent, browser, os, device, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [h.userId || null, h.email || null, h.success, h.failureReason || null,
       h.ip, h.userAgent, h.browser, h.os, h.device, h.requestId]);
  },
  // ---- refresh-token sessions ----
  async createSession(s) {
    const { rows } = await pool.query(
      `INSERT INTO auth_sessions
         (id, user_id, refresh_token_hash, expires_at, absolute_expires_at, ip, user_agent, browser, os, device)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${SESSION_ROW}`,
      [s.id, s.userId, s.refreshTokenHash, s.expiresAt, s.absoluteExpiresAt,
       s.ip || null, s.userAgent || null, s.browser || null, s.os || null, s.device || null]);
    return rows[0];
  },
  async findSession(sessionId) {
    const { rows } = await pool.query(
      `SELECT ${SESSION_ROW} FROM auth_sessions WHERE id = $1`, [sessionId]);
    return rows[0] || null;
  },
  // Atomic rotate: only swaps the secret if the presented hash is still the
  // current one, so two parallel refreshes cannot both succeed.
  async rotateSession(sessionId, oldHash, newHash, expiresAt) {
    const { rows } = await pool.query(
      `UPDATE auth_sessions
          SET refresh_token_hash = $3, last_used_at = now(),
              expires_at = $4, rotations = rotations + 1
        WHERE id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL
        RETURNING ${SESSION_ROW}`, [sessionId, oldHash, newHash, expiresAt]);
    return rows[0] || null;
  },
  async revokeSession(sessionId, reason) {
    const { rowCount } = await pool.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason || 'logout']);
    return rowCount > 0;
  },
  async revokeUserSessions(userId, reason) {
    const { rowCount } = await pool.query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`, [userId, reason || 'logout_all']);
    return rowCount;
  },
  async purgeExpiredSessions() {
    const { rowCount } = await pool.query(
      `DELETE FROM auth_sessions
        WHERE absolute_expires_at < now() - interval '1 day'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '1 day')`);
    return rowCount;
  },
  async ping() { await pool.query('SELECT 1'); }
} : {
  mode: 'memory',
  async init() {},
  async find(email) { return memoryAccounts.get(email) || null; },
  async findById(userId) {
    for (const account of memoryAccounts.values()) if (account.userId === userId) return account;
    return null;
  },
  async create(email, name, passwordHash) {
    if (memoryAccounts.has(email)) return null;
    const account = newMemoryAccount(email, name, passwordHash);
    memoryAccounts.set(email, account);
    return { userId: account.userId };
  },
  async updatePassword(userId, passwordHash) {
    const account = await this.findById(userId);
    if (!account) return false;
    account.passwordHash = passwordHash;
    return true;
  },
  async recordFailedLogin(email) {
    const account = memoryAccounts.get(email);
    if (!account) return 0;
    account.failedLoginAttempts += 1;
    account.lastFailedLoginAt = new Date().toISOString();
    return account.failedLoginAttempts;
  },
  async lock(email, unlockTokenHash, expiresAt) {
    const account = memoryAccounts.get(email);
    if (!account) return;
    account.lockedAt = new Date().toISOString();
    account.unlockTokenHash = unlockTokenHash;
    account.unlockTokenExpiresAt = expiresAt;
  },
  async resetLoginFailures(userId) {
    const account = await this.findById(userId);
    if (!account) return;
    Object.assign(account, {
      failedLoginAttempts: 0, lastFailedLoginAt: null,
      lockedAt: null, unlockTokenHash: null, unlockTokenExpiresAt: null
    });
  },
  async unlockByTokenHash(tokenHash) {
    for (const account of memoryAccounts.values()) {
      const valid = account.unlockTokenHash === tokenHash &&
        account.unlockTokenExpiresAt && new Date(account.unlockTokenExpiresAt) > new Date();
      if (valid) {
        await this.resetLoginFailures(account.userId);
        return { userId: account.userId, email: account.email };
      }
    }
    return null;
  },
  async setEmailVerified(userId) {
    const account = await this.findById(userId);
    if (!account) return false;
    account.emailVerified = true;
    return true;
  },
  async addLoginHistory(h) {
    memoryLoginHistory.push({ ...h, createdAt: new Date().toISOString() });
    if (memoryLoginHistory.length > 1000) memoryLoginHistory.shift();
  },
  // ---- refresh-token sessions ----
  async createSession(s) {
    const row = {
      id: s.id, userId: s.userId, refreshTokenHash: s.refreshTokenHash,
      issuedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(),
      expiresAt: s.expiresAt, absoluteExpiresAt: s.absoluteExpiresAt,
      rotations: 0, revokedAt: null, revokedReason: null,
      ip: s.ip || null, userAgent: s.userAgent || null,
      browser: s.browser || null, os: s.os || null, device: s.device || null
    };
    memorySessions.set(s.id, row);
    return row;
  },
  async findSession(sessionId) { return memorySessions.get(sessionId) || null; },
  async rotateSession(sessionId, oldHash, newHash, expiresAt) {
    const row = memorySessions.get(sessionId);
    if (!row || row.revokedAt || row.refreshTokenHash !== oldHash) return null;
    row.refreshTokenHash = newHash;
    row.lastUsedAt = new Date().toISOString();
    row.expiresAt = expiresAt;
    row.rotations += 1;
    return row;
  },
  async revokeSession(sessionId, reason) {
    const row = memorySessions.get(sessionId);
    if (!row || row.revokedAt) return false;
    row.revokedAt = new Date().toISOString();
    row.revokedReason = reason || 'logout';
    return true;
  },
  async revokeUserSessions(userId, reason) {
    let n = 0;
    for (const row of memorySessions.values()) {
      if (row.userId === userId && !row.revokedAt) {
        row.revokedAt = new Date().toISOString();
        row.revokedReason = reason || 'logout_all';
        n += 1;
      }
    }
    return n;
  },
  async purgeExpiredSessions() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let n = 0;
    for (const [id, row] of memorySessions) {
      const dead = new Date(row.absoluteExpiresAt).getTime() < cutoff ||
        (row.revokedAt && new Date(row.revokedAt).getTime() < cutoff);
      if (dead) { memorySessions.delete(id); n += 1; }
    }
    return n;
  },
  async ping() {}
};

const audit = createAuditLogger({ pool, logger, service: SERVICE_NAME });

// --- Outbound e-mail via notification-service (mock dispatcher) ---------
// `template` + `data` select an HTML template in notification-service
// (lib/templates.js); `body` stays as the plain-text fallback for callers that
// have no template yet. Sending neither is what produced unstyled mail.
async function sendEmail(to, subject, body, log, traceId, { template, data } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${NOTIFY_URL}/notify/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(traceId ? { 'x-trace-id': traceId } : {}) },
      body: JSON.stringify({ to, subject, body, ...(template ? { template, data: data || {} } : {}) }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    log.info({ event: 'security_email_dispatched', to, subject, template, delivered: res.ok }, 'security email dispatched');
    return res.ok;
  } catch (err) {
    log.warn({ event: 'security_email_failed', to, subject, message: err.message },
      'notification-service unreachable — email content was logged only');
    return false;
  }
}

// Seed the demo account through the same hashing code path.
async function seedDemoAccount() {
  try {
    const email = 'amelie@crumbandember.dev';
    if (!(await store.find(email))) {
      await store.create(email, 'Amelie', hashPassword('baguette'));
      logger.info({ event: 'demo_account_seeded', email }, 'demo account ready');
    }
  } catch (err) {
    logger.warn({ event: 'seed_deferred', message: err.message }, 'demo seed will succeed once the database is up');
  }
}

const app = express();
// Traefik / Nginx / the API gateway sit in front of this service; trust
// their X-Forwarded-* headers so req.ip and rate-limit keys are correct.
app.set('trust proxy', true);
app.use(express.json());

// --- Encrypted request bodies (see lib/secure-payload.js) ----------------
// When a client sends { enc: {...} } we decrypt it back into req.body, so
// every route below works identically for plain and encrypted payloads —
// but credentials never appear in the browser Network tab or proxy logs.
const securePayload = createSecurePayload({ env: process.env });
logger.info({ event: 'payload_crypto_ready', keyId: securePayload.keyId, keySource: securePayload.keySource },
  'transport encryption keypair ready');
app.use((req, res, next) => {
  if (!req.body || !req.body.enc) return next();
  try {
    req.body = JSON.parse(securePayload.decryptEnvelope(req.body.enc));
    req.encryptedPayload = true;
    return next();
  } catch (err) {
    logger.warn({ event: 'envelope_decrypt_failed', message: err.message, path: req.path }, 'could not decrypt request payload');
    return res.status(400).json({
      error: 'Could not decrypt request payload',
      hint: 'Re-fetch GET /auth/crypto/public-key — the server key may have rotated — and retry.'
    });
  }
});

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

const bearerToken = (req) => (req.headers.authorization || '').replace('Bearer ', '');

// --- Kubernetes probes -------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));
app.get('/ready', async (req, res) => {
  try {
    await store.ping();
    if (!migrationReady) {
      return res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode, reason: 'migration_pending' });
    }
    res.json({ ready: true, service: SERVICE_NAME, storage: store.mode });
  } catch (err) {
    req.log.warn({ event: 'readiness_failed', message: err.message }, 'database unreachable');
    res.status(503).json({ ready: false, service: SERVICE_NAME, storage: store.mode });
  }
});

// --- Crypto endpoints ----------------------------------------------------
// Public key for the browser to encrypt request bodies with.
app.get('/auth/crypto/public-key', (req, res) => res.json(securePayload.publicKeyInfo()));

// Manual encryption API (requires a valid session token): encrypt/decrypt
// arbitrary data server-side with AES-256-GCM. Useful for storing secrets
// in third-party systems or sharing data that only this backend can read.
app.post('/auth/crypto/encrypt', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const { data } = req.body || {};
    if (data === undefined || data === null || data === '') return res.status(400).json({ error: 'data is required' });
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
    if (plaintext.length > 64 * 1024) return res.status(413).json({ error: 'data must be 64KB or less' });
    const ciphertext = securePayload.encryptData(plaintext);
    audit.record({ ...info, action: 'data_encrypt', userId, success: true, statusCode: 200, metadata: { bytes: plaintext.length } });
    res.json({ ciphertext, algorithm: 'AES-256-GCM' });
  } catch (err) { next(err); }
});

app.post('/auth/crypto/decrypt', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const { ciphertext } = req.body || {};
    if (!ciphertext) return res.status(400).json({ error: 'ciphertext is required' });
    let data;
    try { data = securePayload.decryptData(ciphertext); }
    catch {
      audit.record({ ...info, action: 'data_decrypt', userId, success: false, statusCode: 400, failureReason: 'invalid_ciphertext' });
      return res.status(400).json({ error: 'Ciphertext is invalid or was encrypted with a different key' });
    }
    audit.record({ ...info, action: 'data_decrypt', userId, success: true, statusCode: 200 });
    res.json({ data });
  } catch (err) { next(err); }
});

const isLocked = (account) => Boolean(account && account.lockedAt);

async function handleFailedLogin(req, res, info, email, account, reason) {
  let remainingAttempts = null;
  let failedAttempts = null;
  let locked = false;
  let lockedUnlockToken = null;
  if (account) {
    const attempts = await store.recordFailedLogin(email);
    failedAttempts = attempts;
    remainingAttempts = Math.max(MAX_FAILED_ATTEMPTS - attempts, 0);
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      locked = true;
      const unlockToken = crypto.randomBytes(32).toString('base64url');
      lockedUnlockToken = unlockToken;
      const expiresAt = new Date(Date.now() + UNLOCK_TOKEN_TTL_MS).toISOString();
      await store.lock(email, sha256(unlockToken), expiresAt);
      const unlockLink = `/api/auth/unlock?token=${unlockToken}`;
      await sendEmail(email, 'Your Crumb & Ember account is locked',
        `Too many failed sign-in attempts. Unlock your account within 30 minutes: ${unlockLink}`, req.log, req.traceId);
      req.log.warn({
        event: 'account_locked', email, userId: account.userId, ip: info.ip,
        requestId: info.requestId, browser: info.browser, os: info.os, device: info.device,
        failedAttempts: attempts, unlockTokenExpiresAt: expiresAt
      }, 'account locked after repeated failures — unlock email sent');
      audit.record({
        ...info, action: 'account_locked', userId: account.userId, email,
        success: false, statusCode: 423, failureReason: 'too_many_failed_attempts',
        metadata: { failedAttempts: attempts, unlockTokenExpiresAt: expiresAt }
      });
    }
  }
  await store.addLoginHistory({ ...info, userId: account ? account.userId : null, email, success: false, failureReason: reason });
  req.log.warn({
    event: 'login_failed', email, ip: info.ip, requestId: info.requestId,
    browser: info.browser, os: info.os, device: info.device,
    failureReason: reason, failedAttempts, remainingAttempts, locked
  }, 'invalid credentials');
  audit.record({
    ...info, action: 'login', userId: account ? account.userId : null, email,
    success: false, statusCode: locked ? 423 : 401, failureReason: reason,
    metadata: { failedAttempts, remainingAttempts, locked }
  });
  if (locked) {
    const lockedPayload = {
      error: 'Account locked after too many failed attempts. Check your email for an unlock link.',
      locked: true
    };
    if (RETURN_DEBUG_TOKENS) lockedPayload.unlockToken = lockedUnlockToken;
    return res.status(423).json(lockedPayload);
  }
  const payload = { error: 'Invalid email or password' };
  if (remainingAttempts !== null) payload.remainingAttempts = remainingAttempts;
  return res.status(401).json(payload);
}

// Create the auth_sessions row backing a login and mint its first refresh
// token. Both timeout deadlines are stamped here, at login time.
async function startSession(userId, info) {
  const id = crypto.randomUUID();
  const refresh = mintRefreshToken(id);
  const now = Date.now();
  const session = await store.createSession({
    id,
    userId,
    refreshTokenHash: refresh.hash,
    expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
    absoluteExpiresAt: new Date(now + SESSION_ABSOLUTE_TTL_MS).toISOString(),
    ip: info.ip, userAgent: info.userAgent, browser: info.browser, os: info.os, device: info.device
  });
  return { session, refreshToken: refresh.token };
}

// --- Login, registration and token verification ---
app.post('/auth/login', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { email, password } = req.body || {};
    const account = email ? await store.find(email) : null;

    if (isLocked(account)) {
      await store.addLoginHistory({ ...info, userId: account.userId, email, success: false, failureReason: 'account_locked' });
      req.log.warn({ event: 'login_blocked_locked', email, userId: account.userId, ip: info.ip, requestId: info.requestId }, 'login attempt on locked account');
      audit.record({ ...info, action: 'login', userId: account.userId, email, success: false, statusCode: 423, failureReason: 'account_locked' });
      return res.status(423).json({
        error: 'Account is locked. Use the unlock link emailed to you, or request a new one by waiting for the link to expire.',
        locked: true
      });
    }

    if (!account || !verifyPassword(password || '', account.passwordHash)) {
      return await handleFailedLogin(req, res, info, email, account, account ? 'invalid_password' : 'unknown_email');
    }

    await store.resetLoginFailures(account.userId);
    await store.addLoginHistory({ ...info, userId: account.userId, email, success: true });

    const { session, refreshToken } = await startSession(account.userId, info);
    const accessToken = signToken(account.userId, session.id);

    req.log.info({
      event: 'login_success', userId: account.userId, email, ip: info.ip,
      requestId: info.requestId, browser: info.browser, os: info.os, device: info.device,
      sessionId: session.id, accessTokenTtlMs: ACCESS_TOKEN_TTL_MS,
      idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS, absoluteTimeoutMs: SESSION_ABSOLUTE_TTL_MS
    }, 'user logged in');
    audit.record({
      ...info, action: 'login', userId: account.userId, email, success: true, statusCode: 200,
      metadata: { sessionId: session.id }
    });
    res.json({
      ...sessionEnvelope(session, accessToken, refreshToken),
      userId: account.userId,
      name: account.name,
      emailVerified: Boolean(account.emailVerified)
    });
  } catch (err) { next(err); }
});

// --- Refresh: swap a valid refresh token for a fresh access token --------
// Enforces BOTH timeouts on every call:
//   * idle     — too long since the last refresh -> session revoked
//   * absolute — too long since login            -> session revoked
// The refresh token itself is single-use: a successful call rotates it and
// the old value is dead. Presenting an already-rotated token is treated as
// theft and kills the whole session (OAuth 2.0 BCP reuse detection).
app.post('/auth/refresh', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const presented = (req.body && req.body.refreshToken) || '';
    const parts = splitRefreshToken(presented);
    if (!parts) {
      audit.record({ ...info, action: 'token_refresh', success: false, statusCode: 400, failureReason: 'malformed_refresh_token' });
      return res.status(400).json({ error: 'refreshToken is required', reason: 'malformed_refresh_token' });
    }

    const existing = await store.findSession(parts.sessionId);
    if (!existing) {
      audit.record({ ...info, action: 'token_refresh', success: false, statusCode: 401, failureReason: 'unknown_session' });
      return res.status(401).json({ error: 'Session not found — please sign in again', reason: 'unknown_session' });
    }
    if (existing.revokedAt) {
      audit.record({
        ...info, action: 'token_refresh', userId: existing.userId, success: false, statusCode: 401,
        failureReason: existing.revokedReason || 'session_revoked', metadata: { sessionId: existing.id }
      });
      return res.status(401).json({ error: 'Session has ended — please sign in again', reason: existing.revokedReason || 'session_revoked' });
    }

    const now = Date.now();
    const idleDeadline = new Date(existing.lastUsedAt).getTime() + SESSION_IDLE_TIMEOUT_MS;
    const expired =
      now > new Date(existing.expiresAt).getTime() ? 'refresh_token_expired' :
      now > new Date(existing.absoluteExpiresAt).getTime() ? 'session_absolute_timeout' :
      now > idleDeadline ? 'session_idle_timeout' : null;
    if (expired) {
      await store.revokeSession(existing.id, expired);
      req.log.info({ event: 'session_expired', userId: existing.userId, sessionId: existing.id, reason: expired }, 'session timed out');
      audit.record({
        ...info, action: 'session_timeout', userId: existing.userId, success: false, statusCode: 401,
        failureReason: expired, metadata: { sessionId: existing.id }
      });
      return res.status(401).json({ error: 'Your session has timed out — please sign in again', reason: expired });
    }

    const next$ = mintRefreshToken(existing.id);
    const rotated = await store.rotateSession(
      existing.id, parts.hash, next$.hash, new Date(now + REFRESH_TOKEN_TTL_MS).toISOString());

    if (!rotated) {
      // The session is live but the presented secret is stale => replay.
      await store.revokeSession(existing.id, 'refresh_token_reuse');
      req.log.warn({
        event: 'refresh_token_reuse', userId: existing.userId, sessionId: existing.id,
        ip: info.ip, requestId: info.requestId
      }, 'rotated refresh token replayed — session revoked');
      audit.record({
        ...info, action: 'refresh_token_reuse', userId: existing.userId, success: false, statusCode: 401,
        failureReason: 'refresh_token_reuse', metadata: { sessionId: existing.id }
      });
      return res.status(401).json({ error: 'Session ended for your security — please sign in again', reason: 'refresh_token_reuse' });
    }

    const account = await store.findById(rotated.userId);
    const accessToken = signToken(rotated.userId, rotated.id);
    audit.record({
      ...info, action: 'token_refresh', userId: rotated.userId, success: true, statusCode: 200,
      metadata: { sessionId: rotated.id, rotations: rotated.rotations }
    });
    res.json({
      ...sessionEnvelope(rotated, accessToken, next$.token),
      userId: rotated.userId,
      name: account ? account.name : undefined,
      emailVerified: Boolean(account && account.emailVerified)
    });
  } catch (err) { next(err); }
});

// --- Session status ------------------------------------------------------
// Cheap polling target for the browser: how long is left, and has the
// email been verified since the page was loaded? Lets the UI update itself
// instead of the user hitting reload.
app.get('/auth/session', async (req, res, next) => {
  try {
    const claims = sessionClaims(bearerToken(req));
    if (!claims) return res.status(401).json({ active: false, reason: 'invalid_or_expired_token' });
    const account = await store.findById(claims.sub);
    if (!account) return res.status(404).json({ active: false, reason: 'account_not_found' });

    const session = claims.sid ? await store.findSession(claims.sid) : null;
    if (session && session.revokedAt) {
      return res.status(401).json({ active: false, reason: session.revokedReason || 'session_revoked' });
    }
    res.json({
      active: true,
      userId: claims.sub,
      name: account.name,
      email: account.email,
      emailVerified: Boolean(account.emailVerified),
      sessionId: claims.sid || null,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      expiresIn: Math.max(claims.exp - Math.floor(Date.now() / 1000), 0),
      idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      absoluteTimeoutMs: SESSION_ABSOLUTE_TTL_MS,
      idleExpiresAt: session ? new Date(new Date(session.lastUsedAt).getTime() + SESSION_IDLE_TIMEOUT_MS).toISOString() : null,
      absoluteExpiresAt: session ? new Date(session.absoluteExpiresAt).toISOString() : null
    });
  } catch (err) { next(err); }
});

// Redeem an unlock token (from the "account locked" email).
app.post('/auth/unlock', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const token = (req.body && req.body.token) || req.query.token;
    if (!token) return res.status(400).json({ error: 'token is required' });
    const unlocked = await store.unlockByTokenHash(sha256(token));
    if (!unlocked) {
      audit.record({ ...info, action: 'account_unlock', success: false, statusCode: 401, failureReason: 'invalid_or_expired_token' });
      return res.status(401).json({ error: 'Unlock link is invalid or has expired' });
    }
    req.log.info({ event: 'account_unlocked', userId: unlocked.userId, ip: info.ip, requestId: info.requestId }, 'account unlocked');
    audit.record({ ...info, action: 'account_unlock', userId: unlocked.userId, email: unlocked.email, success: true, statusCode: 200 });
    res.json({ ok: true, message: 'Account unlocked — you can sign in again.' });
  } catch (err) { next(err); }
});

app.post('/auth/register', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const created = await store.create(email, name || email, hashPassword(password));
    if (!created) {
      audit.record({ ...info, action: 'registration', email, success: false, statusCode: 409, failureReason: 'email_already_registered' });
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    req.log.info({ event: 'user_registered', userId: created.userId, email, ip: info.ip, requestId: info.requestId }, 'new account created');
    audit.record({ ...info, action: 'registration', userId: created.userId, email, success: true, statusCode: 201 });
    res.status(201).json({ userId: created.userId });
  } catch (err) { next(err); }
});

// Logout now genuinely ends the session: the refresh token is revoked so it
// can never be exchanged again. The already-issued access token stays valid
// for its (short) remaining lifetime — that is the accepted trade-off of
// stateless JWTs, and why ACCESS_TOKEN_TTL_MS is minutes rather than a day.
// The session id is taken from the access token's `sid`, or from an
// explicitly supplied refreshToken when the access token has already gone.
app.post('/auth/logout', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const claims = sessionClaims(bearerToken(req));
    const supplied = splitRefreshToken((req.body && req.body.refreshToken) || '');
    const sessionId = (claims && claims.sid) || (supplied && supplied.sessionId) || null;

    if (!claims && !supplied) {
      audit.record({ ...info, action: 'logout', success: false, statusCode: 401, failureReason: 'invalid_token' });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    let revoked = false;
    if (sessionId) revoked = await store.revokeSession(sessionId, 'logout');

    const userId = claims ? claims.sub : null;
    req.log.info({ event: 'logout', userId, sessionId, revoked, ip: info.ip, requestId: info.requestId }, 'user logged out');
    audit.record({ ...info, action: 'logout', userId, success: true, statusCode: 200, metadata: { sessionId, revoked } });
    res.json({ ok: true, revoked });
  } catch (err) { next(err); }
});

// Sign out everywhere — revokes every live session for the account.
app.post('/auth/logout-all', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const revoked = await store.revokeUserSessions(userId, 'logout_all');
    req.log.info({ event: 'logout_all', userId, revoked, requestId: info.requestId }, 'all sessions revoked');
    audit.record({ ...info, action: 'logout_all', userId, success: true, statusCode: 200, metadata: { revoked } });
    res.json({ ok: true, revoked });
  } catch (err) { next(err); }
});

app.get('/auth/verify', (req, res) => {
  const claims = sessionClaims(bearerToken(req));
  if (!claims) return res.status(401).json({ valid: false });
  res.json({
    valid: true,
    userId: claims.sub,
    sessionId: claims.sid || null,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    expiresIn: Math.max(claims.exp - Math.floor(Date.now() / 1000), 0)
  });
});

// Step 1 of the forgot-password flow: issue a short-lived, purpose-scoped
// reset token for the account, if one exists. The response never reveals
// whether the email was registered, to avoid leaking account existence.
app.post('/auth/forgot-password', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });

    const account = await store.find(email);
    if (!account) {
      req.log.info({ event: 'password_reset_requested_unknown_email', ip: info.ip, requestId: info.requestId }, 'reset requested for unknown email');
      audit.record({ ...info, action: 'forgot_password', email, success: false, statusCode: 200, failureReason: 'unknown_email' });
      return res.json({ message: 'If that email exists, a reset link was sent.' });
    }

    const resetToken = signScopedToken(account.userId, 'reset', RESET_TOKEN_TTL_MS);
    await sendEmail(email, 'Reset your Crumb & Ember password',
      'Use this link within 15 minutes to reset your password.', req.log, req.traceId);
    req.log.info({ event: 'password_reset_requested', userId: account.userId, ip: info.ip, requestId: info.requestId }, 'reset link generated and emailed');
    audit.record({ ...info, action: 'forgot_password', userId: account.userId, email, success: true, statusCode: 200 });
    const payload = { message: 'If that email exists, a reset link was sent.' };
    if (RETURN_DEBUG_TOKENS) payload.resetToken = resetToken;
    res.json(payload);
  } catch (err) { next(err); }
});

// Step 2: redeem the reset token for a new password.
app.post('/auth/reset-password', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });

    const claims = verifyScopedToken(token, 'reset');
    if (!claims) {
      audit.record({ ...info, action: 'reset_password', success: false, statusCode: 401, failureReason: 'invalid_or_expired_token' });
      return res.status(401).json({ error: 'Reset link is invalid or has expired' });
    }

    const updated = await store.updatePassword(claims.sub, hashPassword(newPassword));
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    // A successful password reset also clears any lockout...
    await store.resetLoginFailures(claims.sub);
    // ...and invalidates every existing session, so a refresh token stolen
    // before the reset cannot outlive it.
    await store.revokeUserSessions(claims.sub, 'password_reset');

    req.log.info({ event: 'password_reset', userId: claims.sub, ip: info.ip, requestId: info.requestId }, 'password reset via forgot-password flow');
    audit.record({ ...info, action: 'reset_password', userId: claims.sub, success: true, statusCode: 200 });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- Change password (signed-in): OTP-verified, mirroring forgot-password.
// Step 1: request a change — a 6-digit OTP is emailed and a change token
// (binding the OTP hash) is issued. Reuses the same scoped-token machinery
// as the forgot-password flow.
app.post('/auth/password/request', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const changeToken = signScopedToken(userId, 'change', CHANGE_TOKEN_TTL_MS, { otpHash: sha256(otp) });
    await sendEmail(account.email, 'Your Crumb & Ember verification code',
      `Your password-change code is ${otp}. It expires in 10 minutes.`, req.log, req.traceId, {
        template: 'verification-code',
        data: {
          code: otp,
          purpose: 'password change',
          expiresMinutes: Math.round(CHANGE_TOKEN_TTL_MS / 60000),
          customerName: account.name
        }
      });
    req.log.info({ event: 'password_change_requested', userId, ip: info.ip, requestId: info.requestId }, 'change-password OTP emailed');
    audit.record({ ...info, action: 'change_password_request', userId, email: account.email, success: true, statusCode: 200 });
    const payload = { message: 'A verification code was emailed to you.', changeToken };
    if (RETURN_DEBUG_TOKENS) payload.devOtp = otp;
    res.json(payload);
  } catch (err) { next(err); }
});

// Step 2: confirm with the OTP and set the new password.
app.post('/auth/password', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });

    const { changeToken, otp, newPassword } = req.body || {};
    if (!changeToken || !otp || !newPassword) {
      return res.status(400).json({ error: 'changeToken, otp and newPassword are required — call POST /auth/password/request first' });
    }
    if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });

    const claims = verifyScopedToken(changeToken, 'change');
    const otpOk = claims && claims.sub === userId &&
      crypto.timingSafeEqual(Buffer.from(sha256(otp)), Buffer.from(String(claims.otpHash || '')));
    if (!otpOk) {
      req.log.warn({ event: 'password_update_failed', userId, ip: info.ip, requestId: info.requestId, failureReason: 'invalid_otp' }, 'OTP verification failed');
      audit.record({ ...info, action: 'change_password', userId, success: false, statusCode: 401, failureReason: 'invalid_or_expired_otp' });
      return res.status(401).json({ error: 'Verification code is invalid or has expired' });
    }

    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (verifyPassword(newPassword, account.passwordHash)) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    await store.updatePassword(userId, hashPassword(newPassword));
    // Changing the password ends every session, including this one — the
    // browser is expected to sign in again with the new credentials.
    await store.revokeUserSessions(userId, 'password_changed');
    req.log.info({ event: 'password_updated', userId, ip: info.ip, requestId: info.requestId }, 'password updated after OTP verification');
    audit.record({ ...info, action: 'change_password', userId, email: account.email, success: true, statusCode: 200 });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// --- Email verification --------------------------------------------------
// Polling target for the verification screen. The browser hits this every
// few seconds while the banner is showing, so clicking the link in a mail
// client (or another tab) updates the page by itself — no manual reload.
app.get('/auth/verify-email/status', async (req, res, next) => {
  try {
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({
      userId,
      email: account.email,
      emailVerified: Boolean(account.emailVerified),
      pollIntervalMs: VERIFY_POLL_INTERVAL_MS,
      checkedAt: new Date().toISOString()
    });
  } catch (err) { next(err); }
});

app.post('/auth/verify-email/request', async (req, res, next) => {
  try {
    const info = clientInfo(req);
    const userId = verifyToken(bearerToken(req));
    if (!userId) return res.status(401).json({ error: 'Invalid or expired token' });
    const account = await store.findById(userId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    if (account.emailVerified) return res.json({ ok: true, message: 'Email already verified.' });

    const verifyEmailToken = signScopedToken(userId, 'verify-email', RESET_TOKEN_TTL_MS);
    // Deep link back into the SPA: the page reads ?verify=<token> on load,
    // confirms it and updates the badge in place.
    const verifyLink = `${APP_BASE_URL}/?verify=${encodeURIComponent(verifyEmailToken)}`;
    await sendEmail(account.email, 'Verify your Crumb & Ember email',
      `Use this link within ${Math.round(RESET_TOKEN_TTL_MS / 60000)} minutes to verify your email address: ${verifyLink}`,
      req.log, req.traceId);
    audit.record({ ...info, action: 'email_verification_request', userId, email: account.email, success: true, statusCode: 200 });
    const payload = {
      message: 'A verification link was emailed to you.',
      pollIntervalMs: VERIFY_POLL_INTERVAL_MS,
      expiresInMs: RESET_TOKEN_TTL_MS
    };
    if (RETURN_DEBUG_TOKENS) {
      payload.verifyToken = verifyEmailToken;
      payload.verifyLink = verifyLink;
    }
    res.json(payload);
  } catch (err) { next(err); }
});

// Accepts the token in the body (SPA) or the query string (someone pasting
// the raw link straight at the API), so both entry points work.
async function confirmEmailVerification(req, res, next) {
  try {
    const info = clientInfo(req);
    const token = (req.body && req.body.token) || req.query.token;
    if (!token) return res.status(400).json({ error: 'token is required' });
    const claims = verifyScopedToken(token, 'verify-email');
    if (!claims) {
      audit.record({ ...info, action: 'email_verification', success: false, statusCode: 401, failureReason: 'invalid_or_expired_token' });
      return res.status(401).json({ error: 'Verification link is invalid or has expired' });
    }
    const updated = await store.setEmailVerified(claims.sub);
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    audit.record({ ...info, action: 'email_verification', userId: claims.sub, success: true, statusCode: 200 });
    res.json({ ok: true, emailVerified: true, userId: claims.sub });
  } catch (err) { next(err); }
}
app.post('/auth/verify-email/confirm', confirmEmailVerification);
app.get('/auth/verify-email/confirm', confirmEmailVerification);

// --- 404 + error handling ----------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars -- Express error signature
  req.log.error({ event: 'unhandled_error', message: err.message }, 'request failed');
  res.status(500).json({ error: 'Internal server error', traceId: req.traceId });
});

async function runMigrationWithRetry(attempt = 1) {
  try {
    await store.init();
    await seedDemoAccount();
    migrationReady = true;
    logger.info({ event: 'migration_complete', attempt }, 'security migration applied');
  } catch (err) {
    const delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
    logger.warn({ event: 'migration_deferred', attempt, delayMs, message: err.message },
      'security migration failed; retrying');
    setTimeout(() => runMigrationWithRetry(attempt + 1), delayMs);
  }
}

// Housekeeping: drop long-dead session rows so auth_sessions stays small.
// Deliberately lazy (interval, unref'd) — correctness never depends on it,
// because every read path re-checks revoked_at and both deadlines.
function startSessionSweeper() {
  const timer = setInterval(() => {
    store.purgeExpiredSessions()
      .then((n) => { if (n) logger.info({ event: 'sessions_purged', purged: n }, 'expired sessions cleaned up'); })
      .catch((err) => logger.warn({ event: 'session_purge_failed', message: err.message }, 'session sweep failed'));
  }, SESSION_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

function start() {
  const server = app.listen(PORT, () => {
    logger.info({
      event: 'service_started', port: PORT, storage: store.mode,
      accessTokenTtlMs: ACCESS_TOKEN_TTL_MS,
      refreshTokenTtlMs: REFRESH_TOKEN_TTL_MS,
      sessionIdleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      sessionAbsoluteTtlMs: SESSION_ABSOLUTE_TTL_MS
    }, `${SERVICE_NAME} listening`);
    runMigrationWithRetry();
    startSessionSweeper();
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

module.exports = {
  app, store, audit, securePayload,
  signScopedToken, verifyScopedToken, hashPassword, verifyPassword,
  MAX_FAILED_ATTEMPTS,
  ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS,
  SESSION_IDLE_TIMEOUT_MS, SESSION_ABSOLUTE_TTL_MS
};


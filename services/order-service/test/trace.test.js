'use strict';
process.env.LOG_LEVEL = 'silent';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let base;
before(async () => {
  const { app } = require('../server');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

test('a trace id is minted when the caller sends none', async () => {
  const res = await fetch(base + '/health');
  const traceId = res.headers.get('x-trace-id');
  assert.ok(traceId, 'X-Trace-Id header must be set');
  assert.match(traceId, /^trace-[0-9a-f-]{36}$/);
});

test('a caller-supplied X-Trace-Id is echoed back unchanged', async () => {
  const res = await fetch(base + '/health', { headers: { 'x-trace-id': 'web-abc-123' } });
  assert.equal(res.headers.get('x-trace-id'), 'web-abc-123');
});

test('X-Request-Id is accepted as a trace id fallback', async () => {
  const res = await fetch(base + '/health', { headers: { 'x-request-id': 'req-42' } });
  assert.equal(res.headers.get('x-trace-id'), 'req-42');
});

test('unsafe characters are stripped and length is capped', async () => {
  const res = await fetch(base + '/health', {
    headers: { 'x-trace-id': 'ok<>"\'`{}|\\^ok' + 'x'.repeat(300) }
  });
  const traceId = res.headers.get('x-trace-id');
  assert.equal(traceId.slice(0, 4), 'okok');
  assert.ok(traceId.length <= 128);
  assert.match(traceId, /^[\w.:-]+$/);
});


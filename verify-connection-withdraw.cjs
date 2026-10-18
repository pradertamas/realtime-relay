'use strict';
const assert = require('node:assert/strict');
const {randomBytes} = require('node:crypto');
const {once} = require('node:events');
const http = require('node:http');
const {WebSocket} = require('ws');
const {ConnectionRequestStore, TOMBSTONE_MS} = require('./connection-request-store.cjs');
const {ConnectionRequestHttp} = require('./connection-request-http.cjs');
const {createRelay} = require('./server.js');
const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture({accepted = true, ...options} = {}) {
  let now = Date.UTC(2026, 0, 1);
  const store = new ConnectionRequestStore({now: () => now, ...options});
  const r = store.create('send').body, c = secret();
  if (accepted) assert.equal(store.accept(r.requestId, r.recipientCapability, c).code, 200);
  return {store, r, c, advance(ms) { now += ms; },
    withdraw(auth = c) { return store.withdraw(r.requestId, auth); },
    status(auth = c) { return store.status(r.requestId, auth); },
    bind() {
      for (const auth of [r.initiatorSecret, c]) assert.equal(store.participantState(r.requestId, auth, true).code, 200);
      return store.session(r.requestId, r.initiatorSecret).body.session.code;
    }};
}
async function main() {
  test('ACCEPTED withdraw, scoped terminal status and no secret echo', () => {
    const f = fixture(), result = f.withdraw();
    assert.equal(result.code, 200); assert.equal(result.body.state, 'FAILED');
    assert.equal(result.body.failureReason, 'recipient_withdrew');
    for (const auth of [f.c, f.r.initiatorSecret]) {
      const status = f.status(auth); assert.equal(status.code, 410);
      assert.equal(status.body.failureReason, 'recipient_withdrew');
      assert.equal(status.body.session, undefined);
    }
    const preview = f.status(f.r.recipientCapability);
    assert.equal(preview.code, 410); assert.equal(preview.body.failureReason, undefined);
    assert.equal(preview.body.session, undefined); assert.equal(preview.body.initiatorReady, undefined);
    const serialized = JSON.stringify([result, f.status(), preview]);
    for (const value of [f.c, f.r.initiatorSecret, f.r.recipientCapability]) assert.ok(!serialized.includes(value));
    assert.ok(!/Hash|Secret|Capability/.test(serialized));
  });
  test('CONNECTING invalidates once and quarantines code until original tombstone expiry', () => {
    const f = fixture({codeGenerator: () => 'AAAAAA'}), code = f.bind();
    const before = f.status().body; let calls = 0;
    f.store.onBindingInvalidated(id => { assert.equal(id, f.r.requestId); calls++; });
    assert.equal(f.withdraw().code, 200); assert.equal(calls, 1);
    assert.equal(f.store.boundRequestId(code), f.r.requestId);
    assert.equal(f.store.authorizeSocket(f.r.requestId, code, f.c, 'receiver', 'join'), null);
    f.advance(1000); assert.equal(f.withdraw().code, 200); assert.equal(calls, 1);
    assert.equal(f.status().body.acceptedAt, before.acceptedAt);
    assert.equal(f.status().body.connectBy, before.connectBy);
    const r = f.store.create('receive').body, c = secret();
    f.store.accept(r.requestId, r.recipientCapability, c);
    for (const auth of [r.initiatorSecret, c]) f.store.participantState(r.requestId, auth, true);
    assert.equal(f.store.session(r.requestId, r.initiatorSecret).code, 503);
    assert.equal(f.withdraw().code, 200); assert.equal(calls, 1);
    assert.equal(f.store.boundRequestId(code), f.r.requestId);
    assert.equal(f.store.authorizeSocket(f.r.requestId, code, f.c, 'receiver', 'join'), null);
    f.advance(TOMBSTONE_MS - 1001); assert.equal(f.store.boundRequestId(code), f.r.requestId);
    f.advance(1); assert.equal(f.store.boundRequestId(code), null);
    assert.equal(f.status().code, 404);
    for (const auth of [r.initiatorSecret, c]) f.store.participantState(r.requestId, auth, true);
    assert.equal(f.store.session(r.requestId, r.initiatorSecret).body.session.code, code);
  });
  test('retry preserves first terminalAt, retention and deadlines', () => {
    const f = fixture(); f.advance(1234); const first = f.withdraw();
    f.advance(TOMBSTONE_MS - 1); assert.equal(f.withdraw().code, 200);
    assert.notEqual(f.withdraw().body.serverNow, first.body.serverNow);
    f.advance(1); assert.equal(f.withdraw().code, 404); assert.equal(f.status().code, 404);
  });
  test('Cancel/timeout quarantine boundary, cleanup and binding-free terminals', () => {
    for (const cause of ['cancel', 'timeout']) for (const cleanup of [false, true]) {
      const f = fixture({codeGenerator: () => 'BBBBBB'}), code = f.bind();
      if (cause === 'cancel') f.store.cancel(f.r.requestId, f.r.initiatorSecret);
      else { f.advance(120000); f.status(); }
      f.store.releaseConnectedBinding(f.r.requestId, code);
      assert.equal(f.store.boundRequestId(code), f.r.requestId);
      f.advance(TOMBSTONE_MS - 1);
      if (cleanup) f.store.cleanup();
      assert.equal(f.store.boundRequestId(code), f.r.requestId);
      f.advance(1); if (cleanup) f.store.cleanup();
      assert.equal(f.store.boundRequestId(code), null); assert.equal(f.status().code, 404);
    }
    const f = fixture({codeGenerator: () => 'CCCCCC'}); f.withdraw();
    assert.equal(f.store.boundRequestId('CCCCCC'), null);
  });
  test('only winning claim; unknown, missing and wrong scope all generic 404', () => {
    const f = fixture(), safe = {code: 404, body: {error: 'unavailable'}};
    for (const auth of [null, '', f.r.recipientCapability, f.r.initiatorSecret, secret(16), secret(), 'malformed'])
      assert.deepEqual(f.store.withdraw(f.r.requestId, auth), safe);
    assert.deepEqual(f.store.withdraw(secret(16), f.c), safe);
    f.withdraw();
    for (const auth of [f.r.recipientCapability, f.r.initiatorSecret, secret()])
      assert.deepEqual(f.store.withdraw(f.r.requestId, auth), safe);
  });
  test('WAITING and EXPIRED have no winning claim', () => {
    const f = fixture({accepted: false}); assert.equal(f.withdraw().code, 404);
    f.advance(300000); assert.equal(f.withdraw().code, 404);
    assert.equal(f.status(f.r.initiatorSecret).body.state, 'EXPIRED');
  });
  test('CONNECTED rejects winner with 409 without changing state', () => {
    const f = fixture(); f.bind(); f.store.completeBinding(f.r.requestId);
    assert.deepEqual(f.withdraw(), {code: 409, body: {error: 'unavailable'}});
    assert.equal(f.status().body.state, 'CONNECTED');
  });
  test('CANCELED and establishment timeout retain terminal 410', () => {
    const f = fixture(); f.store.cancel(f.r.requestId, f.r.initiatorSecret);
    assert.equal(f.withdraw().code, 410); assert.equal(f.status().body.state, 'CANCELED');
    for (const bound of [false, true]) {
      const g = fixture(); if (bound) g.bind(); g.advance(120000);
      assert.equal(g.withdraw().code, 410);
      assert.equal(g.status().body.failureReason, 'establishment_timeout');
    }
  });
  test('withdraw before deadline wins; Accept/readiness/session cannot reopen', () => {
    const f = fixture(); f.advance(119999); f.withdraw();
    f.advance(1); f.store.cleanup(); assert.equal(f.status().body.failureReason, 'recipient_withdrew');
    for (const c of [f.c, secret()]) assert.equal(f.store.accept(f.r.requestId, f.r.recipientCapability, c).code, 410);
    for (const auth of [f.c, f.r.initiatorSecret]) assert.equal(f.store.participantState(f.r.requestId, auth, true).code, 410);
    assert.equal(f.store.session(f.r.requestId, f.r.initiatorSecret).code, 410);
  });
  test('withdraw/completion and withdraw/Cancel ordering is terminal-safe', () => {
    const f = fixture(); f.bind(); f.withdraw();
    assert.equal(f.store.completeBinding(f.r.requestId), false);
    assert.equal(f.store.cancel(f.r.requestId, f.r.initiatorSecret).code, 410);
    assert.equal(f.status().body.failureReason, 'recipient_withdrew');
    const g = fixture(); g.bind(); g.store.completeBinding(g.r.requestId);
    assert.equal(g.withdraw().code, 409);
    const h = fixture(); h.store.cancel(h.r.requestId, h.r.initiatorSecret);
    assert.equal(h.withdraw().code, 410); assert.equal(h.status().body.state, 'CANCELED');
  });
  await httpChecks();
  await sockets();
  console.log(`PASS ${passed} recipient withdraw test groups.`);
}
async function httpChecks() {
  const store = new ConnectionRequestStore();
  const router = new ConnectionRequestHttp({store});
  const server = http.createServer(async (req, res) => { if (!await router.http(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, auth, raw, headers = {}) {
    const res = await fetch(base + path, {method: 'POST', headers: {
      ...(auth && {Authorization: `Bearer ${auth}`}), ...headers}, ...(raw !== undefined && {body: raw})});
    return {code: res.status, body: await res.json(), headers: res.headers};
  }
  function setup() {
    const r = store.create('send').body, c = secret(); store.accept(r.requestId, r.recipientCapability, c);
    return {r, c, path: `/connection-requests/${r.requestId}/withdraw`};
  }
  try {
    const f = setup();
    for (const auth of [null, f.r.recipientCapability, f.r.initiatorSecret, secret(16), secret()]) {
      const result = await call(f.path, auth); assert.equal(result.code, 404); assert.deepEqual(result.body, {error: 'unavailable'});
    }
    assert.equal((await call(f.path + '?secret=x', f.c)).code, 400);
    assert.equal((await call(f.path, null, undefined, {Authorization: 'Basic invalid'})).code, 404);
    for (const [body, type] of [['{}', 'text/plain'], ['{', 'application/json'], ['null', 'application/json'],
      ['[]', 'application/json'], ['true', 'application/json'], ['1', 'application/json'],
      ['""', 'application/json'], ['{"extra":true}', 'application/json'], [' '.repeat(513), 'application/json']])
      assert.equal((await call(f.path, f.c, body, {'Content-Type': type})).code, 400);
    assert.equal(store.status(f.r.requestId, f.c).body.state, 'ACCEPTED');
    const result = await call(f.path, f.c, '{}', {'Content-Type': 'application/json'});
    assert.equal(result.code, 200); assert.equal(result.body.failureReason, 'recipient_withdrew');
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal((await call(f.path, f.c)).code, 200);
    passed++; console.log('PASS withdraw HTTP auth/body/query/cache validation');
    const preflight = await fetch(base + f.path, {method: 'OPTIONS', headers: {
      Origin: 'https://pairing.pradert.synology.me', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'}});
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://pairing.pradert.synology.me');
    assert.equal((await call(f.path, f.c, undefined, {Origin: 'https://foreign.invalid'})).code, 403);
    passed++; console.log('PASS withdraw exact-origin CORS');
    const g = setup();
    for (let i = 0; i < 30; i++) assert.equal((await call(g.path, g.c)).code, 200);
    const limited = await call(g.path, g.c); assert.equal(limited.code, 429); assert.equal(limited.headers.get('retry-after'), '60');
    // Independent mutation budgets, including after the withdraw budget was exhausted.
    assert.equal(router.cancelLimit.allow(g.r.requestId), true);
    assert.equal(router.withdrawLimit.perCode, 30); assert.equal(router.withdrawLimit.total, 6000);
    assert.notEqual(router.withdrawLimit, router.cancelLimit);
    const globalRouter = new ConnectionRequestHttp({schedule: () => ({unref() {}}), cancel() {}});
    try {
      for (let i = 0; i < 6000; i++) assert.equal(globalRouter.withdrawLimit.allow(String(i)), true);
      assert.equal(globalRouter.withdrawLimit.allow('overflow'), false);
    } finally { globalRouter.close(); }
    // Exercise global rejection through the HTTP route, without 6000 HTTP calls.
    router.withdrawLimit.start = Date.now(); router.withdrawLimit.count = 6000;
    const globalLimited = await call(f.path, f.c);
    assert.equal(globalLimited.code, 429); assert.equal(globalLimited.headers.get('retry-after'), '60');
    passed++; console.log('PASS withdraw 30/request and 6000/global independent limits');
  } finally { router.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function sockets() {
  const logs = [], credentials = [], peers = [], output = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const relay = createRelay({port: 0});
  const timeout = setTimeout(() => relay.shutdown(), 15000);
  async function until(fn) {
    for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw Error('Local withdraw socket wait failed');
  }
  relay.start(); await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  async function call(path, auth, body) {
    const res = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json',
      ...(auth && {Authorization: `Bearer ${auth}`})}, body: JSON.stringify(body)});
    return {code: res.status, body: await res.json()};
  }
  async function open(code, role, intent) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/ws?session=${code}&role=${role}&intent=${intent}`);
    const p = {ws, messages: [], closed: false, code: null}; peers.push(p);
    ws.on('error', () => {}); ws.on('message', data => p.messages.push(JSON.parse(data.toString())));
    ws.on('close', code => { p.closed = true; p.code = code; }); await once(ws, 'open'); return p;
  }
  try {
    const r = (await call('/connection-requests', null, {version: 1, initiatorRole: 'send'})).body, c = secret();
    credentials.push(r.initiatorSecret, r.recipientCapability, c);
    const path = `/connection-requests/${r.requestId}`;
    assert.equal((await call(path + '/accept', r.recipientCapability, {claimSecret: c})).code, 200);
    for (const auth of [r.initiatorSecret, c]) assert.equal((await call(path + '/participant-state', auth, {ready: true})).code, 200);
    const result = await call(path + '/session', r.initiatorSecret, {}); assert.equal(result.code, 200);
    const code = result.body.session.code;
    const initiator = await open(code, 'sender', 'create');
    initiator.ws.send(JSON.stringify({type: 'request-auth', requestId: r.requestId, secret: r.initiatorSecret}));
    await until(() => initiator.messages.some(m => m.type === 'registration' && m.status === 'ok'));
    const pending = await open(code, 'receiver', 'join');
    assert.equal((await call(path + '/withdraw', c, {})).code, 200);
    await until(() => initiator.closed && pending.closed);
    assert.equal(initiator.code, 1008); assert.equal(pending.code, 1008);
    passed++;
    for (const [role, intent, value] of [['sender', 'create', r.initiatorSecret], ['receiver', 'join', c],
      ['sender', 'create', null], ['receiver', 'join', null]]) {
      const old = await open(code, role, intent);
      old.ws.send(JSON.stringify(value ? {type: 'request-auth', requestId: r.requestId, secret: value} :
        {type: 'offer', sdp: 'synthetic-quarantine-probe'}));
      await until(() => old.closed); assert.equal(old.code, 1008);
      assert.ok(!old.messages.some(m => m.type === 'registration' && m.status === 'ok'));
      assert.ok(!old.messages.some(m => m.type === 'peer-present' || m.sdp === 'synthetic-quarantine-probe'));
      passed++;
    }
    const arbitrary = await Promise.all([open(code, 'sender', 'create'), open(code, 'receiver', 'join')]);
    for (const p of arbitrary) p.ws.send(JSON.stringify({type: 'offer', sdp: 'synthetic-arbitrary-peer'}));
    await until(() => arbitrary.every(p => p.closed));
    for (const p of arbitrary) {
      assert.equal(p.code, 1008);
      assert.ok(!p.messages.some(m => m.status === 'ok' || m.type === 'peer-present' || m.sdp));
    }
    passed++;
  } finally {
    for (const p of peers) p.ws.terminate(); clearTimeout(timeout);
    await relay.shutdown(); console.log = output;
  }
  for (const credential of credentials) assert.ok(!logs.join('\n').includes(credential));
  assert.ok(!/Authorization|request-auth/.test(logs.join('\n')));
  passed++; console.log('PASS withdraw closes authenticated/pending sockets, blocks old auth and keeps logs private');
}
main().catch(() => { console.error('FAIL recipient withdraw verification (credentials suppressed)'); process.exitCode = 1; });

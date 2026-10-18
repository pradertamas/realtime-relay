'use strict';
const assert = require('node:assert/strict');
const {randomBytes, randomInt} = require('node:crypto');
const {once} = require('node:events');
const {WebSocket} = require('ws');
const {ConnectionRequestStore, READY_LEASE_MS} = require('./connection-request-store.cjs');
const {createRelay} = require('./server.js');
const {ConnectionRequestHttp} = require('./connection-request-http.cjs');
const {JoinLimit} = require('./join-limit.cjs');
const secret = () => randomBytes(32).toString('base64url');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function fixture(options = {}, role = 'send') {
  let now = Date.UTC(2026, 0, 1);
  const store = new ConnectionRequestStore({now: () => now, ...options});
  const r = store.create(role).body, c = secret();
  store.accept(r.requestId, r.recipientCapability, c);
  return {store, r, c, advance(ms) { now += ms; },
    ready(value = true, auth = r.initiatorSecret) { return store.participantState(r.requestId, auth, value); },
    both() { this.ready(); this.ready(true, c); },
    bind() { return store.session(r.requestId, r.initiatorSecret); },
    status(auth = r.initiatorSecret) { return store.status(r.requestId, auth); }};
}
async function units() {
  test('lease true/false, refresh, equality and no request failure', () => {
    const f = fixture(); const first = f.ready(); assert.equal(first.code, 200);
    assert.equal(Date.parse(first.body.readyUntil) - Date.parse(first.body.serverNow), READY_LEASE_MS);
    f.advance(2000); const refresh = f.ready(); assert.notEqual(refresh.body.readyUntil, first.body.readyUntil);
    f.ready(true, f.c); f.advance(9999); assert.equal(f.status().body.initiatorReady, true);
    f.advance(1); assert.equal(f.status().body.initiatorReady, false); assert.equal(f.status().body.state, 'ACCEPTED');
    assert.equal(f.bind().body.error, 'participants_not_ready');
    assert.equal(f.ready(false).body.readyUntil, null);
  });
  test('readiness requires participant, ACCEPTED and exact boolean', () => {
    const f = fixture(); for (const auth of [f.r.recipientCapability, secret()]) assert.equal(f.ready(true, auth).code, 404);
    assert.equal(f.ready('true').code, 400); f.store.cancel(f.r.requestId, f.r.initiatorSecret); assert.equal(f.ready().code, 410);
    const s = new ConnectionRequestStore(), r = s.create('send').body;
    assert.equal(s.participantState(r.requestId, r.initiatorSecret, true).code, 409);
  });
  test('only one expired participant blocks binding; configurable lease', () => {
    const f = fixture({readyLeaseMs: 5000}); f.ready(); f.advance(3000); f.ready(true, f.c); f.advance(2000);
    assert.equal(f.status().body.initiatorReady, false); assert.equal(f.status().body.recipientReady, true);
    assert.equal(f.bind().code, 409); f.ready(); assert.equal(f.bind().code, 200);
  });
  test('both ready and initiator-only binding; idempotent retry and immutable deadline', () => {
    const f = fixture(); assert.equal(f.bind().code, 409); f.ready(); assert.equal(f.bind().code, 409);
    f.ready(true, f.c);
    for (const auth of [f.c, f.r.recipientCapability, secret()]) assert.equal(f.store.session(f.r.requestId, auth).code, 404);
    const before = f.status().body.connectBy, first = f.bind(); assert.equal(first.code, 200); assert.equal(first.body.state, 'CONNECTING');
    assert.match(first.body.session.code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    f.advance(11000); const again = f.bind(); assert.equal(again.body.session.code, first.body.session.code);
    assert.equal(again.body.connectBy, before); assert.equal(f.ready().code, 409);
    assert.equal(f.status().body.state, 'CONNECTING'); assert.equal(f.status().body.initiatorReady, false);
  });
  for (const role of ['send', 'receive']) test(role + ' assignments/auth scope/capability isolation', () => {
    const f = fixture({}, role); f.both(); const bound = f.bind().body;
    const i = f.status().body.session, r = f.status(f.c).body.session;
    assert.equal(i.intent, 'create'); assert.equal(r.intent, 'join');
    assert.equal(i.role, role === 'send' ? 'sender' : 'receiver'); assert.notEqual(i.role, r.role);
    assert.equal(f.status(f.r.recipientCapability).body.session, undefined);
    assert.equal(f.status(f.r.recipientCapability).body.initiatorReady, undefined);
    assert.equal(f.store.authorizeSocket(f.r.requestId, i.code, f.r.recipientCapability, r.role, 'join'), null);
    assert.equal(f.store.authorizeSocket(f.r.requestId, i.code, f.r.initiatorSecret, i.role, 'create'), 'initiator');
    assert.equal(f.store.authorizeSocket(f.r.requestId, i.code, f.c, r.role, 'join'), 'recipient');
    assert.equal(f.store.authorizeSocket(f.r.requestId, i.code, f.r.initiatorSecret, r.role, 'join'), null);
    assert.equal(f.store.authorizeSocket(f.r.requestId, i.code, f.c, i.role, 'create'), null);
    assert.equal(f.store.accept(f.r.requestId, f.r.recipientCapability, f.c).body.session.intent, 'join');
    assert.equal(f.store.accept(f.r.requestId, f.r.recipientCapability, secret()).code, 409);
    assert.equal(bound.connectBy, f.status().body.connectBy);
  });
  test('legacy collision + existing binding collision + finite retry failure', () => {
    const sequence = ['AAAAAA', 'BBBBBB', 'BBBBBB', 'CCCCCC'];
    const f = fixture({codeAvailable: code => code !== 'AAAAAA', codeGenerator: () => sequence.shift()});
    f.both(); assert.equal(f.bind().body.session.code, 'BBBBBB');
    const r2 = f.store.create('receive').body, c2 = secret(); f.store.accept(r2.requestId, r2.recipientCapability, c2);
    f.store.participantState(r2.requestId, r2.initiatorSecret, true); f.store.participantState(r2.requestId, c2, true);
    assert.equal(f.store.session(r2.requestId, r2.initiatorSecret).body.session.code, 'CCCCCC');
    let attempts = 0; const blocked = fixture({codeGenerator: () => { attempts++; return 'AAAAAA'; }, codeAvailable: () => false});
    blocked.both(); assert.equal(blocked.bind().code, 503); assert.equal(attempts, 16); assert.equal(blocked.status().body.state, 'ACCEPTED');
  });
  test('Cancel CONNECTING invalidates binding exactly once', () => {
    const f = fixture(); f.both(); const code = f.bind().body.session.code; let invalidated = 0;
    f.store.onBindingInvalidated(() => invalidated++);
    assert.equal(f.store.cancel(f.r.requestId, f.r.initiatorSecret).code, 200);
    assert.equal(f.store.boundRequestId(code), null); assert.equal(f.bind().code, 410);
    assert.equal(f.store.authorizeSocket(f.r.requestId, code, f.c, 'receiver', 'join'), null);
    f.store.cancel(f.r.requestId, f.r.initiatorSecret); assert.equal(invalidated, 1);
  });
  test('CONNECTING exact timeout invalidates binding lazily and in cleanup', () => {
    for (const lazy of [true, false]) {
      const f = fixture(); f.both(); const code = f.bind().body.session.code; f.advance(119999);
      assert.equal(f.status().body.state, 'CONNECTING'); f.advance(1);
      if (!lazy) f.store.cleanup(); assert.equal(f.store.boundRequestId(code), null);
      assert.equal(f.status().body.failureReason, 'establishment_timeout'); assert.equal(f.bind().code, 410);
      assert.equal(f.store.completeBinding(f.r.requestId), false);
    }
  });
  test('CONNECTED terminal tombstone cannot tear down media code reservation', () => {
    const f = fixture(); f.both(); const code = f.bind().body.session.code;
    assert.equal(f.store.completeBinding(f.r.requestId), true); assert.equal(f.status().code, 200);
    assert.ok(f.status().body.connectedAt); assert.equal(f.ready().code, 409);
    assert.equal(f.store.cancel(f.r.requestId, f.r.initiatorSecret).code, 409);
    f.advance(120000); f.store.cleanup(); assert.equal(f.status().code, 404);
    assert.equal(f.store.boundRequestId(code), f.r.requestId);
    f.store.releaseConnectedBinding(f.r.requestId, code); assert.equal(f.store.boundRequestId(code), null);
  });
}
async function integration() {
  let now = Date.UTC(2026, 0, 1), callbacks = new Map(), nextTimer = 0;
  const generated = [];
  const secrets = [], logs = [], output = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const relay = createRelay({port: 0, requestOptions: {now: () => now, codeGenerator: () => generated.shift() ||
    Array.from({length:6}, () => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[randomInt(31)]).join('')}, authOptions: {
    schedule(fn, ms) { assert.equal(ms, 10000); const id = ++nextTimer; callbacks.set(id, fn); return id; },
    cancel(id) { callbacks.delete(id); }}});
  const peers = [];
  const deadline = setTimeout(() => { relay.shutdown(); }, 15000);
  async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Local signaling wait failed'); }
  relay.start(); await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  async function call(path, auth, body, method = 'POST') {
    const response = await fetch(base + path, {method, headers: {
      ...(auth && {Authorization: `Bearer ${auth}`}), ...(body !== undefined && {'Content-Type': 'application/json'})},
      ...(body !== undefined && {body: JSON.stringify(body)})});
    return {code: response.status, body: await response.json(), headers: response.headers};
  }
  async function setup(role = 'send') {
    const created = await call('/connection-requests', null, {version: 1, initiatorRole: role}); assert.equal(created.code, 201);
    const r = created.body, c = secret(), path = `/connection-requests/${r.requestId}`;
    secrets.push(r.initiatorSecret, r.recipientCapability, c);
    assert.equal((await call(path + '/status', r.recipientCapability, undefined, 'GET')).body.state, 'WAITING');
    assert.equal((await call(path + '/accept', r.recipientCapability, {claimSecret: c})).code, 200);
    for (const auth of [r.initiatorSecret, c]) assert.equal((await call(path + '/participant-state', auth, {ready: true})).code, 200);
    const binding = await call(path + '/session', r.initiatorSecret, {}); assert.equal(binding.code, 200);
    return {r, c, path, i: binding.body.session, j: (await call(path + '/status', c, undefined, 'GET')).body.session};
  }
  async function open(code, role, intent) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/ws?session=${code}&role=${role}&intent=${intent}`);
    const p = {ws, messages: [], closed: false, closeCode: null}; peers.push(p);
    ws.on('error', () => {}); ws.on('message', raw => p.messages.push(JSON.parse(raw.toString())));
    ws.on('close', code => { p.closed = true; p.closeCode = code; }); await once(ws, 'open'); return p;
  }
  function auth(p, f, value) { p.ws.send(JSON.stringify({type: 'request-auth', requestId: f.r.requestId, secret: value})); }
  async function denied(f, assignment, value, message) {
    const p = await open(assignment.code, assignment.role, assignment.intent);
    p.ws.send(JSON.stringify(message || {type: 'request-auth', requestId: f.r.requestId, secret: value}));
    await until(() => p.closed); assert.equal(p.closeCode, 1008);
    assert.ok(!p.messages.some(m => m.status === 'ok' || m.type === 'peer-present')); passed++;
  }
  try {
    const legacy = await open('AAAAAA', 'sender', 'create');
    await until(() => legacy.messages.some(m => m.status === 'ok'));
    generated.push('AAAAAA', 'BBBBBB'); const collision = await setup(); assert.equal(collision.i.code, 'BBBBBB');
    generated.push('BBBBBB', 'CCCCCC'); const collision2 = await setup(); assert.equal(collision2.i.code, 'CCCCCC');
    for (const f of [collision, collision2]) assert.equal((await call(f.path+'/cancel', f.r.initiatorSecret)).code, 200);
    legacy.ws.close(); await until(() => legacy.closed); passed++;
    for (const role of ['send', 'receive']) {
      const f = await setup(role);
      for (const [assignment, value] of [[f.j, f.r.recipientCapability], [f.j, secret()], [f.j, f.r.initiatorSecret],
        [f.i, f.c], [{...f.i, role: f.j.role}, f.r.initiatorSecret], [{...f.i, intent: 'join'}, f.r.initiatorSecret]])
        await denied(f, assignment, value);
      await denied(f, f.j, null, {type: 'request-auth', requestId: 'A'.repeat(22), secret: f.c});
      await denied(f, f.j, null, {type: 'offer', sdp: 'unauthorized'});
      await denied(f, f.j, null, {type: 'ice', candidate: 'unauthorized'});
      await denied(f, f.j, null, {type: 'bye'});
      const binary = await open(f.j.code, f.j.role, 'join');
      binary.ws.send(Buffer.from(JSON.stringify({type:'request-auth',requestId:f.r.requestId,secret:f.c})));
      await until(() => binary.closed); assert.equal(binary.closeCode,1008); passed++;
      const oversized = await open(f.j.code, f.j.role, 'join'); oversized.ws.send(' '.repeat(513));
      await until(() => oversized.closed); assert.equal(oversized.closeCode,1008); passed++;
      const pending = await open(f.j.code, f.j.role, 'join');
      assert.equal(pending.messages.length, 0); assert.ok(callbacks.size > 0);
      for (const fn of [...callbacks.values()]) fn(); await until(() => pending.closed);
      assert.equal(pending.closeCode, 1008); passed++;
      const early = await open(f.i.code, f.i.role, 'create'); auth(early, f, f.r.initiatorSecret);
      await until(() => early.messages.some(m => m.status === 'ok'));
      assert.equal((await call(f.path + '/status', f.c, undefined, 'GET')).body.state, 'CONNECTING');
      early.ws.close(); await until(() => early.closed);
      const initiator = await open(f.i.code, f.i.role, 'create'); auth(initiator, f, f.r.initiatorSecret);
      await until(() => initiator.messages.some(m => m.status === 'ok'));
      // Code-only attacker cannot get a peer event or forward even while the real creator is present.
      await denied(f, f.j, null, {type: 'offer', sdp: 'attacker'});
      assert.equal(initiator.messages.some(m => m.type === 'peer-present' || m.type === 'offer'), false);
      const recipient = await open(f.j.code, f.j.role, 'join'); auth(recipient, f, f.c);
      await until(() => [initiator, recipient].every(p => p.messages.some(m => m.type === 'peer-present')));
      assert.equal((await call(f.path + '/status', f.c, undefined, 'GET')).body.state, 'CONNECTED');
      for (const [from, to, payload] of [[initiator, recipient, {type: 'ice', candidate: {candidate: 'test'}}],
        [recipient, initiator, {type: 'answer', sdp: 'test'}], [initiator, recipient, {type: 'offer', sdp: 'test'}],
        [recipient, initiator, {type: 'bye'}]]) {
        from.ws.send(JSON.stringify(payload)); await until(() => to.messages.some(m => JSON.stringify(m) === JSON.stringify(payload)));
      }
      await denied(f, f.j, f.c); // No second registration after completion.
      const closedPeer = once(recipient.ws, 'close'); initiator.ws.close(); await closedPeer;
      assert.ok(recipient.messages.some(m => m.type === 'peer-left'));
      assert.equal((await call(f.path + '/status', f.r.initiatorSecret, undefined, 'GET')).body.state, 'CONNECTED');
      passed++;
    }
    const cancel = await setup();
    const registered = await open(cancel.i.code, cancel.i.role, 'create'); auth(registered, cancel, cancel.r.initiatorSecret);
    await until(() => registered.messages.some(m => m.status === 'ok'));
    const pending = await open(cancel.j.code, cancel.j.role, 'join');
    assert.equal((await call(cancel.path + '/cancel', cancel.r.initiatorSecret)).code, 200);
    await until(() => registered.closed && pending.closed);
    assert.equal(relay.requestStore.authorizeSocket(cancel.r.requestId, cancel.i.code, cancel.c, cancel.j.role, 'join'), null);
    assert.equal(relay.requestStore.boundRequestId(cancel.i.code), null); passed++;
    const timeout = await setup();
    const waiting = await open(timeout.i.code, timeout.i.role, 'create'); auth(waiting, timeout, timeout.r.initiatorSecret);
    await until(() => waiting.messages.some(m => m.status === 'ok'));
    now += 120000;
    const timed = await call(timeout.path + '/status', timeout.c, undefined, 'GET');
    assert.equal(timed.code, 410); assert.equal(timed.body.failureReason, 'establishment_timeout');
    await until(() => waiting.closed); assert.equal(relay.requestStore.boundRequestId(timeout.i.code), null); passed++;
    // Terminal HTTP record retention must be independent of a live signaling pair.
    const live = await setup();
    const liveI = await open(live.i.code, live.i.role, 'create'); auth(liveI, live, live.r.initiatorSecret);
    await until(() => liveI.messages.some(m => m.status === 'ok'));
    const liveR = await open(live.j.code, live.j.role, 'join'); auth(liveR, live, live.c);
    await until(() => liveR.messages.some(m => m.type === 'peer-present'));
    now += 120000; relay.requestStore.cleanup();
    assert.equal((await call(live.path+'/status',live.c,undefined,'GET')).code,404);
    assert.equal(relay.requestStore.boundRequestId(live.i.code),live.r.requestId);
    liveI.ws.send(JSON.stringify({type:'ice',candidate:'after-tombstone'}));
    await until(() => liveR.messages.some(m => m.candidate === 'after-tombstone'));
    // Diagnostic/no-intent legacy admission must not bypass the protected reservation.
    const rejected = await new Promise((resolve,reject) => {
      const ws = new WebSocket(base.replace('http:','ws:')+`/ws?session=${live.i.code}&role=receiver`);
      peers.push({ws}); ws.on('error',()=>{});
      ws.on('unexpected-response',(_,res)=>{res.resume();ws.terminate();resolve(res.statusCode);});
      ws.on('open',()=>{ws.terminate();reject(Error('Unexpected diagnostic bypass'));});
    });
    assert.equal(rejected,400);
    liveI.ws.close(); await until(() => liveI.closed && liveR.closed);
    assert.equal(relay.requestStore.boundRequestId(live.i.code),null);
    const reused = await open(live.i.code,'sender','create');
    await until(() => reused.messages.some(m => m.status === 'ok')); reused.ws.close(); await until(() => reused.closed); passed++;
    assert.equal(callbacks.size, 0);
    for (const value of secrets) assert.ok(!logs.join('\n').includes(value));
    assert.ok(!logs.join('\n').includes('request-auth')); passed++;
  } finally {
    clearTimeout(deadline); for (const p of peers) p.ws.terminate();
    const closed = once(relay.server, 'close'); relay.shutdown(); relay.server.closeAllConnections(); await closed;
    console.log = output;
  }
  console.log('PASS local protected HTTP/WS smoke: both media mappings, auth attacks/timeouts, reconnect, unchanged payload forwarding, cancel/timeout and secret-free logs.');
}
async function rateAndHttpValidation() {
  const f = fixture();
  const router = new ConnectionRequestHttp({store:f.store, schedule:()=>({unref(){}}),cancel(){},
    participantLimit:new JoinLimit({perCode:2,total:2}), sessionLimit:new JoinLimit({perCode:2,total:2})});
  async function invoke(action, auth, body) {
    let result;
    const req={url:`/connection-requests/${f.r.requestId}/${action}`,method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},
      resume(){},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}};
    const res={writeHead(code,headers){result={code,headers};},end(text){result.body=JSON.parse(text);}};
    await router.http(req,res); return result;
  }
  try {
    assert.equal((await invoke('participant-state',f.r.initiatorSecret,{ready:'true'})).code,400);
    assert.equal((await invoke('participant-state',f.r.initiatorSecret,{ready:true})).code,200);
    const limited=await invoke('participant-state',f.c,{ready:true});assert.equal(limited.code,429);assert.equal(limited.headers['Retry-After'],'60');
    f.both();assert.equal((await invoke('session',f.r.initiatorSecret,{})).code,200);
    assert.equal((await invoke('session',f.r.initiatorSecret,{})).code,200);
    assert.equal((await invoke('session',f.r.initiatorSecret,{})).code,429);passed++;
  } finally {router.close();}
}
units().then(rateAndHttpValidation).then(integration).then(() => console.log(`PASS ${passed} CP3 test groups.`)).catch(error => {
  // Assertion operands may contain transient credentials; never dump them.
  console.error('FAIL CP3 verification: ' + (error.code === 'ERR_ASSERTION' ? 'assertion failed' : 'local test failed'));
  process.exitCode = 1;
});

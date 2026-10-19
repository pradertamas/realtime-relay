'use strict';
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {randomBytes} = require('node:crypto');
const {WebSocket} = require('ws');
const {createRelay} = require('./server.js');

// Real local HTTP/WS boundary; fake request time. No sleep decides protocol order.
async function main() {
  let now = Date.UTC(2026, 0, 1);
  const relay = createRelay({port: 0, requestOptions: {now: () => now}});
  const peers = [];
  relay.start(); await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  async function call(path, auth, body) {
    const r = await fetch(base + path, {method: body === undefined ? 'GET' : 'POST', headers: {
      ...(auth && {Authorization: `Bearer ${auth}`}), 'Content-Type': 'application/json'},
      ...(body !== undefined && {body: JSON.stringify(body)})});
    return {code: r.status, body: await r.json()};
  }
  async function setup(role = 'send') {
    const r = (await call('/connection-requests', null, {version: 1, initiatorRole: role})).body;
    const claim = randomBytes(32).toString('base64url'), path = `/connection-requests/${r.requestId}`;
    assert.equal((await call(path + '/accept', r.recipientCapability, {claimSecret: claim})).code, 200);
    for (const auth of [r.initiatorSecret, claim])
      assert.equal((await call(path + '/participant-state', auth, {ready: true})).code, 200);
    const i = (await call(path + '/session', r.initiatorSecret, {})).body.session;
    const j = (await call(path + '/status', claim)).body.session;
    return {r, claim, path, i, j};
  }
  async function open(a) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + `/ws?session=${a.code}&role=${a.role}&intent=${a.intent}`);
    const p = {ws, messages: [], closed: false, waiters: []}; peers.push(p);
    const changed = () => { for (const fn of [...p.waiters]) fn(); };
    ws.on('error', () => {});
    ws.on('message', b => { p.messages.push(JSON.parse(b)); changed(); });
    ws.on('close', () => { p.closed = true; changed(); });
    await once(ws, 'open'); return p;
  }
  function wait(p, predicate) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { remove(); reject(Error('Protocol event missing')); }, 3000);
      const remove = () => { clearTimeout(timeout); p.waiters = p.waiters.filter(fn => fn !== check); };
      const check = () => { if (predicate()) { remove(); resolve(); } };
      p.waiters.push(check); check();
    });
  }
  const has = (p, type) => p.messages.some(m => m.type === type);
  function auth(p, f, secret) { p.ws.send(JSON.stringify({type: 'request-auth', requestId: f.r.requestId, secret})); }
  async function registered(p) {
    await wait(p, () => has(p, 'registration') || p.closed);
    assert.equal(p.closed, false, 'authenticated JOIN must remain open');
    assert.equal(p.messages.find(m => m.type === 'registration').status, 'ok',
      'authenticated JOIN must wait for CREATE, not return not-found');
  }
  async function close(p) { p.ws.close(); await wait(p, () => p.closed); }
  try {
    for (const role of ['send', 'receive']) {
      const f = await setup(role);
      const join = await open(f.j); auth(join, f, f.claim); await registered(join);
      assert.equal(has(join, 'peer-present'), false);
      assert.equal((await call(f.path + '/status', f.claim)).body.state, 'CONNECTING');
      // Advance beyond Android's 15s registration deadline: registration is already complete.
      now += 20000;
      const duplicate = await open(f.j); auth(duplicate, f, f.claim);
      await wait(duplicate, () => duplicate.closed);
      assert.equal(has(duplicate, 'registration'), false);
      const creator = await open(f.i); auth(creator, f, f.r.initiatorSecret); await registered(creator);
      await wait(join, () => has(join, 'peer-present'));
      await wait(creator, () => has(creator, 'peer-present'));
      assert.equal(join.messages.filter(m => m.type === 'peer-present').length, 1);
      assert.equal((await call(f.path + '/status', f.claim)).body.state, 'CONNECTED');
      const sender = role === 'send' ? creator : join, receiver = role === 'send' ? join : creator;
      sender.ws.send(JSON.stringify({type: 'offer', sdp: 'synthetic-offer'}));
      await wait(receiver, () => has(receiver, 'offer'));
      receiver.ws.send(JSON.stringify({type: 'answer', sdp: 'synthetic-answer'}));
      await wait(sender, () => has(sender, 'answer'));
      sender.ws.send(JSON.stringify({type: 'ice', candidate: {candidate: 'synthetic-ice'}}));
      await wait(receiver, () => has(receiver, 'ice'));
      await close(join); await wait(creator, () => creator.closed);
      console.log('PASS authenticated JOIN-before-CREATE, delayed consent, duplicate and SDP/ICE: ' + role);
    }
    const manual = await open({code: 'ZZZZZZ', role: 'receiver', intent: 'join'});
    await wait(manual, () => manual.closed);
    assert.equal(manual.messages.find(m => m.type === 'registration').status, 'not-found');
    console.log('PASS manual missing code remains not-found');
    const bad = await setup();
    for (const value of [bad.r.recipientCapability, randomBytes(32).toString('base64url'), bad.r.initiatorSecret]) {
      const p = await open(bad.j); auth(p, bad, value); await wait(p, () => p.closed);
      assert.equal(has(p, 'registration'), false);
    }
    const wrong = await setup();
    const cross = await open(bad.j); auth(cross, wrong, wrong.claim); await wait(cross, () => cross.closed);
    assert.equal(has(cross, 'registration'), false);
    console.log('PASS capability/wrong secret/wrong participant/cross-request rejected');
    const departed = await setup();
    const first = await open(departed.j); auth(first, departed, departed.claim); await registered(first); await close(first);
    const creator = await open(departed.i); auth(creator, departed, departed.r.initiatorSecret); await registered(creator);
    assert.equal(has(creator, 'peer-present'), false);
    const replacement = await open(departed.j); auth(replacement, departed, departed.claim); await registered(replacement);
    await wait(creator, () => has(creator, 'peer-present'));
    console.log('PASS pending disconnect leaves no ghost participant or room');
    const expired = await setup();
    const pending = await open(expired.j); auth(pending, expired, expired.claim); await registered(pending);
    now += 120000; relay.requestStore.cleanup();
    await wait(pending, () => pending.closed);
    const late = await open(expired.i); auth(late, expired, expired.r.initiatorSecret); await wait(late, () => late.closed);
    assert.equal(has(late, 'registration'), false);
    console.log('PASS connectBy purges pending participant and late CREATE cannot revive it');
    for (const action of ['cancel', 'withdraw']) {
      const f = await setup();
      const p = await open(f.j); auth(p, f, f.claim); await registered(p);
      assert.equal((await call(f.path + '/' + action, action === 'cancel' ? f.r.initiatorSecret : f.claim, {})).code, 200);
      await wait(p, () => p.closed);
      const late = await open(f.i); auth(late, f, f.r.initiatorSecret); await wait(late, () => late.closed);
      assert.equal(has(late, 'registration'), false);
      console.log('PASS ' + action + ' purges JOIN-first pending state without revival');
    }
  } finally {
    for (const p of peers) p.ws.terminate();
    relay.shutdown();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {readFileSync} = require('node:fs');
const {WebSocket} = require('ws');
const {ConnectionRequestStore, canonical, WAITING_MS, TOMBSTONE_MS, CLEANUP_MS} = require('./connection-request-store.cjs');
const {ConnectionRequestHttp} = require('./connection-request-http.cjs');
const {JoinLimit} = require('./join-limit.cjs');
const ORIGIN = 'https://pairing.pradert.synology.me';
async function main() {
  let now = Date.UTC(2026, 0, 1), tick, stopped = false, unref = false;
  const store = new ConnectionRequestStore({now: () => now, capacity: 2});
  const router = new ConnectionRequestHttp({store, schedule(fn, ms) {
    assert.equal(ms, CLEANUP_MS); tick = fn; return {unref() { unref = true; }};
  }, cancel() { stopped = true; }});
  const server = http.createServer(async (req, res) => {
    if (!await router.http(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, options = {}) {
    const res = await fetch(base + path, options), text = await res.text();
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return {code: res.status, body: text ? JSON.parse(text) : null, headers: res.headers};
  }
  const create = body => call('/connection-requests', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const status = (r, secret, extra = {}) => call(`/connection-requests/${r.requestId}/status`, {headers: {Authorization: `Bearer ${secret}`, ...extra}});
  try {
    assert.ok(unref);
    for (const body of [{version: 2, initiatorRole: 'send'}, {version: '1', initiatorRole: 'send'},
      {version: 1, initiatorRole: 'sender'}, {version: 1, initiatorRole: 'send', ttl: 10}, null, []])
      assert.equal((await create(body)).code, 400);
    assert.equal((await call('/connection-requests', {method: 'POST', body: '{}'})).code, 400);
    assert.equal((await call('/connection-requests', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{'})).code, 400);
    assert.equal((await call('/connection-requests', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: ' '.repeat(513)})).code, 400);
    const a = await create({version: 1, initiatorRole: 'send'}), b = await create({version: 1, initiatorRole: 'receive'});
    assert.equal(a.code, 201); assert.equal(b.code, 201);
    for (const r of [a.body, b.body]) {
      assert.equal(r.state, 'WAITING'); assert.ok(canonical(r.requestId, 16));
      assert.ok(canonical(r.recipientCapability, 16)); assert.ok(canonical(r.initiatorSecret, 32));
      assert.equal(Date.parse(r.expiresAt) - Date.parse(r.serverNow), WAITING_MS);
      assert.deepEqual(Object.keys(r).sort(), ['expiresAt','initiatorSecret','recipientCapability','requestId','serverNow','state'].sort());
    }
    const r = a.body;
    const initiator = await status(r, r.initiatorSecret), recipient = await status(r, r.recipientCapability);
    assert.equal(initiator.code, 200); assert.equal(recipient.code, 200);
    assert.equal(initiator.body.createdAt, r.serverNow); assert.equal(recipient.body.createdAt, undefined);
    assert.deepEqual(Object.keys(initiator.body).sort(), ['requestId','state','initiatorRole','serverNow','createdAt','expiresAt'].sort());
    assert.equal((await status(b.body, b.body.initiatorSecret)).body.initiatorRole, 'receive');
    assert.deepEqual(Object.keys(recipient.body).sort(), ['requestId','state','initiatorRole','serverNow','expiresAt'].sort());
    const path = `/connection-requests/${r.requestId}/status`;
    for (const auth of ['', 'Basic x', `bearer ${r.initiatorSecret}`, `Bearer  ${r.initiatorSecret}`, `Bearer ${r.initiatorSecret},x`, 'Bearer ' + 'A'.repeat(43), 'Bearer ' + 'B'.repeat(22)]) {
      const result = await call(path, {headers: {Authorization: auth}});
      assert.equal(result.code, 404); assert.deepEqual(result.body, {error: 'unavailable'});
    }
    assert.equal((await call(path)).code, 404);
    assert.equal((await call(path, {headers: {Cookie: 'secret=' + r.initiatorSecret}})).code, 404);
    assert.equal((await call(path + '?secret=' + r.initiatorSecret)).code, 400);
    assert.equal((await status({requestId: 'A'.repeat(22)}, r.initiatorSecret)).code, 404);
    assert.equal((await create({version: 1, initiatorRole: 'send'})).code, 503);
    now += WAITING_MS - 1; assert.equal((await status(r, r.initiatorSecret)).code, 200);
    now++; // No cleanup callback has run: expiry is enforced lazily at equality.
    assert.equal((await status(r, r.initiatorSecret)).code, 410);
    assert.equal((await status(r, r.recipientCapability)).code, 410);
    assert.equal((await status(r, 'A'.repeat(43))).code, 404);
    assert.equal(store.size, 2);
    now += TOMBSTONE_MS - 1; tick(); assert.equal(store.size, 2);
    now++; tick(); assert.equal(store.size, 0);
    assert.equal((await status(r, r.initiatorSecret)).code, 404);
    assert.equal((await create({version: 1, initiatorRole: 'send'})).code, 201);
    const opts = await call('/connection-requests', {method: 'OPTIONS', headers: {Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization'}});
    assert.equal(opts.code, 204); assert.equal(opts.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(opts.headers.get('access-control-allow-credentials'), null);
    assert.equal((await status(r, r.initiatorSecret, {Origin: 'https://evil.invalid'})).code, 403);
    assert.equal((await call('/connection-requests', {method: 'OPTIONS', headers: {Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-secret'}})).code, 403);
    for (const action of ['accept','cancel','participant-state','session']) {
      const response = await fetch(`${base}/connection-requests/${r.requestId}/${action}`, {method: 'POST'});
      assert.equal(response.status, 404);
    }
    // Structural privacy: records are private and only hashes are assigned to them.
    const source = readFileSync(require.resolve('./connection-request-store.cjs'), 'utf8');
    const recordAssignment = source.split('this.#records.set(requestId, ')[1].split('});')[0];
    assert.ok(recordAssignment.includes('recipientCapabilityHash: digest(recipientCapability)'));
    assert.ok(recordAssignment.includes('initiatorSecretHash: digest(initiatorSecret)'));
    assert.ok(!/\b(recipientCapability|initiatorSecret)\s*[,}]/.test(recordAssignment));
    assert.deepEqual(Object.keys(store).sort(), ['capacity', 'now']);
    assert.throws(() => new ConnectionRequestStore({capacity: 0}));
    // Separate limiter budgets are deterministic and do not rely on forwarded IP.
    const limiter = new JoinLimit({perCode: 1, total: 1, now: () => now});
    const limited = new ConnectionRequestHttp({createLimit: limiter, statusLimit: limiter,
      schedule: () => ({unref() {}}), cancel() {}});
    async function probe(method, url) {
      let code, headers;
      const req = {method, url, headers: {}, resume() {}};
      const res = {writeHead(c, h) {code = c; headers = h;}, end() {}};
      await limited.http(req, res); return {code, headers};
    }
    assert.equal((await probe('POST','/connection-requests')).code, 400);
    const throttled = await probe('POST','/connection-requests');
    assert.equal(throttled.code, 429); assert.equal(throttled.headers['Retry-After'], '60');
    assert.equal((await probe('GET', path)).code, 429);
    limited.close();
    // Periodic cleanup recognizes expiry even when no status lookup occurs.
    const periodic = new ConnectionRequestStore({now: () => now, capacity: 1});
    const expired = periodic.create('send').body;
    now += WAITING_MS;
    periodic.cleanup();
    assert.equal(periodic.status(expired.requestId, expired.initiatorSecret).code, 410);
    assert.equal(periodic.create('send').code, 503); // Tombstone still consumes capacity.
    now += TOMBSTONE_MS;
    assert.equal(periodic.create('receive').code, 201); // Create performs cleanup itself.
    // Restart is intentionally not recovery.
    assert.equal(new ConnectionRequestStore().status(r.requestId, r.initiatorSecret).code, 404);
  } finally { router.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.ok(stopped);
  console.log('PASS connection request core: create/auth/projections, exact lazy expiry, cleanup/tombstones/capacity, CORS/limits, hash-only private records, restart.');
}

async function integratedSmoke() {
  const net = require('node:net'), reservation = net.createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const child = spawn(process.execPath, ['server.js'], {cwd: __dirname, env: {...process.env, PORT: String(port)},
    windowsHide: true, stdio: ['ignore','pipe','pipe']});
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const peers = [], timeout = setTimeout(() => child.kill(), 15000);
  async function until(fn) { for (let i=0;i<300;i++) {if(fn())return; await new Promise(r=>setTimeout(r,10));} throw Error('Local smoke timeout'); }
  try {
    await until(() => logs.includes('server start'));
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(base + '/connection-requests', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({version:1,initiatorRole:'send'})});
    assert.equal(response.status,201); const request = await response.json();
    async function status(secret) { const r = await fetch(`${base}/connection-requests/${request.requestId}/status`, {headers:{Authorization:`Bearer ${secret}`}}); return {code:r.status, body:await r.json()}; }
    assert.equal((await status(request.initiatorSecret)).body.state,'WAITING'); // No WebSocket exists.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=7K4M2Q&role=sender&intent=create`); peers.push(ws);
    const messages=[]; ws.on('message', d=>messages.push(JSON.parse(d))); ws.on('error',()=>{});
    await until(()=>messages.some(m=>m.type==='registration'));
    ws.send(JSON.stringify({type:'remote-presence-register',token:'AAAAAAAAAAAAAAAAAAAAAA'}));
    await until(()=>messages.some(m=>m.status==='registered'));
    ws.close(); await until(()=>ws.readyState===3 && logs.includes('connection closed'));
    assert.equal((await status(request.initiatorSecret)).body.state,'WAITING');
    assert.equal((await status(request.recipientCapability)).body.state,'WAITING');
    assert.equal((await status('A'.repeat(43))).code,404);
    for(const secret of [request.recipientCapability,request.initiatorSecret,'AAAAAAAAAAAAAAAAAAAAAA']) assert.ok(!logs.includes(secret));
    assert.ok(!logs.includes('Authorization') && !logs.includes('CapabilityHash') && !logs.includes('SecretHash'));
    console.log('PASS local HTTP smoke + real signaling/presence socket cleanup independence and secret-free server logs.');
  } finally {
    clearTimeout(timeout); for(const peer of peers)peer.terminate();
    const exited = once(child,'exit'); child.kill(); if(child.exitCode===null)await exited;
  }
}
main().then(integratedSmoke).catch(() => { console.error('FAIL connection request verification (assertion failed; credentials suppressed)'); process.exitCode = 1; });

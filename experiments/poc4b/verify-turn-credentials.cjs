'use strict';
// Loopback HTTP and an injected Cloudflare stub only. No real tokens or upstream calls.
const http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createTurnHandler, TTL_SECONDS } = require('./turn-credentials.cjs');
const env = { TURN_ENDPOINT_ACCESS_TOKEN: 'fixture-endpoint-access-token-not-real-123',
  CLOUDFLARE_TURN_KEY_ID: 'fixture-key-id', CLOUDFLARE_TURN_API_TOKEN: 'fixture-cloudflare-token-not-real', TURN_USD_PER_GB: '0.05' };
let clock = Date.now(), calls = 0, behavior = 'ok';
const upstream = async (url, options) => {
  calls++;
  assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/fixture-key-id/credentials/generate-ice-servers');
  assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`);
  assert.deepEqual(JSON.parse(options.body), { ttl: TTL_SECONDS });
  if (behavior === 'throw') throw Error('fixture-upstream-sensitive-error');
  if (behavior === 'failure') return new Response('fixture-upstream-sensitive-body', { status: 403 });
  if (behavior === 'oversized') return new Response('x'.repeat(32769), { status: 201 });
  const urls = behavior === 'foreign' ? ['turn:other.invalid:3478?transport=udp'] : ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'];
  return new Response(JSON.stringify({ arbitraryUpstreamField: 'must-not-escape', iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] }, { urls, username: 'fixture-temporary-user', credential: 'fixture-temporary-password' }
  ] }), { status: 201 });
};
const handler = createTurnHandler({ env, fetchImpl: upstream, now: () => clock });
const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/turn/credentials`;
  async function request({ headers = {}, body = JSON.stringify({ session: 'fixture_session' }), method = 'POST', advance = true } = {}) {
    if (advance) clock += 60000;
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${env.TURN_ENDPOINT_ACCESS_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8', ...headers }, body: method === 'GET' ? undefined : body });
    return { response, body: await response.json() };
  }
  let result = await request();
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'iceServers', 'usdPerGb']);
  assert.equal(result.body.expiresAt, clock + 600000);
  assert.equal(result.body.usdPerGb, .05);
  assert.equal(result.body.iceServers.length, 1);
  assert.ok(!JSON.stringify(result.body).includes(env.CLOUDFLARE_TURN_API_TOKEN));
  const initialCalls = calls;
  for (const [options, code] of [
    [{ method: 'GET' }, 405], [{ headers: { Origin: 'https://untrusted.invalid' } }, 403],
    [{ headers: { Authorization: 'Bearer incorrect' } }, 401], [{ body: '{' }, 400],
    [{ body: JSON.stringify({ session: 'short' }) }, 400],
    [{ body: JSON.stringify({ session: 'valid_session', ttl: 9999 }) }, 400],
    [{ body: 'x'.repeat(513) }, 413], [{ headers: { 'Content-Type': 'text/plain' } }, 415]
  ]) { assert.equal((await request(options)).response.status, code); }
  assert.equal(calls, initialCalls, 'Invalid input must not mint upstream credentials');
  for (const failure of ['throw', 'failure', 'foreign', 'oversized']) {
    behavior = failure; result = await request(); assert.equal(result.response.status, 502);
    assert.deepEqual(result.body, { error: 'TURN credential acquisition failed' });
  }
  behavior = 'ok'; env.TURN_USD_PER_GB = '0.12'; assert.equal((await request()).body.usdPerGb, .12);
  env.TURN_USD_PER_GB = '-1'; assert.equal((await request()).response.status, 503); env.TURN_USD_PER_GB = '.05';
  const saved = env.CLOUDFLARE_TURN_API_TOKEN; delete env.CLOUDFLARE_TURN_API_TOKEN;
  assert.equal((await request()).response.status, 503); env.CLOUDFLARE_TURN_API_TOKEN = saved;
  clock += 60000;
  for (let i = 0; i < 10; i++) assert.equal((await request({ advance: false, headers: { Authorization: 'invalid' } })).response.status, 401);
  assert.equal((await request({ advance: false })).response.status, 429);
  console.log('PASS TURN endpoint: fixed upstream/TTL, auth, native-only origin policy, bounded input/output, validation, no-store, sanitized failures, configured cost, missing env and rate limit. No public API contacted.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server.close(); server.closeAllConnections(); });

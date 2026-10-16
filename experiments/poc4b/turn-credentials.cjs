'use strict';
const { timingSafeEqual } = require('node:crypto');

// The API token never leaves this server. Fixed upstream, TTL and response shape.
const TTL_SECONDS = 600;
const DEFAULT_USD_PER_GB = 0.05; // Configured assumption, not a provider billing guarantee.
function createTurnHandler({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let windowStart = 0, requests = 0, inFlight = 0;
  function reply(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  return async function handle(req, res) {
    if (req.url !== '/turn/credentials') return false;
    if (req.method !== 'POST') { reply(res, 405, { error: 'POST required' }); return true; }
    // Native sender only; do not enable public cross-origin browser minting.
    if (req.headers.origin) { reply(res, 403, { error: 'Browser minting disabled' }); return true; }
    if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
    if (++requests > 10 || inFlight >= 2) { reply(res, 429, { error: 'Credential rate limit; retry later' }); return true; }
    const access = env.TURN_ENDPOINT_ACCESS_TOKEN || '';
    const keyId = env.CLOUDFLARE_TURN_KEY_ID || '';
    const token = env.CLOUDFLARE_TURN_API_TOKEN || '';
    const price = env.TURN_USD_PER_GB === undefined ? DEFAULT_USD_PER_GB : Number(env.TURN_USD_PER_GB);
    if (access.length < 32 || !/^[A-Za-z0-9_-]{1,128}$/.test(keyId) || !token || !Number.isFinite(price) || price < 0) {
      reply(res, 503, { error: 'TURN endpoint not configured' }); return true;
    }
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${access}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      reply(res, 401, { error: 'Invalid endpoint access token' }); return true;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) { reply(res, 415, { error: 'JSON required' }); return true; }
    inFlight++;
    try {
      let body = '', length = 0;
      req.setTimeout(10000, () => req.destroy());
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 512) { reply(res, 413, { error: 'Request too large' }); return true; }
        body += chunk.toString('utf8');
      }
      let data;
      try { data = JSON.parse(body); } catch { reply(res, 400, { error: 'Invalid JSON' }); return true; }
      if (!data || Object.keys(data).length !== 1 || !/^[A-Za-z0-9_-]{6,64}$/.test(data.session || '')) {
        reply(res, 400, { error: 'Expected only a valid session identifier' }); return true;
      }
      const issuedAt = now();
      const upstream = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS })
      });
      if (upstream.status !== 201) throw Error('Upstream status');
      let raw = '', size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 32768) throw Error('Upstream response size');
        raw += Buffer.from(chunk).toString('utf8');
      }
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload.iceServers)) throw Error('Upstream schema');
      const turn = [];
      for (const entry of payload.iceServers) {
        const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls]).filter(url => typeof url === 'string' &&
          /^(turn|turns):turn\.cloudflare\.com:(3478|443|80|5349)\?transport=(udp|tcp)$/.test(url));
        if (!urls.length) continue; // STUN is configured by the clients separately.
        if (typeof entry.username !== 'string' || !entry.username || entry.username.length > 2048 ||
            typeof entry.credential !== 'string' || !entry.credential || entry.credential.length > 2048) throw Error('Upstream credentials');
        turn.push({ urls, username: entry.username, credential: entry.credential });
      }
      if (!turn.length || turn.length > 8) throw Error('No usable TURN servers');
      reply(res, 200, { iceServers: turn, expiresAt: issuedAt + TTL_SECONDS * 1000, usdPerGb: price });
    } catch {
      // Never log/echo upstream bodies, tokens, credentials or thrown error strings.
      if (!res.headersSent && !res.destroyed) reply(res, 502, { error: 'TURN credential acquisition failed' });
    } finally { inFlight--; }
    return true;
  };
}
module.exports = { createTurnHandler, TTL_SECONDS, DEFAULT_USD_PER_GB };

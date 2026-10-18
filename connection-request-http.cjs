'use strict';
const {JoinLimit} = require('./join-limit.cjs');
const {ConnectionRequestStore, CLEANUP_MS} = require('./connection-request-store.cjs');
const ORIGIN = 'https://pairing.pradert.synology.me';
class ConnectionRequestHttp {
  constructor({store = new ConnectionRequestStore(),
    createLimit = new JoinLimit({perCode: 60, total: 60}),
    statusLimit = new JoinLimit({perCode: 120, total: 60000}),
    schedule = setInterval, cancel = clearInterval} = {}) {
    Object.assign(this, {store, createLimit, statusLimit, cancel});
    this.timer = schedule(() => store.cleanup(), CLEANUP_MS);
    this.timer.unref?.();
  }
  close() { this.cancel(this.timer); }
  async http(req, res) {
    const path = (req.url || '').split('?')[0];
    const create = path === '/connection-requests';
    const status = /^\/connection-requests\/([^/]+)\/status$/.exec(path);
    if (!create && !status) return false;
    const headers = {'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'Vary': 'Origin'};
    const reply = (code, body) => { res.writeHead(code, headers); res.end(JSON.stringify(body)); };
    const reject = code => { reply(code, {error: code === 400 ? 'invalid_request' : 'unavailable'}); req.resume(); return true; };
    const origin = req.headers.origin;
    if (origin && origin !== ORIGIN) return reject(403);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    if (req.method === 'OPTIONS') {
      const method = create ? 'POST' : 'GET';
      if (req.headers['access-control-request-method'] !== method ||
        (req.headers['access-control-request-headers'] || '').split(',').some(h => h.trim() &&
          !['content-type', 'authorization'].includes(h.trim().toLowerCase()))) return reject(403);
      headers['Access-Control-Allow-Methods'] = method;
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      res.writeHead(204, headers); res.end(); return true;
    }
    if (req.method !== (create ? 'POST' : 'GET')) return reject(405);
    // No query transport, even if a valid Authorization header is also supplied.
    if (req.url.includes('?')) return reject(400);
    if (create) {
      if (!this.createLimit.allow('create')) { headers['Retry-After'] = '60'; return reject(429); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reject(400);
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 512) return reject(400);
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Array.isArray(body) || Object.keys(body).length !== 2 || body.version !== 1 ||
          !['send', 'receive'].includes(body.initiatorRole)) return reject(400);
        const result = this.store.create(body.initiatorRole);
        reply(result.code, result.body);
      } catch { if (!res.writableEnded) reply(400, {error: 'invalid_request'}); }
    } else {
      // IDs are public identifiers; no raw authorization credentials enter limiter keys.
      const id = status[1];
      if (!this.statusLimit.allow(id.slice(0, 64))) { headers['Retry-After'] = '60'; return reject(429); }
      const authorization = req.headers.authorization;
      const match = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/.exec(authorization);
      const result = this.store.status(id, match ? match[1] : null);
      reply(result.code, result.body);
    }
    return true;
  }
}
module.exports = {ConnectionRequestHttp};

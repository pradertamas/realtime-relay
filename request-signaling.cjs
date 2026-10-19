'use strict';
const {createHash} = require('node:crypto');
const AUTH_TIMEOUT_MS = 10000;
// Owns only request-bound socket handshakes/presence. Payload relay stays in server.js.
class RequestSignaling {
  #groups = new Map();
  constructor(store, {schedule = setTimeout, cancel = clearTimeout, authTimeoutMs = AUTH_TIMEOUT_MS} = {}) {
    if (!Number.isSafeInteger(authTimeoutMs) || authTimeoutMs < 1) throw Error('Invalid auth timeout');
    Object.assign(this, {store, schedule, cancel, authTimeoutMs});
    this.unsubscribe = store.onBindingInvalidated(id => this.invalidate(id));
  }
  invalidate(id) {
    const group = this.#groups.get(id);
    if (!group) return;
    this.#groups.delete(id);
    for (const ws of group.all) { ws.close(1008, 'Unavailable'); }
  }
  attach(ws, {requestId, code, role, intent}, register) {
    let group = this.#groups.get(requestId);
    if (!group) {
      group = {all: new Set(), registered: new Map()};
      this.#groups.set(requestId, group);
    }
    group.all.add(ws);
    ws.isAlive = true;
    let participant = null, finished = false, cleaned = false;
    // Correlates with Android RequestFlow without exposing request IDs, codes or auth frames.
    const request = createHash('sha256').update(requestId).digest('hex').slice(0, 12);
    const trace = (event, reason, side = participant) => console.log(JSON.stringify({event, request, side, role, intent, ...(reason && {reason})}));
    const fail = reason => { trace('protected_auth_or_registration_failed', reason); finished = true; this.cancel(timer); ws.close(1008, 'Unavailable'); };
    const timer = this.schedule(() => fail('auth_timeout'), this.authTimeoutMs);
    timer.unref?.();
    ws.on('error', () => {});
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      finished = true; this.cancel(timer);
      trace('protected_socket_closed');
      group.all.delete(ws);
      if (participant && group.registered.get(participant) === ws) group.registered.delete(participant);
      if (!group.all.size) {
        if (this.#groups.get(requestId) === group) this.#groups.delete(requestId);
        this.store.releaseConnectedBinding(requestId, code);
      }
    };
    ws.once('close', cleanup);
    ws.once('error', cleanup);
    const authenticate = (data, binary) => {
      if (finished) return;
      let message;
      try {
        if (binary || data.length > 512) return fail('invalid_auth_frame');
        message = JSON.parse(data.toString('utf8'));
      } catch { return fail('invalid_auth_frame'); }
      if (!message || Array.isArray(message) || Object.keys(message).length !== 3 ||
        message.type !== 'request-auth' || message.requestId !== requestId || typeof message.secret !== 'string') return fail('invalid_auth_frame');
      const kind = this.store.authorizeSocket(requestId, code, message.secret, role, intent);
      if (!kind || group.registered.has(kind) || this.#groups.get(requestId) !== group) return fail('unauthorized_or_duplicate');
      trace('protected_auth_ok', null, kind);
      // The existing registration path must succeed before this participant counts.
      ws.removeListener('message', authenticate);
      this.cancel(timer);
      if (!register(ws)) return fail('registration_rejected');
      participant = kind;
      group.registered.set(kind, ws);
      finished = true;
      trace('protected_registration_ok');
      if (group.registered.size === 2) {
        if (!this.store.completeBinding(requestId)) return this.invalidate(requestId);
        for (const peer of group.registered.values()) peer.send(JSON.stringify({type: 'peer-present'}));
        trace('protected_peer_present');
        // No additional socket may join once both authenticated participants are present.
        for (const peer of group.all) if (![...group.registered.values()].includes(peer)) peer.close(1008, 'Unavailable');
      }
    };
    ws.on('message', authenticate);
  }
  close() { this.unsubscribe(); for (const id of this.#groups.keys()) this.invalidate(id); }
}
module.exports = {RequestSignaling, AUTH_TIMEOUT_MS};

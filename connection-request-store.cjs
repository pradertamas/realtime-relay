'use strict';
const {randomBytes, createHash, timingSafeEqual} = require('node:crypto');
const WAITING_MS = 300000;
const ESTABLISHMENT_MS = 120000;
const TOMBSTONE_MS = 120000;
const CLEANUP_MS = 30000;
const DEFAULT_CAPACITY = 1000;
const digest = value => createHash('sha256').update(value).digest();
function canonical(value, bytes) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) &&
    value.length === Math.ceil(bytes * 4 / 3) &&
    Buffer.from(value, 'base64url').length === bytes &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
class ConnectionRequestStore {
  #records = new Map();
  constructor({now = Date.now, capacity = DEFAULT_CAPACITY} = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000)
      throw Error('Invalid connection request capacity');
    this.now = now;
    this.capacity = capacity;
  }
  get size() { return this.#records.size; }
  #expire(record, now) {
    if (record.state === 'WAITING' && now >= record.expiresAt)
      this.#terminal(record, 'EXPIRED', record.expiresAt);
    if (record.state === 'ACCEPTED' && now >= record.connectBy)
      this.#terminal(record, 'FAILED', record.connectBy, 'establishment_timeout');
  }
  #terminal(record, state, at, failureReason) {
    record.state = state;
    record.terminalAt = at;
    if (failureReason) record.failureReason = failureReason;
  }
  #lookup(id, now) {
    if (!canonical(id, 16)) return null;
    const record = this.#records.get(id);
    if (!record) return null;
    this.#expire(record, now);
    if (record.terminalAt !== undefined && now >= record.terminalAt + TOMBSTONE_MS) {
      this.#records.delete(id); return null;
    }
    return record;
  }
  #matches(secret, hash) {
    return !!hash && (canonical(secret, 16) || canonical(secret, 32)) && timingSafeEqual(digest(secret), hash);
  }
  #unavailable() { return {code: 404, body: {error: 'unavailable'}}; }
  #view(record, now, initiator = false, privileged = true) {
    return {requestId: record.requestId, state: record.state, initiatorRole: record.initiatorRole,
      serverNow: new Date(now).toISOString(), ...(initiator && {createdAt: new Date(record.createdAt).toISOString()}),
      expiresAt: new Date(record.expiresAt).toISOString(),
      ...(privileged && record.acceptedAt !== undefined && {acceptedAt: new Date(record.acceptedAt).toISOString(), connectBy: new Date(record.connectBy).toISOString()}),
      ...(privileged && record.failureReason && {failureReason: record.failureReason})};
  }
  #gone(record, now, initiator = false, privileged = true) {
    return {code: 410, body: {error: record.state === 'EXPIRED' ? 'expired' : 'unavailable',
      ...this.#view(record, now, initiator, privileged)}};
  }
  cleanup() {
    const now = this.now();
    for (const id of this.#records.keys()) this.#lookup(id, now);
  }
  create(role) {
    if (!['send', 'receive'].includes(role)) throw Error('Invalid initiator role');
    this.cleanup();
    if (this.size >= this.capacity) return {code: 503, body: {error: 'unavailable'}};
    let requestId;
    do { requestId = randomBytes(16).toString('base64url'); } while (this.#records.has(requestId));
    const recipientCapability = randomBytes(16).toString('base64url');
    const initiatorSecret = randomBytes(32).toString('base64url');
    const createdAt = this.now(), expiresAt = createdAt + WAITING_MS;
    this.#records.set(requestId, {requestId, initiatorRole: role, state: 'WAITING',
      createdAt, expiresAt, recipientCapabilityHash: digest(recipientCapability),
      initiatorSecretHash: digest(initiatorSecret)});
    return {code: 201, body: {requestId, recipientCapability, initiatorSecret,
      state: 'WAITING', serverNow: new Date(createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString()}};
  }
  status(id, secret) {
    const now = this.now(), record = this.#lookup(id, now);
    if (!record) return this.#unavailable();
    const initiator = this.#matches(secret, record.initiatorSecretHash);
    const recipient = this.#matches(secret, record.recipientCapabilityHash);
    const claim = this.#matches(secret, record.recipientClaimHash);
    if (!initiator && !recipient && !claim) return this.#unavailable();
    if (record.terminalAt !== undefined) return this.#gone(record, now, initiator, initiator || claim);
    return {code: 200, body: this.#view(record, now, initiator, initiator || claim)};
  }
  accept(id, capability, claimSecret) {
    if (!canonical(claimSecret, 32)) return {code: 400, body: {error: 'invalid_request'}};
    // Synchronous lookup/auth/expiry/check/set: never await inside this method.
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || !this.#matches(capability, record.recipientCapabilityHash)) return this.#unavailable();
    if (record.terminalAt !== undefined) return this.#gone(record, now, false, false);
    const claimHash = digest(claimSecret);
    if (record.state === 'ACCEPTED') {
      if (!timingSafeEqual(claimHash, record.recipientClaimHash))
        return {code: 409, body: {error: 'already_accepted'}};
    } else if (record.state === 'WAITING') {
      record.recipientClaimHash = claimHash;
      record.acceptedAt = now;
      record.connectBy = now + ESTABLISHMENT_MS;
      record.state = 'ACCEPTED';
    } else return {code: 409, body: {error: 'unavailable'}};
    return {code: 200, body: this.#view(record, now)};
  }
  cancel(id, secret) {
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || !this.#matches(secret, record.initiatorSecretHash)) return this.#unavailable();
    if (record.state === 'CANCELED')
      return {code: 200, body: {requestId: id, state: record.state, serverNow: new Date(now).toISOString()}};
    if (record.terminalAt !== undefined) return this.#gone(record, now, true);
    if (!['WAITING', 'ACCEPTED'].includes(record.state)) return {code: 409, body: {error: 'unavailable'}};
    this.#terminal(record, 'CANCELED', now);
    return {code: 200, body: {requestId: id, state: record.state, serverNow: new Date(now).toISOString()}};
  }
}
module.exports = {ConnectionRequestStore, canonical, WAITING_MS, ESTABLISHMENT_MS, TOMBSTONE_MS, CLEANUP_MS, DEFAULT_CAPACITY};

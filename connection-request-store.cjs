'use strict';
const {randomBytes, createHash, timingSafeEqual} = require('node:crypto');
const WAITING_MS = 300000;
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
    if (record.state === 'WAITING' && now >= record.expiresAt) record.state = 'EXPIRED';
  }
  cleanup() {
    const now = this.now();
    for (const [id, record] of this.#records) {
      this.#expire(record, now);
      if (now >= record.expiresAt + TOMBSTONE_MS) this.#records.delete(id);
    }
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
    const unavailable = () => ({code: 404, body: {error: 'unavailable'}});
    if (!canonical(id, 16)) return unavailable();
    const now = this.now(), record = this.#records.get(id);
    if (!record) return unavailable();
    this.#expire(record, now);
    if (now >= record.expiresAt + TOMBSTONE_MS) { this.#records.delete(id); return unavailable(); }
    if (!canonical(secret, 16) && !canonical(secret, 32)) return unavailable();
    const hash = digest(secret);
    // Both comparisons use fixed-size SHA-256 digests, independent of credential length.
    const initiator = timingSafeEqual(hash, record.initiatorSecretHash);
    const recipient = timingSafeEqual(hash, record.recipientCapabilityHash);
    if (!initiator && !recipient) return unavailable();
    if (record.state === 'EXPIRED') return {code: 410, body: {error: 'expired'}};
    return {code: 200, body: {requestId: id, state: record.state, initiatorRole: record.initiatorRole,
      serverNow: new Date(now).toISOString(), ...(initiator && {createdAt: new Date(record.createdAt).toISOString()}),
      expiresAt: new Date(record.expiresAt).toISOString()}};
  }
}
module.exports = {ConnectionRequestStore, canonical, WAITING_MS, TOMBSTONE_MS, CLEANUP_MS, DEFAULT_CAPACITY};

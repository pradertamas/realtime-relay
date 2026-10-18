'use strict';
const {randomBytes, randomInt, createHash, timingSafeEqual} = require('node:crypto');
const WAITING_MS = 300000;
const ESTABLISHMENT_MS = 120000;
const TOMBSTONE_MS = 120000;
const CLEANUP_MS = 30000;
const DEFAULT_CAPACITY = 1000;
const READY_LEASE_MS = 10000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const generateCode = () => Array.from({length: 6}, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const digest = value => createHash('sha256').update(value).digest();
function canonical(value, bytes) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) &&
    value.length === Math.ceil(bytes * 4 / 3) &&
    Buffer.from(value, 'base64url').length === bytes &&
    Buffer.from(value, 'base64url').toString('base64url') === value;
}
class ConnectionRequestStore {
  #records = new Map();
  #codes = new Map();
  #invalidators = new Set();
  #codeAvailable;
  #generateCode;
  #readyLeaseMs;
  constructor({now = Date.now, capacity = DEFAULT_CAPACITY, readyLeaseMs = READY_LEASE_MS,
    codeAvailable = () => true, codeGenerator = generateCode} = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000)
      throw Error('Invalid connection request capacity');
    this.now = now;
    this.capacity = capacity;
    if (!Number.isSafeInteger(readyLeaseMs) || readyLeaseMs < 1 || readyLeaseMs > 60000) throw Error('Invalid readiness lease');
    this.#readyLeaseMs = readyLeaseMs;
    this.#codeAvailable = codeAvailable;
    this.#generateCode = codeGenerator;
  }
  get size() { return this.#records.size; }
  #expire(record, now) {
    if (record.state === 'WAITING' && now >= record.expiresAt)
      this.#terminal(record, 'EXPIRED', record.expiresAt);
    if (['ACCEPTED', 'CONNECTING'].includes(record.state) && now >= record.connectBy)
      this.#terminal(record, 'FAILED', record.connectBy, 'establishment_timeout');
  }
  #terminal(record, state, at, failureReason) {
    record.state = state;
    record.terminalAt = at;
    if (failureReason) record.failureReason = failureReason;
    if (record.binding && state !== 'CONNECTED') {
      this.#codes.delete(record.binding.sessionCode);
      for (const invalidate of this.#invalidators) invalidate(record.requestId);
    }
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
      ...(privileged && record.acceptedAt !== undefined && {
        initiatorReady: now < (record.initiatorReadyUntil ?? 0), recipientReady: now < (record.recipientReadyUntil ?? 0)}),
      ...(privileged && record.binding && ['CONNECTING', 'CONNECTED'].includes(record.state) && {
        session: this.#assignment(record, initiator)}),
      ...(privileged && record.connectedAt !== undefined && {connectedAt: new Date(record.connectedAt).toISOString()}),
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
    if (record.terminalAt !== undefined && record.state !== 'CONNECTED') return this.#gone(record, now, initiator, initiator || claim);
    return {code: 200, body: this.#view(record, now, initiator, initiator || claim)};
  }
  accept(id, capability, claimSecret) {
    if (!canonical(claimSecret, 32)) return {code: 400, body: {error: 'invalid_request'}};
    // Synchronous lookup/auth/expiry/check/set: never await inside this method.
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || !this.#matches(capability, record.recipientCapabilityHash)) return this.#unavailable();
    if (record.terminalAt !== undefined) return this.#gone(record, now, false, false);
    const claimHash = digest(claimSecret);
    if (['ACCEPTED', 'CONNECTING'].includes(record.state)) {
      if (!timingSafeEqual(claimHash, record.recipientClaimHash))
        return {code: 409, body: {error: 'already_accepted'}};
    } else if (record.state === 'WAITING') {
      record.recipientClaimHash = claimHash;
      record.acceptedAt = now;
      record.connectBy = now + ESTABLISHMENT_MS;
      record.state = 'ACCEPTED';
      record.initiatorReadyUntil = null;
      record.recipientReadyUntil = null;
    } else return {code: 409, body: {error: 'unavailable'}};
    // A capability+claim retry must not expose the initiator's assignment.
    return {code: 200, body: this.#view(record, now, false)};
  }
  cancel(id, secret) {
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || !this.#matches(secret, record.initiatorSecretHash)) return this.#unavailable();
    if (record.state === 'CANCELED')
      return {code: 200, body: {requestId: id, state: record.state, serverNow: new Date(now).toISOString()}};
    if (record.state === 'CONNECTED') return {code: 409, body: {error: 'unavailable'}};
    if (record.terminalAt !== undefined) return this.#gone(record, now, true);
    if (!['WAITING', 'ACCEPTED', 'CONNECTING'].includes(record.state)) return {code: 409, body: {error: 'unavailable'}};
    this.#terminal(record, 'CANCELED', now);
    return {code: 200, body: {requestId: id, state: record.state, serverNow: new Date(now).toISOString()}};
  }
  withdraw(id, secret) {
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || !this.#matches(secret, record.recipientClaimHash)) return this.#unavailable();
    if (record.state === 'FAILED' && record.failureReason === 'recipient_withdrew')
      return {code: 200, body: {requestId: id, state: record.state,
        failureReason: record.failureReason, serverNow: new Date(now).toISOString()}};
    if (record.state === 'CONNECTED') return {code: 409, body: {error: 'unavailable'}};
    if (record.terminalAt !== undefined) return this.#gone(record, now);
    if (!['ACCEPTED', 'CONNECTING'].includes(record.state)) return {code: 409, body: {error: 'unavailable'}};
    this.#terminal(record, 'FAILED', now, 'recipient_withdrew');
    return {code: 200, body: {requestId: id, state: record.state,
      failureReason: record.failureReason, serverNow: new Date(now).toISOString()}};
  }
  #participant(record, secret) {
    if (this.#matches(secret, record.initiatorSecretHash)) return 'initiator';
    if (this.#matches(secret, record.recipientClaimHash)) return 'recipient';
    return null;
  }
  #assignment(record, initiator) {
    return {code: record.binding.sessionCode, intent: initiator ? 'create' : 'join',
      role: initiator ? record.binding.expectedInitiatorRole : record.binding.expectedRecipientRole};
  }
  participantState(id, secret, ready) {
    if (typeof ready !== 'boolean') return {code: 400, body: {error: 'invalid_request'}};
    const now = this.now(), record = this.#lookup(id, now);
    const participant = record && this.#participant(record, secret);
    if (!participant) return this.#unavailable();
    if (record.state === 'CONNECTED') return {code: 409, body: {error: 'unavailable'}};
    if (record.terminalAt !== undefined) return this.#gone(record, now, participant === 'initiator');
    if (record.state !== 'ACCEPTED') return {code: 409, body: {error: 'unavailable'}};
    const until = ready ? now + this.#readyLeaseMs : null;
    record[`${participant}ReadyUntil`] = until;
    return {code: 200, body: {requestId: id, state: record.state, ready,
      readyUntil: until === null ? null : new Date(until).toISOString(), serverNow: new Date(now).toISOString()}};
  }
  session(id, secret) {
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || !this.#matches(secret, record.initiatorSecretHash)) return this.#unavailable();
    if (record.state === 'CONNECTED') return {code: 409, body: {error: 'unavailable'}};
    if (record.terminalAt !== undefined) return this.#gone(record, now, true);
    if (record.state === 'CONNECTING' && record.binding) return {code: 200, body: this.#view(record, now, true)};
    if (record.state !== 'ACCEPTED') return {code: 409, body: {error: 'unavailable'}};
    if (!(now < (record.initiatorReadyUntil ?? 0) && now < (record.recipientReadyUntil ?? 0)))
      return {code: 409, body: {error: 'participants_not_ready'}};
    let code;
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = this.#generateCode();
      if (/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(candidate) && !this.#codes.has(candidate) && this.#codeAvailable(candidate)) {
        code = candidate; break;
      }
    }
    if (!code) return {code: 503, body: {error: 'unavailable'}};
    const sender = record.initiatorRole === 'send';
    record.binding = {sessionCode: code, bindingCreatedAt: now,
      expectedInitiatorRole: sender ? 'sender' : 'receiver', expectedRecipientRole: sender ? 'receiver' : 'sender'};
    this.#codes.set(code, id);
    record.state = 'CONNECTING';
    return {code: 200, body: this.#view(record, now, true)};
  }
  boundRequestId(code) {
    const id = this.#codes.get(code);
    if (id) this.#lookup(id, this.now()); // Lazy failure also invalidates sockets/binding.
    return this.#codes.get(code) || null;
  }
  authorizeSocket(id, code, secret, role, intent) {
    const record = this.#lookup(id, this.now());
    if (!record || record.state !== 'CONNECTING' || record.binding?.sessionCode !== code || this.#codes.get(code) !== id) return null;
    const participant = this.#participant(record, secret);
    if (!participant) return null;
    const assignment = this.#assignment(record, participant === 'initiator');
    return assignment.role === role && assignment.intent === intent ? participant : null;
  }
  completeBinding(id) {
    const now = this.now(), record = this.#lookup(id, now);
    if (!record || record.state !== 'CONNECTING') return false;
    record.connectedAt = now;
    this.#terminal(record, 'CONNECTED', now);
    return true;
  }
  releaseConnectedBinding(id, code) {
    const record = this.#lookup(id, this.now());
    if ((!record || record.state === 'CONNECTED') && this.#codes.get(code) === id) this.#codes.delete(code);
  }
  onBindingInvalidated(listener) { this.#invalidators.add(listener); return () => this.#invalidators.delete(listener); }
}
module.exports = {ConnectionRequestStore, canonical, WAITING_MS, ESTABLISHMENT_MS, TOMBSTONE_MS, CLEANUP_MS, DEFAULT_CAPACITY, READY_LEASE_MS};

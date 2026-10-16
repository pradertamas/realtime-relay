'use strict';

// Public relay only. Random, ephemeral sessions avoid interfering with other users.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { WebSocket } = require('ws');

const RELAY = 'wss://realtime-relay-k28l.onrender.com/ws';
const OPEN_TIMEOUT = 60000; // Allow a Render cold start.
const MESSAGE_TIMEOUT = 10000;
const clients = [];
let checkName = 'initialization';

function address(session, role) {
  return `${RELAY}?session=${encodeURIComponent(session)}&role=${role}`;
}

function client(session, role) {
  const ws = new WebSocket(address(session, role), { handshakeTimeout: OPEN_TIMEOUT });
  // Every socket keeps an inbox so unexpected/early deliveries cannot be missed.
  const peer = { ws, inbox: [], failure: null };
  ws.on('message', (data, binary) => peer.inbox.push({ data, binary }));
  ws.on('error', error => { peer.failure = error; });
  clients.push(peer);
  return peer;
}

async function open(session, role) {
  const peer = client(session, role);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(Error('WebSocket open timed out')), OPEN_TIMEOUT + 1000);
    const onOpen = () => done();
    const onError = error => done(error);
    const onClose = code => done(Error(`WebSocket closed before open (${code})`));
    const onResponse = (_, response) => {
      response.resume();
      done(Error(`Unexpected HTTP ${response.statusCode} during registration`));
      peer.ws.terminate();
    };
    function done(error) {
      clearTimeout(timer);
      peer.ws.off('open', onOpen).off('error', onError).off('close', onClose)
        .off('unexpected-response', onResponse);
      if (error) reject(error); else resolve();
    }
    peer.ws.once('open', onOpen).once('error', onError).once('close', onClose)
      .once('unexpected-response', onResponse);
  });
  return peer;
}

async function waitFor(predicate, timeout, detail) {
  const started = Date.now();
  while (!predicate()) {
    for (const peer of clients) {
      if (peer.failure) throw peer.failure;
      if (peer.ws.readyState !== WebSocket.OPEN) throw Error('A registered peer disconnected');
    }
    if (Date.now() - started >= timeout) throw Error(detail);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function transfer(from, to, payload) {
  assert.equal(to.inbox.length, 0, 'Unexpected message already in destination inbox');
  const raw = JSON.stringify(payload);
  await new Promise((resolve, reject) => from.ws.send(raw, error => error ? reject(error) : resolve()));
  await waitFor(() => to.inbox.length > 0, MESSAGE_TIMEOUT,
    'No message received within 10 seconds; verify bidirectional forwarding is deployed');
  const received = to.inbox.shift();
  assert.equal(received.binary, false, 'JSON arrived as binary');
  assert.deepEqual(received.data, Buffer.from(raw, 'utf8'), 'Payload bytes changed');
}

async function expectRejected(session, role, expected) {
  // Rejected clients are not part of the registered-peer health checks.
  const ws = new WebSocket(address(session, role), { handshakeTimeout: OPEN_TIMEOUT });
  ws.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(Error('HTTP rejection timed out')), OPEN_TIMEOUT + 1000);
      const onOpen = () => done(Error(`Registration succeeded; expected HTTP ${expected}`));
      const onError = error => done(error);
      const onClose = code => done(Error(`Closed (${code}) without expected HTTP ${expected}`));
      const onResponse = (_, response) => {
        response.resume();
        done(response.statusCode === expected ? null :
          Error(`Expected HTTP ${expected}, received HTTP ${response.statusCode}`));
      };
      function done(error) {
        clearTimeout(timer);
        ws.off('open', onOpen).off('error', onError).off('close', onClose)
          .off('unexpected-response', onResponse);
        if (error) reject(error); else resolve();
      }
      ws.once('open', onOpen).once('error', onError).once('close', onClose)
        .once('unexpected-response', onResponse);
    });
  } finally { ws.terminate(); }
}

async function check(name, fn) {
  checkName = name;
  await fn();
  console.log(`PASS ${name}`);
}

async function main() {
  const suffix = randomBytes(16).toString('hex');
  const session = `remote_a_${suffix}`, isolatedSession = `remote_b_${suffix}`;
  let sender, receiver, isolatedSender, isolatedReceiver;
  await check('sender + receiver registration in the same session', async () => {
    sender = await open(session, 'sender');
    receiver = await open(session, 'receiver');
    isolatedSender = await open(isolatedSession, 'sender');
    isolatedReceiver = await open(isolatedSession, 'receiver');
  });
  const ice = direction => ({ type: 'ice', candidate: {
    candidate: `candidate:${direction} 1 udp 2122260223 192.0.2.1 50000 typ host`,
    sdpMid: '0', sdpMLineIndex: 0
  } });
  await check('ready receiver -> sender; unchanged payload', () => transfer(receiver, sender, { type: 'ready' }));
  await check('offer sender -> receiver; unchanged payload', () => transfer(sender, receiver,
    { type: 'offer', sdp: 'v=0\r\ns=remote-signaling-test\r\n', probe: '\u00e1\u2192\u2713' }));
  await check('answer receiver -> sender; unchanged payload', () => transfer(receiver, sender,
    { type: 'answer', sdp: 'v=0\r\ns=answer-test\r\n' }));
  await check('ICE sender -> receiver; unchanged payload', () => transfer(sender, receiver, ice('sender')));
  await check('ICE receiver -> sender; unchanged payload', () => transfer(receiver, sender, ice('receiver')));
  await check('session isolation in both directions', async () => {
    // Other-session traffic must reach its own opposite role, never either primary peer.
    assert.equal(isolatedSender.inbox.length, 0, 'Primary traffic leaked to isolated sender');
    assert.equal(isolatedReceiver.inbox.length, 0, 'Primary traffic leaked to isolated receiver');
    await transfer(isolatedSender, isolatedReceiver, { type: 'ready', probe: 'isolated-forward' });
    await transfer(isolatedReceiver, isolatedSender, { type: 'ready', probe: 'isolated-reverse' });
    // Allow delayed unexpected deliveries to arrive before checking every inbox.
    await new Promise(resolve => setTimeout(resolve, 1000));
    for (const peer of clients) {
      assert.equal(peer.ws.readyState, WebSocket.OPEN, 'Peer disconnected during isolation check');
      assert.equal(peer.inbox.length, 0, 'Message leaked across sessions or was duplicated/echoed');
    }
  });
  await check('duplicate sender role rejected with HTTP 409', () => expectRejected(session, 'sender', 409));
  await check('duplicate receiver role rejected with HTTP 409', () => expectRejected(session, 'receiver', 409));
  console.log('PASS remote signaling');
}

main().catch(error => {
  console.error(`FAIL remote signaling: ${checkName}: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  for (const { ws } of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, 'Remote signaling verification complete');
      const timer = setTimeout(() => ws.terminate(), 1000);
      timer.unref();
      ws.once('close', () => clearTimeout(timer));
    } else ws.terminate();
  }
});

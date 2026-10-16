'use strict';

const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_CLIENTS = 1000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const sessions = new Map();
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'realtime-relay' }));
    return;
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
});

function log(event, session = null, role = null, reason = undefined) {
  // Session IDs are short-lived pairing secrets; never put them in application logs.
  console.log(JSON.stringify({ event, role, ...(reason && { reason }) }));
}

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  let sessionId = null;
  let role = null;
  function reject(status, reason) {
    log('connection rejected', sessionId, role, reason);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  let url;
  try {
    if (!req.url.startsWith('/') || /%(?![0-9a-f]{2})/i.test(req.url)) {
      throw new Error('Invalid URL');
    }
    url = new URL(req.url, 'http://localhost');
  } catch {
    reject('400 Bad Request', 'invalid URL');
    return;
  }
  const candidateSession = url.searchParams.get('session');
  const candidateRole = url.searchParams.get('role');
  const intent = url.searchParams.get('intent');
  if (intent !== null && (!['create', 'join'].includes(intent) || url.searchParams.getAll('intent').length !== 1)) {
    reject('400 Bad Request', 'invalid intent'); return;
  }
  // Only validated identifiers enter session storage; they never enter logs.
  if (/^[A-Za-z0-9_-]{6,64}$/.test(candidateSession || '')) sessionId = candidateSession;
  if (candidateRole === 'sender' || candidateRole === 'receiver') role = candidateRole;
  if (url.pathname !== '/ws') {
    reject('404 Not Found', 'unknown endpoint');
    return;
  }
  if (!sessionId || !role || url.searchParams.getAll('session').length !== 1 ||
      url.searchParams.getAll('role').length !== 1) {
    reject('400 Bad Request', 'invalid session or role');
    return;
  }
  // Legacy diagnostic sessions cannot enter explicit pairing sessions.
  if (!intent && (sessions.get(sessionId)?.[role] || sessions.get(sessionId)?.creator)) {
    reject('409 Conflict', 'role occupied');
    return;
  }
  if (wss.clients.size >= MAX_CLIENTS) {
    reject('503 Service Unavailable', 'capacity reached');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const existing = sessions.get(sessionId);
    if (intent) {
      const status = intent === 'create' ? (existing ? 'conflict' : 'ok') :
        !existing?.creator || existing.creator.readyState !== WebSocket.OPEN ? 'not-found' : existing[role] || existing.paired ? 'role-occupied' : 'ok';
      if (status !== 'ok') {
        ws.on('error', () => {});
        ws.send(JSON.stringify({ type: 'registration', status, intent, role }));
        ws.close(1008, status); return;
      }
    }
    const session = sessions.get(sessionId) || {};
    sessions.set(sessionId, session);
    session[role] = ws;
    if (intent === 'create') session.creator = ws;
    if (intent === 'join') session.paired = true;
    ws.isAlive = true;
    log('connection accepted', sessionId, role);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (session[role] === ws) delete session[role];
      if (session.creator) {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
        const other = session[role === 'sender' ? 'receiver' : 'sender'];
        if (other?.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({type:'peer-left'})); other.close(1000, 'Pairing ended');
        }
      } else if (!session.sender && !session.receiver) sessions.delete(sessionId);
      log('connection closed', sessionId, role);
    }
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', cleanup);
    ws.on('error', () => {
      cleanup();
      ws.terminate();
    });
    ws.on('message', (data, isBinary) => {
      if (cleaned) return;
      const receiver = session[role === 'sender' ? 'receiver' : 'sender'];
      if (!receiver || receiver.readyState !== WebSocket.OPEN) return;
      if (receiver.bufferedAmount + data.length > MAX_BUFFERED_BYTES) {
        receiver.terminate();
        return;
      }
      receiver.send(data, { binary: isBinary }, (error) => {
        if (error) receiver.terminate();
      });
    });
    if (intent) ws.send(JSON.stringify({type:'registration',status:'ok',intent,role}));
    if (intent === 'join') {
      for (const peer of [session.sender, session.receiver]) {
        if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({type:'peer-present'}));
      }
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping(undefined, undefined, (error) => {
      if (error) ws.terminate();
    });
  }
}, 30000);
heartbeat.unref();

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.on('error', (error) => {
  log('server error', null, null, error.code || 'listen failed');
  shutdown();
  process.exitCode = 1;
});
server.listen(PORT, '0.0.0.0', () => log('server start', null, null, `port ${PORT}`));

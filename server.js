'use strict';

const http = require('node:http');
const {isUtf8} = require('node:buffer');
const { WebSocket, WebSocketServer } = require('ws');
const { JoinLimit } = require('./join-limit.cjs');
const { RemotePresence, DEFAULT_ORIGINS } = require('./remote-presence.cjs');
const {ConnectionRequestHttp} = require('./connection-request-http.cjs');
const {ConnectionRequestStore} = require('./connection-request-store.cjs');
const {RequestSignaling} = require('./request-signaling.cjs');

function createRelay({port = process.env.PORT || 10000, requestOptions = {}, authOptions = {}} = {}) {
const joinLimit = new JoinLimit();
const remote = new RemotePresence({origins:[...DEFAULT_ORIGINS,...(process.env.REMOTE_ALLOWED_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean)]});
const PORT = port;
const MAX_CLIENTS = 1000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const sessions = new Map();
const requestStore = new ConnectionRequestStore({...requestOptions, codeAvailable: code => !sessions.has(code)});
const requests = new ConnectionRequestHttp({store: requestStore});
const requestSignaling = new RequestSignaling(requestStore, authOptions);
const server = http.createServer(async (req, res) => {
  if(await requests.http(req,res))return;
  if(await remote.http(req,res))return;
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
  const boundRequestId = requestStore.boundRequestId(sessionId);
  if (boundRequestId && ([...url.searchParams.keys()].some(key => !['session','role','intent'].includes(key)) || !intent)) {
    reject('400 Bad Request', 'invalid registration'); return;
  }
  // Legacy diagnostic sessions cannot enter explicit pairing sessions.
  if (!boundRequestId && !intent && (sessions.get(sessionId)?.[role] || sessions.get(sessionId)?.creator)) {
    reject('409 Conflict', 'role occupied');
    return;
  }
  if (wss.clients.size >= MAX_CLIENTS) {
    reject('503 Service Unavailable', 'capacity reached');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const register = (ws, protectedRequest = false) => {
    const existing = sessions.get(sessionId);
    if (intent) {
      // Only RequestSignaling can call this path after exact request/assignment auth.
      // A protected JOIN may register first while the sender awaits system consent.
      // Its room is reserved by requestStore; the later authenticated creator adopts it.
      const waitingRequest = protectedRequest && existing?.requestBound && !existing.creator && !existing[role];
      const status = !protectedRequest && intent === 'join' && !joinLimit.allow(sessionId) ? 'rate-limited' : intent === 'create' ?
        (existing && !waitingRequest ? 'conflict' : 'ok') : protectedRequest ?
        (existing?.[role] || existing?.paired ? 'role-occupied' : 'ok') :
        !existing?.creator || existing.creator.readyState !== WebSocket.OPEN ? 'not-found' : existing[role] || existing.paired ? 'role-occupied' : 'ok';
      if (status !== 'ok') {
        ws.on('error', () => {});
        ws.send(JSON.stringify({ type: 'registration', status, intent, role }));
        ws.close(1008, protectedRequest ? 'Unavailable' : status); return false;
      }
    }
    const session = sessions.get(sessionId) || {};
    sessions.set(sessionId, session);
    session[role] = ws;
    if (intent === 'create') session.creator = ws;
    if (intent === 'join') session.paired = true;
    if (protectedRequest) session.requestBound = true;
    if (intent === 'join') remote.remove(session.creator);
    ws.isAlive = true;
    log('connection accepted', sessionId, role);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      remote.remove(ws);
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
      // Inspect JSON within the existing 64 KiB WS limit regardless of transport.
      // Invalid UTF-8/JSON binary payloads retain their opaque forwarding semantics.
      let message;
      try { if (!isBinary || isUtf8(data)) message = JSON.parse(data.toString('utf8')); } catch {}
      // Auth is text-only before registration; after registration it is always invalid control.
      if (message?.type === 'request-auth') { ws.close(1008, 'Unavailable'); return; }
      if(!isBinary){
        if(typeof message?.type==='string'&&message.type.startsWith('remote-presence-')){
          let status='denied';
          if(!protectedRequest && message.type==='remote-presence-remove'){remote.remove(ws);status='removed';}
          else if(!protectedRequest && message.type==='remote-presence-register'&&role==='sender'&&intent==='create')status=remote.register(ws,message.token,session,sessionId);
          ws.send(JSON.stringify({type:'remote-presence',status}));return;
        }
      }
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
    if (intent) ws.send(JSON.stringify({type:'registration',status:'ok',intent,role,remotePresence:!protectedRequest}));
    if (intent === 'join' && !protectedRequest) {
      for (const peer of [session.sender, session.receiver]) {
        if (peer?.readyState === WebSocket.OPEN) peer.send(JSON.stringify({type:'peer-present'}));
      }
    }
    return true;
    };
    if (boundRequestId) {
      requestSignaling.attach(ws, {requestId: boundRequestId, code: sessionId, role, intent}, peer => register(peer, true));
    } else if (sessions.get(sessionId)?.requestBound || requestStore.boundRequestId(sessionId)) {
      ws.on('error', () => {}); ws.close(1008, 'Unavailable');
    } else register(ws);
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
  requestSignaling.close();
  requests.close();
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
}
server.on('error', (error) => {
  log('server error', null, null, error.code || 'listen failed');
  shutdown();
  process.exitCode = 1;
});
return {server, requestStore, requests, shutdown,
  start() { server.listen(PORT, '0.0.0.0', () => log('server start', null, null, `port ${server.address().port}`)); }};
}
module.exports = {createRelay};
if (require.main === module) {
  const relay = createRelay();
  process.on('SIGTERM', relay.shutdown);
  process.on('SIGINT', relay.shutdown);
  relay.start();
}

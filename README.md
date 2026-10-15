# realtime-relay

A minimal generic WebSocket relay using Node.js and `ws`. No database or frontend.

Requires Node.js 22 or 24 and npm. Install and run locally:

```sh
npm install
npm start
```

The server listens on `0.0.0.0`, using `PORT` or `10000` by default.

`GET /` is a health/wake-up endpoint returning:

```json
{"status":"ok","service":"realtime-relay"}
```

Connect using `/ws?session=<sessionId>&role=<role>`. A session ID must contain
6–64 ASCII letters, digits, hyphens, or underscores. Valid roles are `sender`
and `receiver`; each query parameter must occur exactly once.

Example URLs:

```text
ws://localhost:10000/ws?session=sample_123&role=sender
ws://localhost:10000/ws?session=sample_123&role=receiver
```

Each session allows one sender and one receiver. Duplicate roles are rejected
with HTTP 409; invalid parameters with HTTP 400. Only sender messages reach the
receiver in the same session. Text/binary type and payload bytes are preserved.
Receiver messages are ignored. Messages without a connected receiver are dropped.

Sessions are ephemeral and stored only in memory. Disconnections remove the
client; empty sessions are deleted. There is no message history or replay.
Restarts erase all sessions. Clients must reconnect as needed.

Incoming messages are limited to 64 KiB. Ping/pong checks run every 30 seconds;
unresponsive clients are terminated at the following check. Slow receivers are
disconnected when their pending output would exceed 1 MiB. The service accepts
at most 1,000 concurrent clients (HTTP 503 at capacity). No payloads are logged.

For Render, create a Web Service from this repository with build command
`npm ci` and start command `npm start`. Select Node.js 24 (for example through
`NODE_VERSION=24`); the package also supports Node.js 22. Render supplies `PORT`.
Use `/` as the health check path and `wss://<service-host>/ws?...` for clients.
Use a single instance: in-memory sessions are not shared between instances.

The session identifier is the only access boundary; anyone who knows it can
occupy an available role. Use unpredictable IDs and HTTPS/WSS outside local
development. This proof of concept does not provide authentication.

# realtime-relay

Release: two-way WebRTC signaling for direct P2P screen sharing and six-character
pairing codes. Video travels directly over WebRTC, never through this WebSocket.
No TURN/Cloudflare dependency, credential route or secret environment variables
are part of the active server. GET/POST /turn/credentials return 404.

## Run

Node.js 22 or 24 and npm:

```text
npm ci
npm start
```

PORT defaults to 10000. GET / returns the JSON health response. Render uses
npm ci / npm start, the existing HTTPS/WSS domain and one service instance.
No commit, push or deployment was performed by this cleanup.

## Explicit CREATE / JOIN pairing

Normal pairing clients connect to `/ws?session=<CODE>&role=<role>&intent=create`
or `intent=join`. CREATE reserves an entirely unused code, regardless of role;
JOIN requires a live creator and the opposite role. JSON `registration` status
is `ok`, `conflict`, `not-found` or `role-occupied`; rejected explicit sockets
close with 1008 after the response. On the second success both peers receive
`peer-present`. Android always creates the offer, even when browser created first.
Closing either participant deletes the pairing and closes/notifies the survivor.
CREATE conflicts are retried by clients at most four registrations total.

Automatic pairing adds one rejection status: `rate-limited` (close 1008).
`join-limit.cjs` uses a 60-second fixed window, 12 JOIN attempts per exact code
and 120 JOIN attempts total per process. All JOINs count, including not-found.
CREATE and legacy diagnostics are unaffected. Counters are bounded to at most
120 code entries per window and never logged. No new environment variables.

The repo contains no trusted proxy/IP configuration proving the deployed Render
forwarding chain. We deliberately do not treat arbitrary X-Forwarded-For or the
load balancer socket address as a verified client identity. The limits are
code-scoped plus global, not per-user/IP protection; distributed guesses and
global-budget denial of service remain limitations. In a larger deployment the
global budget needs sizing and trusted edge limits. This is a minimal single
instance PoC safeguard, not production abuse prevention. Header trust background:
https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1 .

The new relay and both clients must be released together. An old relay without
intent handling does not provide these strict reservation semantics.

## Signaling and legacy diagnostics

Legacy diagnostic clients may still use /ws?session=<id>&role=sender or role=receiver.
These cannot enter explicit pairing sessions and explicit JOIN cannot enter a
legacy diagnostic session. IDs contain 6-64 ASCII
letters, digits, underscores or hyphens. The normal client generates six random
characters from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ and uses that code as the ID.
Each session permits one sender and one receiver; duplicates return HTTP 409,
invalid parameters HTTP 400. Each peer's payload is forwarded unchanged only
to the opposite role in the same session. Missing peers mean dropped messages.
The clients use ready, offer, answer, trickle ICE and bye; no video payloads.

Sessions exist only in memory; empty sessions disappear. There is no session
listing, directory, history, account or persistent storage. The code is the
access boundary: keep it private and use a fresh code for every share.

Input limit: 64 KiB; output backpressure limit: 1 MiB; capacity: 1000 clients;
heartbeat: every 30 seconds. Unresponsive clients are terminated. Application
logs contain event/role/reason, never payloads or session/pairing identifiers.
Infrastructure access logs must also avoid retaining WebSocket query strings.

## Checks

```text
node --check server.js
node verify-signaling.cjs
node verify-pairing-privacy.cjs
node verify-symmetric-pairing.cjs
node verify-join-limit.cjs
node verify-remote-presence.cjs
```

These use isolated local processes. The optional verify-remote-signaling.cjs
checks the public WSS service only when run explicitly; cleanup does not run it.

The historical, inactive PoC 4B TURN experiment is preserved exclusively under
experiments/poc4b/. It is not imported by server.js and is not a release asset.

## Persistent remote link presence (local, not deployed here)

Successful explicit registrations now advertise `remotePresence:true`. The
Android transport latches the first response before sending any persistent
secret, avoiding token forwarding through an older opaque-only relay.

`remote-presence-register` with a canonical 22-character Base64URL/128-bit token
is accepted only from a live sender CREATE creator, unpaired/without receiver.
Only normal six-character pairing sessions may publish presence. The server
consumes this reserved control type; it never forwards it to the opposite peer.
Reply: `{type:"remote-presence",status:"registered"}` (or denied/conflict).
`remote-presence-remove` removes this socket's mapping. A socket has at most one
mapping; registering a replacement synchronously removes the old hash. No DB,
expiry or persistent device directory. `remote-presence.cjs` stores
SHA-256(token) -> {ws, session, sessionId} plus a weak socket -> hash index.
Keys disappear on disconnect, session cleanup or successful receiver JOIN,
before consent/streaming. Rotation is a new sender registration; Android
publishes the same installation token again. Resolve also validates live state.

`POST /remote/resolve`, JSON `{token:...}` (512-byte body limit):
200 `{status:"available",session:"<CODE>"}` for waiting presence;
404 `{status:"unavailable"}` for unknown/offline/busy/consumed presence.
Invalid JSON/token -> 400, oversized -> 413, other method -> 405, throttled ->
429; all use a generic unavailable body and Cache-Control:no-store. There is
no GET/query-token API. Logs never contain request bodies, URLs or tokens.

CORS allows https://pradertamas.github.io, http://localhost:8080 and
http://127.0.0.1:8080. POST and OPTIONS preflight support Content-Type only;
other origins get 403. No-Origin server clients can call with the bearer token;
CORS is not authentication. Optional `REMOTE_ALLOWED_ORIGINS` adds comma-separated
exact http(s) origins for Render/local environment configuration; no wildcard.
The default needs no new environment variables and no API/master credential.

Resolve uses separate in-memory 60-second fixed-window limits: 240 requests
globally per instance and 20 per token hash. Invalid bodies count against the
global budget; at most 240 distinct hash keys per token-limit window. Existing
JOIN limits are unchanged. Neither limiter trusts unverified proxy/IP headers.
The global budget can limit shared traffic; this is PoC abuse protection, not
per-user identity or production DoS prevention. No resolve directory/list API.

Manually deploy server.js + remote-presence.cjs + existing join-limit.cjs after
review; updated Android/web clients are also required for the feature. Do not
expect remote links to work against an older deployment. The privacy verify
still requires GET/POST /turn/credentials to return 404. No TURN endpoint added.

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
```

These use isolated local processes. The optional verify-remote-signaling.cjs
checks the public WSS service only when run explicitly; cleanup does not run it.

The historical, inactive PoC 4B TURN experiment is preserved exclusively under
experiments/poc4b/. It is not imported by server.js and is not a release asset.

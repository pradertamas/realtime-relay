# Authenticated request JOIN before CREATE

`verify-request-join-first.cjs` reproduced the pre-fix failure at the real local
HTTP/WebSocket boundary: SEND request, Accept, both ready, assigned recipient JOIN
arriving before initiator CREATE returned `registration.status = not-found`.
The assertion expecting `ok` was RED before production changes.

`server.js` now permits only the protected registration path, reached after
`RequestSignaling` verifies the exact request, secret, role and intent, to install
a JOIN participant before its creator. Registration `ok` means authenticated local
readiness, not peer presence. The room is request-bound; the later authenticated
creator adopts it. Neither side receives `peer-present` until both registrations
succeed and `completeBinding` transitions the request to CONNECTED. Payload relay
and Android sender-offerer/receiver-answerer behavior are unchanged.

This is not an anonymous pending-code feature. Legacy manual JOIN still requires
an existing open creator; missing codes still return `not-found`. Request-store
code reservation prevents unrelated legacy adoption. Existing participant auth,
duplicate rejection, bounded client capacity, 10-second unauthenticated timeout,
connectBy invalidation and 30-second store cleanup continue to apply. No request
deadline is extended. Cancel/withdraw/expiry close pending sockets. Disconnect
removes the pending participant and empty room. Late CREATE cannot revive an
expired or withdrawn request. No reconnect, delay or retry loop is introduced.

The regression covers both media-role directions, duplicate pending JOIN, delayed
creator arrival, offer/answer/ICE forwarding, invalid manual JOIN, capability and
wrong/cross-request auth, disconnect/replacement, connectBy cleanup, Cancel and
withdraw. Existing suites cover CREATE-first and legacy behavior. Fake request
time advances by 20 seconds before CREATE; message events determine protocol
order, not a sleep. This is signaling coverage, not a real WebRTC first-frame test.

Protected lifecycle logs contain fixed event/reason values, side, role, intent and
the first 12 hex characters of SHA-256(requestId), matching Android diagnostics.
They contain no raw request ID, capability, participant secret, code, URL or frame.

A new Render deployment of this relay revision is required for phone validation.
No deployment or physical validation is part of this change. Existing public
remote smoke tests check the deployed legacy relay only, not this local fix.

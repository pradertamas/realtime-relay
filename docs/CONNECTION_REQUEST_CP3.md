# CP3: readiness and protected signaling

The V1 contract is unchanged. CP3 implements only relay HTTP/control-plane and
protected registration. No Android/web client or SDP/ICE/media implementation is
changed. Production is not deployed here.

## Readiness and HTTP contracts

POST /connection-requests/:id/participant-state uses initiatorSecret or winning
recipientClaimSecret Bearer. JSON contains exactly {"ready":true} or {"ready":false}
(512-byte body limit). Capability/unknown/wrong-scope auth gets generic 404.
Only ACCEPTED allows mutation; WAITING/CONNECTING/CONNECTED get 409, other terminal
records get authenticated 410. Response: requestId, state, ready, readyUntil
(ISO UTC or null), serverNow. True renews the caller's lease; false clears it.

READY_LEASE_MS defaults to 10000. Store construction may configure a positive safe
integer lease up to 60000 ms; no production environment change is introduced.
Each accepted record holds nullable initiatorReadyUntil/recipientReadyUntil, not
permanent ready flags. now >= readyUntil means not-ready. Lease expiry does not
fail, cancel or expire the request. Privileged status computes initiatorReady and
recipientReady from server time. Capability status reveals neither readiness nor
assignments. Renew approximately every 2s while foreground; no background heartbeat.

POST /connection-requests/:id/session uses initiatorSecret Bearer and an empty body
or JSON {}. Role, intent and recipient are never caller-selected in this HTTP
operation. Both leases must be valid on an unexpired ACCEPTED request, otherwise
409 participants_not_ready. Success atomically reserves a code and sets CONNECTING.
Repeated initiator POST in CONNECTING returns the identical assignment/deadline,
even after readiness leases expire. No new establishment window is started.

Status/session response includes requestId, state, serverNow, connectBy and own
session {code,intent,role}, in addition to scoped metadata. Initiator gets CREATE;
claim gets JOIN. Capability never receives a code or setup assignment. Accept
same-claim retry in CONNECTING remains idempotent and returns only the winner's
JOIN assignment, not initiator rights. Credentials/hashes are never returned.

Independent fixed-minute JoinLimit budgets (no forwarded-IP trust):

| Operation | Per request ID/min | Global/min |
| --- | --- | --- |
| participant-state | 180 | 60000 |
| session | 30 | 6000 |

429 has Retry-After: 60. Earlier create/status/Accept/Cancel budgets are unchanged.
CORS remains exact NAS origin, appropriate POST preflight, Content-Type and
Authorization only. Shared-ID/global budget denial of service remains a limitation.

## Code reservation and role mapping

The relay generates six cryptographically random characters from
23456789ABCDEFGHJKLMNPQRSTUVWXYZ using crypto.randomInt. At most 16 candidates are
tried, excluding both active legacy session codes and existing protected bindings.
Failure returns 503 and leaves ACCEPTED. Reservation/check/set is synchronous.
Binding metadata: sessionCode, bindingCreatedAt, expectedInitiatorRole,
expectedRecipientRole. Exactly one binding per request; connectBy is unchanged.

| initiatorRole | Initiator assignment | Winning recipient assignment |
| --- | --- | --- |
| send | sender / create | receiver / join |
| receive | receiver / create | sender / join |

SEND remains offerer; RECEIVE remains answerer. Assignment is not MediaProjection
consent and registration completion is not proof that media works.

## Client WebSocket contract (CP5-CP10)

1. Create/Accept request and refresh participant readiness through HTTP.
2. Initiator POSTs session; each party obtains its own assignment via status.
3. Open the existing /ws?session=<code>&role=<role>&intent=<create|join> endpoint.
   These are the only permitted query keys for a protected code. No secret, token,
   auth header substitute or request secret belongs in a WebSocket URL.
4. Before any signaling, send exactly this small UTF-8 text JSON (max 512 bytes):

   {"type":"request-auth","requestId":"<id>","secret":"<participant-secret>"}

   Initiator supplies initiatorSecret, recipient supplies recipientClaimSecret.
   The relay stores hashes only; no additional setup token exists.
5. Await existing registration status ok (remotePresence:false for protected
   registration). Open alone gives no registration, session membership or peer event.
6. Both registered participants receive the existing peer-present event. Existing
   SDP/ICE/bye payload relay then operates unchanged. Do not resend request-auth.

The server verifies request ID, live CONNECTING binding/code, connectBy, participant
secret, role and intent. Capability, swapped participant secrets, wrong role/intent
and wrong IDs fail. Unauthenticated SDP/ICE/bye, binary/oversized/malformed/extra-field
auth frames fail closed; they never forward. Failure closes with 1008 Unavailable.
Auth timeout is 10000 ms (injectable scheduler/options in tests), separate from the
user setup deadline. Close/error clears its timer. Duplicate authenticated
participants are rejected. Creator must register before JOIN succeeds; an early
recipient may retry its own assignment after the creator is ready, within connectBy.
No new token, request, binding or deadline is generated for that retry.

Secret-bearing control frames are never forwarded, even if accidentally sent over
a legacy/previously authenticated socket. Protected sessions cannot publish legacy
remote-device presence. Logs never dump auth frames, URLs or credentials.

## Completion, reconnect and cleanup

CONNECTING means binding exists, not that either socket has registered. Only one
registered participant leaves CONNECTING. Once both authorized participants have
successfully registered, the request becomes CONNECTED and records connectedAt;
peer-present follows. This means signaling rendezvous completed, not first video
frame, capture success or video quality. Privileged CONNECTED status is 200 during
its 120-second setup tombstone and includes connectedAt/own assignment. Capability
receives minimal state only. Cancel/participant-state/session after CONNECTED is 409.

Before CONNECTED, a participant socket close preserves CONNECTING and its reserved
code until connectBy. The same authorized participant may re-register after cleanup;
JOIN still requires the creator. Readiness is no longer required after binding.
No new registrations/reconnect after CONNECTED are supported in V1; use existing
media Stop/disconnect and a new request for a new rendezvous.

CONNECTING timeout becomes FAILED/establishment_timeout lazily or through periodic
cleanup. Cancel in CONNECTING becomes CANCELED. Both invalidate the reservation,
close pending/authenticated setup sockets and reject subsequent request-auth.
Existing socket session cleanup is not allowed to delete the HTTP request. A code
may be reused later, but an old request ID/secret cannot authorize that new binding.

After CONNECTED, socket/media closure does not rewrite the request. The existing
peer-left/session cleanup still ends the signaling pair. Terminal request cleanup
must not kill running media: the protected code reservation survives removal of
the CONNECTED request tombstone until all its sockets have closed. It cannot
downgrade to unauthenticated legacy admission while active. No permanent code
reservation remains after media socket cleanup.

## Legacy compatibility and testing seam

Unreserved codes retain existing immediate legacy CREATE/JOIN, diagnostic mode,
peer-present/peer-left, payload relay, remote resolve and cleanup without auth.
The code reservation gate runs before legacy registration, so legacy callers of
a protected code are instead required to authenticate. Secret/control frames are
reserved; normal legacy signaling messages remain unchanged.

server.js exports createRelay with injected request clock/code generator and auth
timer options for deterministic local integration tests. Direct node server.js
still starts the same server with the existing defaults and SIGINT/SIGTERM cleanup;
requiring the module does not start a listener or install process signal handlers.

verify-request-signaling.cjs covers fake-clock leases/deadlines/collisions plus real
local HTTP/WS happy paths for both role mappings, auth attacks, timeout callbacks,
pre-completion reconnect, cancellation, payload forwarding and log privacy. Existing
local verify suites remain required. The public WSS probe is not run by local tests.

# Connection Request V1 Contract

Status: CP0 normative design contract; no endpoint or client implementation is
introduced by this document. MUST/MUST NOT describe requirements for subsequent
checkpoints, not functionality already available in the baseline.

## 1. Baseline and scope

Local baseline, checked without fetch:

| Repository | Branch | HEAD |
| --- | --- | --- |
| ui-capture-test | main | 495bac1 |
| realtime-relay | main | 2f94fe1 |
| realtime-web-test | main | e9b0ec2 |
| pairing-api | main | 6c9b716 |

These identify local source, not verified public deployment versions. Android is
13 commits ahead of its local origin/main tracking reference. The known untracked
measurement file shared-waiting-retest.txt was preserved unchanged in a uniquely
named TEMP file before documentation work; no measurement content belongs here.

CP0 changes only this document. Existing Android, WebRTC, relay signaling, web,
configuration and diagnostics behavior remains unchanged.

## 2. Request and signaling are separate lifecycles

A Connection Request is a server-side HTTP/control-plane object. Its existence
does not require an Android Activity, foreground execution, a live signaling
WebSocket, a PeerConnection or MediaProjection.

At sharing time there MUST be no required WebRTC CREATE, signaling WebSocket or
PeerConnection. The request link contains no session code. Request-first clients
must defer the existing automatic session-start paths for this flow.

Activity stop/recreation, app switching, a phone call, process interruption,
WebSocket close and PeerConnection close MUST NOT automatically delete a valid
waiting request. Server expiry, explicit authorized actions and defined request
transitions determine its lifetime. Relay process restart is the explicit V1
exception described below.

Signaling starts only after explicit recipient Accept AND participant readiness.
The subsequent media session has its own lifecycle. Neither opening a link nor
foreground restoration is an implicit Accept.

## 3. Request state machine

| State | Entered by | Allowed next states | Deadline / terminal meaning |
| --- | --- | --- | --- |
| WAITING | Initiator HTTP create | ACCEPTED, CANCELED, EXPIRED | createdAt + 300 seconds |
| ACCEPTED | First valid explicit recipient Accept | CONNECTING, CANCELED, FAILED | acceptedAt + 120 seconds |
| CONNECTING | Protected setup starts after participant readiness | CONNECTED, CANCELED, FAILED | Same connectBy; no reset |
| CONNECTED | Authorized establishment completion, detailed in CP3 | None for request setup | Terminal for request setup; running media is separate |
| CANCELED | Initiator Cancel before CONNECTED | None | Terminal |
| EXPIRED | Server detects WAITING deadline | None | Terminal |
| FAILED | Accepted recipient withdraws, setup fails or connectBy elapses | None | Terminal |

The arrows describe alternatives from each state, not a sequential chain through
all listed destinations. Illegal transitions MUST be rejected. There is no
persistent DECLINED or BUSY state and no transition back to WAITING.

Decline before Accept is local to that recipient. It does not consume or close
the forwarded bearer link; no decline endpoint is needed in V1.

BUSY is primarily a local pre-Accept check: STREAMING, RECEIVING, CONNECTING,
active consent or another active session MUST NOT be interrupted. A busy attempt
must not claim the request; it remains WAITING for another recipient. Setup must
also respect current local role/session guards if local availability changes.

After successful Accept, winner withdrawal ends setup as FAILED. It never lets
another recipient take over. A new attempt requires a new request.

Initiator Cancel is allowed in WAITING, ACCEPTED and CONNECTING. It sets CANCELED
and invalidates all request-bound setup authorizations. After CONNECTED use the
existing media Stop/disconnect behavior instead of request Cancel.

## 4. Authoritative deadlines and cleanup

The server sets createdAt and expiresAt = createdAt + 300 seconds. Accept is
allowed only while serverNow < expiresAt; at equality or later it is too late.
The client countdown is UI only and must not authorize an Accept.

Successful Accept atomically sets acceptedAt and connectBy = acceptedAt + 120
seconds. The original WAITING expiresAt MUST NOT terminate ACCEPTED or CONNECTING.
Connection completion must occur before connectBy; at the deadline an incomplete
setup becomes FAILED with reason establishment_timeout.

Example: created 12:00:00, expiresAt 12:05:00, Accept 12:04:57 is valid and sets
connectBy 12:06:57. Nothing expires merely because 12:05:00 passes afterward.

Apply lazy expiry before every relevant API/state operation, plus periodic cleanup
to release memory. A timer alone is not an authorization/state decision. Deadline
checks and state mutation must be ordered consistently in the server operation.
CP1 will set cleanup interval, bounded capacity and short terminal tombstone TTL.
CONNECTED tombstone cleanup does not itself stop an established media session.

Responses expose serverNow and relevant deadlines. Client time is not authoritative.
Existing media-engine timeouts remain separate and need explicit integration
review; this contract does not change them or promise a media engine waits 120s.

## 5. Client request ownership and resharing

At most one active initiator request exists per Android app instance, enforced by
the client without accounts or server-side device identity enforcement.

Distinguish two actions:

- Re-share the current unexpired WAITING request: use the identical link; do not
  create or extend a request. Gmail -> app -> Share -> Messenger is this action.
- Explicitly start a new request while another is active: cancel the old request
  first, then create the new one. Resolve uncertain cancellation through status;
  do not silently create a second known active request.

ACCEPTED/CONNECTING requests cannot be re-shared for a new claimant. CONNECTED uses
the normal media lifecycle. Terminal requests require a new create operation.

## 6. Identifiers and credentials

All random values use a cryptographically secure random generator. Base64URL is
canonical, unpadded, and must decode/re-encode identically, including unused bits.

| Value | Random bits | Characters | Authority / server representation |
| --- | --- | --- | --- |
| requestId | 128 | 22 | Identifier only; plaintext map key is allowed |
| recipientCapability | 128 | 22 | Limited preview and initial Accept; SHA-256 hash |
| initiatorSecret | 256 | 43 | Initiator status, Cancel, readiness/setup and binding; SHA-256 hash |
| recipientClaimSecret | 256 | 43 | Winner continuation after Accept; SHA-256 hash |

Credentials have distinct scopes. Identifier knowledge is not authorization.
Initiator and claim secrets MUST NEVER enter the shared link. No secret belongs
in HTTP query strings, logs or error messages. Use HTTPS and Authorization headers.
Creation responses contain newly generated credentials transiently; server records
retain their hashes, not plaintext credentials.

### Recipient claim and lost Accept responses

Before sending Accept, the recipient generates recipientClaimSecret and saves it
to private storage. Accept uses recipientCapability as Bearer authorization and
claimSecret in its JSON body. The server stores only the claim hash.

If the response is lost, retrying with the same capability and claim is idempotent
while the accepted setup remains active. It returns the existing accepted outcome
without resetting acceptedAt/connectBy. A different claim gets already_accepted.
After terminal completion a retry reports the terminal result; it cannot revive it.

The shared capability after Accept cannot retrieve winner-only setup data or
replace the claim. The winner uses its claim secret for subsequent status/setup.
A different device/tab holding only the shared link cannot take over ACCEPTED.

## 7. Atomic first-accepted-wins

Within one Node process the critical sequence has no await:

1. Request lookup.
2. Capability validation.
3. Deadline validation.
4. WAITING check.
5. Claim hash assignment.
6. acceptedAt and connectBy assignment.
7. State assignment to ACCEPTED.

Same-claim retries are recognized separately without opening a second claim or
extending deadlines. A second different claim conflicts. Cancel, expiry and setup
completion must likewise use deterministic state/deadline checks before mutation.

V1 supports a single relay instance only. In-memory event-loop atomicity is not a
distributed locking mechanism. Restart loses the record; old links must not
recreate records.

## 8. Versioned HTTPS link and parsing

Canonical generated link:

```text
https://pairing.pradert.synology.me/connect#v=1&r=<requestId>&c=<recipientCapability>&i=<send|receive>
```

v is protocol version, r is requestId, c is recipient capability, and i is the
initiator role hint. The server record's initiatorRole is authoritative. Session
code, initiatorSecret and recipientClaimSecret are absent.

Android/web parsers must require every field exactly once and reject duplicates,
unknown versions, invalid roles, malformed Base64URL, noncanonical lengths or
encoding, oversized fragments and malformed links. Unknown V1 fields are rejected.
Generated field order is v/r/c/i; parsers need not depend on ordering. CP6 will
fix the exact fragment size limit. A role hint differing from server metadata must
produce a safe error, not change media direction.

GET, link open, preview and App Link dispatch MUST NEVER Accept. Preview metadata
may be fetched with the capability, without consuming it. Explicit user action
alone triggers the Accept POST. A normal HTTP request does not transmit the URL
fragment; clients read it from the Intent URI or browser location. Actual fragment
preservation by share targets/in-app browsers requires physical tests.

## 9. Recipient and initiator UX

### SEND initiator recipient

- Title: **Csatlakozási kérelem**
- Text: **A másik eszköz meg szeretné osztani Önnel a képernyőjét.**
- Primary: **Csatlakozás** (explicit Accept).
- Secondary: **Mégse** (local Decline).
- Android recipient is RECEIVE; browser receiver fallback is supported.

### RECEIVE initiator recipient

- Title: **Csatlakozási kérelem**
- Text: **A másik eszköz az Ön képernyőjét szeretné fogadni.**
- Android primary: **Képernyő megosztása** (explicit Accept).
- Secondary: **Mégse** (local Decline).
- Android MediaProjection system consent remains separately required afterward.
- Browser displays **Android alkalmazás szükséges.** and does not Accept. No
  browser sender is implemented in V1.

### Initiator

SEND/RECEIVE -> Share connection link -> HTTP create -> save request/link snapshot
-> native Android Share Sheet. App switching, calls and repeated foreground/
background transitions do not cancel the server request.

Foreground polls approximately every 2 seconds; resume refreshes immediately.
Background polling may stop. Polling absence never deletes a request. Accepted
setup resumes automatically when eligible, without an additional Connect button.
MediaProjection may launch only at the proper SEND/RESUMED point and still needs
explicit system consent.

V1 has no push: a background initiator is not automatically awakened or notified.
The user must return before connectBy to complete setup. Activity restoration
must refresh status before acting on cached state.

## 10. Signaling, readiness and media direction

Only after Accept and participant readiness is a session created. The initiator
always CREATEs and the recipient always JOINs:

| Initiator | Initiator signaling/media | Recipient signaling/media |
| --- | --- | --- |
| SEND | sender + CREATE + offerer | receiver + JOIN + answerer |
| RECEIVE | receiver + CREATE + answerer | sender + JOIN + offerer |

SEND = offerer and RECEIVE = answerer remain unchanged and independent of CREATE/
JOIN. Existing MediaProjection security, role/epoch guards, QR payloads and manual
code flow are not altered by CP0.

A request-bound signaling registration MUST validate participant, media role and
setup authorization. A six-character session code alone is never sufficient to
enter such a session, including through the legacy code-only registration path.

CP3 reserves participant readiness/state and session binding operations. It will
finalize their names, payloads, freshness rules, completion acknowledgements,
session assignment and setup authorization transport. No CP3 payload is finalized
here. Readiness must not be inferred solely from Accept or stale foreground state.
The winning recipient alone may receive its setup assignment; shared preview
capability is never sufficient. Request Cancel invalidates pending setup rights.

## 11. HTTP API V1 contract (not implemented)

All secret-based HTTP authorization uses `Authorization: Bearer <secret>`, never
query parameters. JSON requests/responses use application/json. Secret-bearing
responses must not be cached. No cookie/account authentication is required.

| Operation | Caller and authorization | Minimum input | Minimum successful output | Transition / idempotency |
| --- | --- | --- | --- | --- |
| POST /connection-requests | Initiator; no pre-existing request secret | version: 1, initiatorRole: send or receive | requestId, recipientCapability, initiatorSecret, state: WAITING, serverNow, expiresAt | Creates one request; not inherently idempotent |
| GET /connection-requests/:id/status | I, shared capability, or winner claim Bearer | Request ID in path | Authorized metadata, state, initiatorRole, serverNow and relevant deadlines | Repeatable; never Accepts; lazy expiry may update expired state |
| POST /connection-requests/:id/accept | Recipient capability Bearer | claimSecret | requestId, state, serverNow, acceptedAt, connectBy | WAITING -> ACCEPTED; same claim retry is idempotent |
| POST /connection-requests/:id/cancel | Initiator secret Bearer | No additional required fields | requestId, state, serverNow | WAITING/ACCEPTED/CONNECTING -> CANCELED; repeated CANCELED is idempotent |

I denotes initiatorSecret. Shared-capability status is limited to preview metadata
and availability; it never exposes claim identity, session assignment or setup
secrets. Initiator and winner claim status are scoped to their own participant
rights. Successful outputs do not echo Authorization or claimSecret. Terminal
status can be returned to authenticated status callers while its tombstone exists.

Same-claim Accept retry uses capability Bearer plus the saved claimSecret body;
subsequent continuation uses claim Bearer. Cancel after another terminal outcome
does not overwrite it. CONNECTED Cancel is an illegal transition.

Create response loss can leave an unshared request until expiry. Do not blindly
retry create as if it were idempotent. Save the successful response atomically
before opening the Share Sheet. CP0 does not introduce create idempotency keys.

### Error categories

| HTTP | Meaning |
| --- | --- |
| 400 | Invalid input, version, role or format |
| 404 | Unknown request or authorization cannot be established |
| 409 | already_accepted, different claim, illegal transition or later readiness conflict |
| 410 | Authenticated operation targets an expired/closed request |
| 429 | Rate limited; respect Retry-After |
| 503 | Capacity exhausted or service unavailable |

Do not create a detailed authentication oracle. Validate authorization before
revealing request-specific terminal/conflict information. Errors never contain
credentials. Unknown/deleted records and invalid auth are not distinguishable by
detailed messages. A new Accept cannot reopen a terminal request.

## 12. Storage, restart and restoration

The V1 request store is realtime-relay process memory, independent from the socket
session map. No MariaDB, Redis or NAS dependency. Process restart may lose active
requests; this is an accepted V1 limitation. UI: **Connection request is no longer
available.** A stale link must not resurrect the request. Single-instance operation
is required.

Android initiator private storage, excluded from cloud backup AND device transfer,
must retain requestId, initiatorSecret, initiatorRole, recipientCapability and
expiresAt. Capability retention permits identical-link re-sharing while WAITING.
acceptedAt/connectBy caches are optional and never authoritative. ViewModel alone
is insufficient. A process restart restores the snapshot, fetches server status,
then restores UI; terminal/unavailable requests clean up local credentials. Local
clock uncertainty must be resolved against server status rather than authorize
setup. Never persist or resurrect old MediaProjection permission.

Android recipient stores the pre-generated claim privately with backup/transfer
exclusion and enough request association to retry/restore. Browser may use
sessionStorage for same-tab reload. Storage failure must not silently claim that
refresh recovery is guaranteed. Another tab/device possessing only the shared
capability cannot take over. Tab/app background stops polling without implicitly
withdrawing the accepted request; explicit winner withdrawal fails setup.

## 13. Hosting, legacy compatibility and diagnostics

The new /connect entry is separate from persistent /pair. Later checkpoints must
add its HTTPS fallback and verified Android App Link routing without treating
PairingInviteActivity as the new request dispatcher automatically. Actual app-first
dispatch depends on platform verification/settings and needs physical validation.
The fallback must gate existing automatic receiver startup behind explicit Accept.

Browser API access requires narrowly scoped HTTPS CORS for the actual /connect
page origin; native Android is not subject to browser CORS. CORS is not auth.
Later implementation must add bounded body sizes, create/Accept/invalid-auth/
polling limits, total request capacity and memory cleanup without blocking normal
two-second participant polling. CP0 does not choose production limit values or
change hosting configuration.

Legacy persistent #device remote share, /pair NAS pairing, QR/manual session-code
flow, the 495bac1 lifecycle fix and ScreenShareLifecycleDiag remain untouched.
Request-first must not depend on shared-waiting protection or a background socket.
Replacing legacy Share UI is a later checkpoint. Diagnostic removal/simplification
requires a separate decision after full request-first physical regressions.

## 14. Security and logging

Never log recipientCapability, initiatorSecret, recipientClaimSecret, full
connection URLs, Authorization headers, SDP or ICE. Avoid automatic HTTP body/
header dumps and secret-bearing exception messages.

Permitted later diagnostics: state, transition, role, timestamp, HTTP status and
a short requestId hash prefix. Debug diagnostics remain debug-only; production
logging should be minimal and must obey the same credential exclusions.

## 15. Non-goals

V1 has no user accounts, contact permission, owned partner list, FCM, Web Push,
notification permission, foreground waiting service, NAS pairing DB for requests,
browser screen sender, multi-relay-instance distributed atomicity, or persistent
request recovery after relay restart. Waiting request reliability must not depend
on five minutes of background signaling WebSocket availability.

## 16. Subsequent checkpoints

| Checkpoint | Scope |
| --- | --- |
| CP1 | Relay request core |
| CP2 | Accept / claim / cancel / first-accepted-wins |
| CP3 | Readiness + protected signaling binding |
| CP4 | Relay integration + controlled deploy |
| CP5 | Android initiator request lifecycle |
| CP6 | /connect + App Link entry |
| CP7 | Android recipient Accept/claim |
| CP8 | Browser fallback request UX |
| CP9 | SEND end-to-end media integration |
| CP10 | RECEIVE end-to-end media integration |
| CP11 | Resilience / physical regressions |
| CP12 | Legacy UI cleanup |

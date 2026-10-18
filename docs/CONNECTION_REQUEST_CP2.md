# CP2 implementation notes

V1 contract and CP1 create/status behavior remain authoritative. CP2 adds no
WebSocket, readiness, binding, normal CONNECTING/CONNECTED or recipient backout
trigger. No Decline endpoint or BUSY state is introduced.

- POST /connection-requests/:id/accept uses recipient capability Bearer and exactly
  one JSON field, claimSecret. Limit: 512 bytes. Claim is recipient-generated,
  canonical unpadded Base64URL, 32 bytes / 43 characters. Invalid input: 400.
- The synchronous store accept method has no await. First WAITING check/set wins;
  the record gains recipientClaimHash (SHA-256), acceptedAt and connectBy. No raw
  claim is retained. A different claim conflicts with 409 already_accepted. The
  same claim/capability retry returns 200 with original timestamps, never a fresh
  deadline. Responses never echo credentials/hashes or contain session data.
- POST /connection-requests/:id/cancel uses initiator Bearer. Empty body or JSON {}
  is accepted. WAITING/ACCEPTED -> CANCELED. Repeated authenticated CANCELED Cancel
  returns 200 without changing the original terminal time. Other terminal states
  return 410 and never change. CP3 can extend the active-state allowlist to
  CONNECTING without inventing a CP2 transition into that state.
- Cancel-first blocks Accept (410); Accept-first followed by Cancel is valid and
  ends CANCELED. Each state operation is synchronous. No state reopens to WAITING.
- Status now accepts winner claim Bearer as well as initiator/capability. Initiator
  receives createdAt and accepted timestamps; claim receives accepted timestamps
  without createdAt. Shared capability retains the CP1 minimal metadata projection,
  without acceptedAt/connectBy/failure details or any setup privilege.
- Authenticated terminal status is 410 with state and the authorized projection.
  FAILED exposes establishment_timeout only to initiator/winner claim. Wrong,
  missing, wrong-scope and unknown-request auth use the generic CP1 404 response.
  Bad body format is 400 independently of record existence. No auth-type header.
- Accepted deadline is acceptedAt + 120000 ms. Original expiresAt is ignored after
  Accept. Lazy lookup and periodic cleanup both set FAILED at connectBy equality.
  Internal terminalAt anchors the existing 120-second tombstone: expiresAt for
  EXPIRED, connectBy for timeout FAILED, first cancel time for CANCELED. Late
  observation/retry never extends retention. Capacity remains 1000 including
  tombstones; cleanup never evicts live ACCEPTED for capacity.
- Independent JoinLimit budgets per 60-second window: Accept 30/request ID and
  6000 global; Cancel 30/request ID and 6000 global. Invalid attempts count. Normal
  retry has headroom; rejection is 429 with conservative Retry-After: 60. Budgets
  are bounded, not per-device/IP guarantees; known-ID/shared/global budget DoS
  remains a limitation. No forwarded-IP trust. CP1 create/status limits unchanged.
- CORS uses the existing exact NAS origin; new actions support POST preflight
  with Content-Type/Authorization. No new logs, secrets in URLs, dependencies or
  production configuration. Request store remains independent from socket cleanup.

Verification: node verify-connection-acceptance.cjs (fake-clock state/race/security
groups and local HTTP smoke), existing local verify suite and syntax checks.
The optional public verify-remote-signaling.cjs is not a local regression test.

# CP1 implementation notes

The authoritative V1 contract is unchanged. CP1 implements create/status only.

- Separate private in-memory store; no socket, remote mapping or session references.
- WAITING TTL: 300 seconds. EXPIRED tombstones last 120 seconds measured from
  expiresAt, not from when a timer happens to notice expiry. After that: 404.
- One 30-second unref'ed cleanup timer per HTTP component; shutdown clears it.
  Clock and scheduler are injectable for deterministic tests. No per-record timer.
- Default capacity is 1000 total records, including tombstones. The store constructor
  accepts a safe integer capacity (1..100000); no new production environment config.
  Create cleans up first and returns 503 without evicting active records if full.
- ISO-8601 UTC timestamps on the wire; milliseconds internally.
- Create accepts exactly version and initiatorRole (no extras), following the
  strict remote resolve validation style. JSON body limit: 512 bytes; malformed,
  oversized or unsupported-content-type requests return 400. No custom TTL.
- Bearer syntax is strict. Canonical credentials only; unknown/missing/wrong auth
  all return generic 404. Expired records return 410 only after valid auth. Query
  strings are rejected (400), not used for auth; cookies are ignored.
- Recipient status omits createdAt; both status projections omit all credentials,
  hashes and setup data. All handled responses use Cache-Control: no-store.
- Reuses JoinLimit with independent fixed 60-second windows: global create budget
  60/min; status 120/request ID/min and 60000 total/min. Malformed requests count.
  Retry-After: 60 is conservative. No forwarded-IP trust or per-user guarantee.
  The per-ID budget supports two clients polling every two seconds with headroom;
  attackers knowing an ID can still exhaust its shared budget. Global-budget DoS
  is a V1 limitation, not solved by this bounded helper.
- Only the new API allows exact origin https://pairing.pradert.synology.me,
  GET/POST as appropriate and Content-Type/Authorization preflight headers.
  No wildcard, cookies or global CORS change. Native no-Origin clients are allowed.
- No new application logging, dependency, Accept, Cancel, claim, readiness, binding
  or signaling behavior. Create is not idempotent; a lost response leaves an
  unshared request to expire, with no server-side retry or idempotency key.

Checks: node --check for root JS/CJS files; all local verify-*.cjs scripts except
verify-remote-signaling.cjs (explicit public-service probe). Run the new unit and
local HTTP/WebSocket smoke coverage with node verify-connection-requests.cjs.
No lint configuration exists in the baseline.

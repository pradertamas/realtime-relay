# PoC 4B temporary TURN credential endpoint

Local implementation only: no commit, push or deployment has been performed.
The existing two-way `/ws` forwarding/session/role protocol is unchanged.
Only a bounded HTTP credential route is added to the same Node service.
The video remains WebRTC RTP/SRTP; neither the HTTP route nor WSS carries video.

## Cloudflare flow and server environment

Based on official documentation checked 2026-10-16:
https://developers.cloudflare.com/realtime/turn/generate-credentials/
https://developers.cloudflare.com/realtime/turn/faq/

An operator creates a Realtime TURN key in Cloudflare Dashboard. Keep its
key ID and corresponding TURN key API token on the server. This service calls
only `POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers`
with a Bearer token and a fixed `{"ttl":600}` body. No caller-supplied URL, TTL,
Cloudflare token or other upstream options are accepted. Credentials expire
after ten minutes; clients stop 30 seconds before the conservative expiry.
Use accurate device clocks. There is no mid-call refresh/ICE restart in this PoC.

Set these in the Render **realtime-relay Web Service → Environment** before
manually deploying the modified service:

| Variable | Value | Client access |
|---|---|---|
| `CLOUDFLARE_TURN_KEY_ID` | TURN key identifier from Cloudflare, not an account ID | Never sent |
| `CLOUDFLARE_TURN_API_TOKEN` | API token belonging to that TURN key, permitting temporary credential issuance | Never sent |
| `TURN_ENDPOINT_ACCESS_TOKEN` | Separate operator-managed unpredictable 32–256-character ASCII letters/digits/underscore/hyphen key | Enter manually in Android's masked field; memory only |
| `TURN_USD_PER_GB` | Nonnegative finite decimal price assumption; default `0.05` if unset | Sent as an explicit assumption to both clients |

Do not paste a Cloudflare API/master token into Android. The endpoint access
token is a limited gate for this one issuance route, not a Cloudflare token.
Rotate it after the PoC and remove/disable the endpoint when no longer needed.
This implementation generates no real secrets and prints none.

For local Node execution set the same names in the process environment; `.env`
is NOT automatically loaded. `.env.example` has names/empty placeholders only.
For example, in a private PowerShell terminal, read secrets without echo/history:

```powershell
$env:CLOUDFLARE_TURN_KEY_ID = Read-Host 'Cloudflare TURN key ID'
$env:CLOUDFLARE_TURN_API_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Cloudflare TURN API token' -AsSecureString)).Password
$env:TURN_ENDPOINT_ACCESS_TOKEN = [System.Net.NetworkCredential]::new('', (Read-Host 'Separate endpoint access token' -AsSecureString)).Password
$env:TURN_USD_PER_GB = '0.05'
node server.js
```

These values are available to that process and its children, not committed
configuration. After stopping the server, clear the secret env vars/close that
terminal. Do not screenshot tokens or print the request headers or response body.

## Endpoint contract

Public URL after manual deploy:
`https://realtime-relay-k28l.onrender.com/turn/credentials`

Native Android only:

```text
POST /turn/credentials
Authorization: Bearer <separate operator endpoint access token>
Content-Type: application/json

{"session":"<6–64 ASCII letters/digits/_/->"}
```

Successful response has ONLY `iceServers`, `expiresAt` (epoch ms), `usdPerGb`.
`iceServers` contains sanitized Cloudflare TURN URLs and temporary
username/credential; provider STUN and extra upstream fields are discarded.
AUTO clients add their existing Google STUN separately. Both peers receive the
same response-derived temporary configuration once, over their WSS session.
Browser never calls this endpoint, and receives no endpoint/API access token.

Response headers include `Cache-Control: no-store`, `Pragma: no-cache`.
Errors: 400 invalid JSON/session/extra input; 401 wrong access token;
403 browser Origin header; 405 wrong method; 413 >512-byte body;
415 wrong content type; 429 throttled; 503 missing/invalid server env;
502 upstream/status/schema/timeout failure. Responses do not echo input,
headers, upstream bodies or exceptions. No credential logging is installed.

PoC limits: globally 10 requests per minute and at most 2 in-flight requests,
10-second body/upstream timeouts, 32 KiB upstream response bound. Auth failures
consume the request budget. Limits are in-memory and reset on restart; they
are for one instance, not distributed protection. Do not trust arbitrary
X-Forwarded-For as an identity. For broader exposure add an edge/IP rate limit,
operator token rotation and provider usage alerts. A shared endpoint key holder
can mint credentials, and temporary credentials can be reused until expiry.
The unchanged WSS session ID remains the signaling access boundary; use a new,
unpredictable ID per session and share it only with the intended receiver.

## Local checks (no Cloudflare calls, no public signaling)

```text
node --check server.js
node --check turn-credentials.cjs
node verify-signaling.cjs
node verify-turn-credentials.cjs
```

The credential test uses only loopback HTTP and a stub upstream with explicitly
fake tokens. It verifies validation, sanitization, no-store, rate limiting and
the fixed upstream/TTL. It does not establish real Cloudflare interoperability.
`verify-remote-signaling.cjs` is unchanged and is deliberately NOT run before
deployment. After a manual deploy it can check the public signaling service.

## Manual deploy checklist

1. Review `server.js`, `turn-credentials.cjs`, tests and this document locally.
2. In Cloudflare create/select a TURN key and privately obtain its API token.
3. Set the four Render environment variables above. Ensure Node 22/24 and one
   service instance, existing `npm ci` / `npm start`, HTTPS service domain.
4. Make the reviewed local changes available to Render through your normal,
   separately authorized source-release process. This task did not commit/push.
   Render cannot deploy uncommitted local files by selecting the old commit.
5. Manually deploy the revision containing both `server.js` and the new
   `turn-credentials.cjs`; do not merely redeploy `96217dc`.
6. Verify health `GET /`. An unauthenticated POST must return 401 when env is
   configured (503 means configuration missing). Do not log authenticated
   credential responses. Use the updated Android client for the real issuance.
7. Manually publish the updated static receiver AND `webrtc-network.js`,
   install the new Android APK, then run the A/B procedure in the Android
   project's `POC4B.md`. Remote signaling checks may be run now, manually.

Changing environment values in Render can itself restart/redeploy the service;
coordinate this with the operator. No action above was performed automatically.

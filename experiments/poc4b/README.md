# Historical PoC 4B experiment - excluded from release

All TURN/Cloudflare sources, tests, environment template and TURN documentation
are kept here only. server.js is the pre-cleanup snapshot with the experimental
HTTP route; it is not the active npm start entry point. The root server.js has
no import or handler for this experiment and requires no credential variables.
Nothing here is deployed or a release asset. Do not use TURN.md as instructions
for deploying the current P2P release; it describes only the historical PoC.

verify-turn-credentials.cjs uses a stub upstream and can be run explicitly from
this directory. No experiment test is part of normal release verification.

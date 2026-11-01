# AGENTS.md

Notes for AI agents. Full guide: [CLAUDE.md](CLAUDE.md); flows, auth and threat model: [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout
- `src/server.js` config, sessions, Express app, `/api`, WHIP proxy, internal MediaMTX auth hook (`:9000`), TLS.
- `src/security.js` scrypt, signed tokens, `RateLimiter`; `src/db.js` JSON store `data/db.json`; `src/mediamtx.js` MediaMTX client + ICE candidates.
- `views/*.html` + `public/*.js` (plain ES2017, no build, no `innerHTML`, strict CSP).
- `test/server.test.js` (unit, `node --test`), `test/e2e.sh` + `e2e.js` (full stack).

## Commands
- `npm ci && node --test test/server.test.js` — fast tests, no Docker needed.
- `node --check src/server.js`
- `docker compose up -d --build` then `test/e2e.sh` — end-to-end (needs ffprobe, playwright). Tear the stack down afterwards.

## Conventions
- JSON-only API bodies (CSRF protection), `requireAdmin` / `requireStream`, stream name from the session only.
- Password checks: IP + account limiter, `DUMMY_HASH` for unknown accounts, `sec.verifyPassword` / `sec.safeEqual`.
- In async Express 4 handlers wrap every rejecting `await` in try/catch (an unhandled rejection kills the process).

## Never do
- Publish port 9000; set Express `trust proxy` to `true`; add form/text body parsers; add inline JS/CSS;
  add HSTS (self-signed default certificate); commit `data/` (secret, hashes, certificates).

## Gotchas
- `TRUST_PROXY=true` maps to private networks on purpose (see CLAUDE.md).
- Clear `verifyCache` and kick the publisher when a stream password changes or a stream is deleted.
- Browsers ignore FQDN ICE candidates; hostnames are resolved to IPs.

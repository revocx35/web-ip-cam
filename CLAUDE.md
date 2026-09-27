# CLAUDE.md

Guide for AI assistants (and humans) working on this repository.

## What this is

**Web IP Cam** turns old phones, tablets and laptops into RTSP IP cameras from the browser, with no app install. A device logs in to a stream, its browser publishes the camera over WebRTC (WHIP) through the Node.js app to MediaMTX, and NVRs/players read it as `rtsp://<stream>:<password>@<server>:8554/<stream>`. The deliverable is a Docker Compose stack of two containers: `app` (this repo) and `mediamtx`.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing auth, WHIP or networking code. It has the flows, the session and login-limit model, and the reverse-proxy rules.

## Commands

```bash
docker compose up -d --build          # full stack: https://localhost:8443
docker compose logs -f app            # app logs (denied RTSP logins show up here)

# end-to-end test against the running stack (needs curl, ffprobe, node + playwright)
cd test && npm install --no-save playwright && npx playwright install chromium && ./e2e.sh

# quick checks without Docker (npm install first)
node --check src/server.js
DATA_DIR=/tmp/wic HTTPS_ENABLED=false HTTP_PORT=18090 INTERNAL_PORT=18091 node src/server.js   # no MediaMTX: UI/API work, streams show offline
```

There are no unit tests; CI runs `test/e2e.sh` against a real `docker compose up` (setup, streams, RTSP auth via ffprobe, a headless Chromium publishing a fake camera).

## Layout

- `src/server.js`: config (env), sessions, Express app (security headers, pages, `/api`), login limits, WHIP proxy, internal MediaMTX auth endpoint (`:9000`), TLS/startup.
- `src/security.js`: scrypt, `hashVersion` (password-hash fingerprint in sessions), signed tokens, `RateLimiter`.
- `src/db.js`: `Store`, the JSON file `data/db.json` (app secret, admin, streams).
- `src/mediamtx.js`: MediaMTX API/WHIP client, `resolveHostIPs` + `injectCandidates` for ICE.
- `views/*.html` + `public/*.js`: the four pages (setup, login, admin, camera) and their scripts; `public/common.js` holds the shared `WIC` helpers.
- `test/`: `e2e.sh` + `e2e.js`. `.github/workflows/ci.yml`: e2e, then image publish.

## Conventions

- Frontend: plain ES2017 in IIFEs, no build step and no frameworks (old devices are the target). Build DOM with `createElement`/`textContent` (see `el()` in `admin.js`); there is no `innerHTML`.
- The CSP is `default-src 'self'` with no inline scripts or styles: keep JS in `public/*.js` and CSS in `public/app.css`.
- API bodies are JSON only (`express.json`), except WHIP (`application/sdp`). Don't add form or `text/plain` parsers: the JSON-only rule is part of the CSRF protection (ARCHITECTURE.md §4).
- Auth:
  - Admin routes use `requireAdmin`, camera routes `requireStream`. A stream route must take the stream name from `req.session`, never from the request.
  - Any check of a password follows the login pattern: `limiter.blocked(ip key) || accountLimiter.blocked(account)` → `429`; on failure `fail()` both; on success `reset()` both.
  - Compare secrets with `sec.verifyPassword` / `sec.safeEqual`, and run scrypt even when the account doesn't exist (`DUMMY_HASH`).
  - Use `req.ip`/`req.secure` for client address and HTTPS, never raw `X-Forwarded-*` headers. Never set Express `trust proxy` to `true` (see below).
- Session payloads carry `v = hashVersion(<password hash>)`, so storing a new hash logs out that account's old sessions by itself. For streams, also call `verifyCache.clear()` (RTSP) and `mtx.kickPublisher()` (the running camera).
- Nothing on port 9000 may be published: the internal auth endpoint accepts the app secret and tests stream passwords without limits.
- When you change env vars, endpoints or behaviour, update `README.md` (configuration table, reverse-proxy section) and `ARCHITECTURE.md`.

## Hard-won facts (don't re-learn these)

- **Express `trust proxy = true` returns the left-most `X-Forwarded-For` entry**, which the client controls. Nginx Proxy Manager *appends* the real IP (`$proxy_add_x_forwarded_for`), so with `true` any client could pick a new IP per request and skip the login limit. `TRUST_PROXY=true` is therefore mapped to `loopback, linklocal, uniquelocal` in `trustProxySetting()`. Express/proxy-addr also throw on unknown words, so `false` must be mapped to `false`, not passed through.
- To check proxy trust without traffic, run `proxy-addr` against fake requests: `proxyaddr({connection: {remoteAddress: peer}, headers: {'x-forwarded-for': xff}}, app.get('trust proxy fn'))`. Node reports IPv4 peers as `::ffff:a.b.c.d`; proxy-addr matches them against IPv4 subnets.
- Browsers only allow `getUserMedia` on secure pages, which is why the app generates a self-signed certificate (`openssl`, in the image) unless one is configured.
- Inside Docker, MediaMTX only advertises its container IP. The app injects the IPs of the host the browser used (plus `WEBRTC_ADDITIONAL_HOSTS`) into the WHIP answer. **Browsers ignore FQDN ICE candidates**, so hostnames are resolved to IPs first.
- MediaMTX multiplexes all WebRTC sessions on port 8189 (UDP + TCP) and demuxes by ICE ufrag: any address that reaches that port works as a candidate.
- RTSP clients re-authenticate on every request; `verifyCache` keeps that from costing a scrypt each time. Clear it whenever a stream password changes.
- `SameSite=None` requires `Secure`: with `ALLOW_EMBED_FROM` over plain HTTP the cookie falls back to `Lax`. Safari blocks cookies in iframes from other sites, so the Home Assistant embed only works when both are on the same site.
- The e2e test reads RTSP status codes from `ffprobe`'s error output (a real `DESCRIBE`): 401 = bad credentials, 404 = valid credentials but no camera publishing.

## Release

Pushes to `main` run `ci.yml`: the e2e job, then a multi-arch image (`linux/amd64`, `arm64`, `arm/v7`) to `ghcr.io/revocx35/web-ip-cam` tagged `latest` and `sha-…`. A `v*` tag also publishes semver tags. There are no version tags yet; `docker-compose.yml` uses `:latest`.

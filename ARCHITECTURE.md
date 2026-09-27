# Architecture

Web IP Cam turns a browser into an RTSP camera. The browser captures its camera with `getUserMedia` and publishes it over WebRTC (WHIP) through the app to MediaMTX, which serves it as RTSP to NVRs and players. The app owns the accounts: one admin, and one password per stream. The same stream name and password log a device in to the web UI and authenticate RTSP viewers.

## 1. Runtime components

```
 old phone (browser)                          server (docker compose)                      NVR / VLC
┌────────────────────┐  HTTPS 8443   ┌──────────────────────────────┐
│ getUserMedia       │──────────────▶│ app (Node.js)                │
│ WebRTC (WHIP)      │  SDP offer    │  • admin/stream accounts     │
│                    │               │  • WHIP proxy + auth         │
│                    │               │  • RTSP auth hook  ◀─────────┼──┐
│                    │               └──────────┬───────────────────┘  │ auth
│                    │  media UDP/TCP 8189      │ WHIP                 │
│                    │─────────────────────────▶┌───────────────────┐  │
└────────────────────┘                          │ MediaMTX          │──┘   RTSP 8554
                                                │ WebRTC → RTSP     │─────────────────▶
                                                └───────────────────┘
```

| Service | Image | Listens on | Role |
|---|---|---|---|
| `app` | `ghcr.io/revocx35/web-ip-cam` (built from this repo, `node:22-alpine`) | `8443/tcp` UI over HTTPS (self-signed unless `TLS_CERT_FILE`/`TLS_KEY_FILE`), `8080/tcp` UI over HTTP (for a TLS reverse proxy), `9000/tcp` internal auth hook + `/healthz` (Docker network only, never published) | UI, accounts, sessions, WHIP proxy, MediaMTX auth |
| `mediamtx` | `bluenviron/mediamtx` | `8554/tcp` RTSP, `8000-8001/udp` RTSP over UDP, `8189/udp+tcp` WebRTC media; API `:9997` and WebRTC HTTP `:8889` on the Docker network only | WebRTC ingest → RTSP |

MediaMTX is configured only through environment variables in `docker-compose.yml`: `authMethod: http` pointing at `http://app:9000/mediamtx/auth`, API on, RTMP/HLS/SRT off, WebRTC media on port 8189 (UDP and TCP).

Browsers only allow camera access on secure pages, so the app serves HTTPS itself (`HTTPS_ENABLED`, default on) unless a reverse proxy terminates TLS in front of port 8080.

## 2. Code map

```
src/
  server.js      config (env), sessions, Express app: security headers, pages, /api routes,
                 login limits, WHIP proxy, internal MediaMTX auth endpoint, TLS + startup
  security.js    scrypt hashing, hashVersion, safeEqual, signed session tokens, RateLimiter
  db.js          Store: data/db.json (app secret, admin, streams), in memory, atomic writes (0600)
  mediamtx.js    MediaMTX client (paths list, kick publisher, WHIP POST/DELETE),
                 resolveHostIPs + injectCandidates (ICE host candidates for the SDP answer)
views/           setup, login, admin, camera pages (static HTML, no inline scripts or styles)
public/
  common.js      WIC helpers: $, api() (JSON fetch), messages, copy, logout
  setup.js       first-run admin form
  login.js       admin/stream login tabs, ?next=/camera… redirect (only /camera paths)
  admin.js       stream list (live state, viewers), create/delete streams, passwords
  camera.js      getUserMedia, WHIP publish, reconnect with backoff, settings, wake lock, ?embed=1
  app.css
test/
  e2e.sh         end-to-end test against a running `docker compose up` stack (curl + ffprobe)
  e2e.js         headless Chromium with a fake camera publishes; ffprobe checks the RTSP output
.github/workflows/ci.yml   e2e on every push/PR, then multi-arch image to GHCR
```

## 3. Flows

### First run and login

1. While `db.json` has no admin, `/` redirects to `/setup` and `POST /api/setup` creates the admin (username + password ≥ 8) and signs them in. After that, setup answers `409`.
2. The admin creates streams (`POST /api/streams`): name `[A-Za-z0-9_-]{1,64}` (not the app user), password ≥ 8. The response contains the full RTSP URL with credentials, the only time the password is shown.
3. A device logs in with the stream name and password (`POST /api/login/stream`) and opens `/camera`. The stream session cookie lasts a year, so a wall tablet keeps working.

### Camera publishing (WHIP)

```
camera.js: getUserMedia → RTCPeerConnection (sendonly; H.264 or VP8 preferred, Opus)
  → wait for ICE gathering (≤ 2.5 s, no trickle)
  → POST /api/whip   (application/sdp, stream session cookie)
       app → POST http://mediamtx:8889/<stream>/whip   (Basic __webipcam__:<app secret>)
             MediaMTX → app:9000/mediamtx/auth → app user accepted
       app ← 201 SDP answer + Location
       app adds host candidates: IPs of the Host the browser used + WEBRTC_ADDITIONAL_HOSTS, port 8189 UDP + TCP
  ← 201 answer, Location: /api/whip/<random id>
browser ⇄ MediaMTX :8189   media (ICE)
```

- The stream name comes from the session, never from the request, so a device can only publish its own stream.
- `DELETE /api/whip/<id>` maps the random id back to MediaMTX's session URL (kept 48 h) and ends the session; `camera.js` sends it on stop and on `pagehide`.
- `camera.js` reconnects with exponential backoff (2 s → 30 s) after `failed`/`closed`, or after 6 s in `disconnected`, re-acquires the camera when a mobile browser stopped it in the background, polls `/api/camera/status` every 5 s, and holds a screen wake lock while streaming.

### RTSP viewing

```
NVR → rtsp://<name>:<password>@<host>:8554/<name> → MediaMTX
  → POST app:9000/mediamtx/auth {user, password, action, path, protocol, ip}
  ← 200 only if action = read, user = path, and the password matches that stream (else 401, logged)
```

- Successful checks are cached per (name, password, stored hash), because RTSP clients re-authenticate on every request. The cache is cleared when a stream's password changes or it is deleted (and when it exceeds 1000 entries).
- Stream accounts can only *read* over RTSP. Publishing is only possible through the app's WHIP proxy, as the app user.

### Admin changes

- `GET /api/streams` merges the stored streams with MediaMTX's path list (live, since when, viewers, tracks).
- Changing a stream's password or deleting it kicks the current publisher through the MediaMTX API. The device's session is invalid from then on (see §4), so it must log in again.

## 4. Authentication and security

### Request path

```
browser ──► [reverse proxy, e.g. Nginx Proxy Manager] ──► Express :8080 / :8443
  └► trust proxy (TRUST_PROXY)   which peers may set X-Forwarded-For/-Proto → req.ip, req.secure, req.hostname
     └► security headers         CSP, frame-ancestors, nosniff, no-referrer, Permissions-Policy
        └► /api router            JSON bodies only (16 kB); login routes: limits → scrypt
           └► requireAdmin / requireStream   verify signed cookie + password-hash fingerprint
```

### Accounts and passwords

- One admin (username + password ≥ 8, ≤ 256) and any number of streams (password ≥ 8, ≤ 128; streams created before the 8-character minimum may have shorter ones).
- scrypt (N=16384, r=8, p=1, 16-byte salt, 32-byte key) stored as `scrypt$<salt>$<key>` in `db.json` (mode 0600).
- Login always runs scrypt, against a random dummy hash when the username or stream doesn't exist, so response times don't reveal which names exist.

### Sessions

- Cookie `wic_session` = `base64url(JSON) "." base64url(HMAC-SHA256(app secret, body))`. Payload: `t` (`admin`/`stream`), `n` (stream name), `v`, `exp`.
- `v` is a 16-character fingerprint of the account's password hash (`hashVersion`), checked on every request: changing a password logs out every session of that account, and deleting a stream ends its sessions.
- Lifetime: admin 7 days, stream 365 days. Sessions are stateless; logout only clears the cookie in that browser.
- Flags: `HttpOnly`, `Path=/`, `Secure` when the request came over HTTPS (`req.secure`, which trusts `X-Forwarded-Proto` only from trusted proxies). `SameSite=Strict`, or with `ALLOW_EMBED_FROM` set: `None` over HTTPS (so the cookie works inside the Home Assistant iframe) and `Lax` over plain HTTP.
- The app secret (32 random bytes, `db.json`) signs cookies and authenticates the app to MediaMTX.

### Login limits

`security.RateLimiter` counts failures in fixed 15-minute windows, in memory:

| Limit | Key | Max failures |
|---|---|---|
| per client IP | `admin:<ip>`, `stream:<ip>` | 10 |
| per account, from all IPs | `admin`, `stream:<name>` | 50 |

When either is reached the route answers `429` without checking the password; a successful login resets both. The admin password change (`PUT /api/admin/password`) counts against the same limits. The per-account limit bounds distributed guessing (a botnet, or IPv6 address rotation) to 50 guesses per account per 15 minutes.

### Client IP behind a reverse proxy (`TRUST_PROXY`)

The per-IP limit is only as good as `req.ip`. Nginx Proxy Manager sends `X-Forwarded-For: $proxy_add_x_forwarded_for`: it *appends* the address it saw to whatever the client sent. The right-most entry is therefore real and anything to its left is client-controlled.

| `TRUST_PROXY` | Express setting | Client IP |
|---|---|---|
| empty / `false` | none | TCP peer (behind a proxy: the proxy's address, shared by all clients) |
| `true` | `loopback, linklocal, uniquelocal` | right-most `X-Forwarded-For` entry that isn't a private address |
| a number *n* | *n* hops | *n*-th entry from the right, whoever the peer is |
| addresses/subnets | that list | right-most entry that isn't in the list |

Express's own `true` trusts every hop and returns the *left-most* entry, which lets a client pick a new IP per request. That's why `true` is mapped to private networks. A hop count trusts the TCP peer without looking at its address, so it's only safe when port 8080 is reachable through the proxies alone (e.g. Cloudflare → Nginx Proxy Manager: `2`).

### Cross-site requests, framing, content

- The API only parses `application/json` bodies (`application/sdp` for WHIP). Other origins can't send those without a CORS preflight, and the app never answers one. Together with the `SameSite` cookie this blocks CSRF without tokens.
- CSP: `default-src 'self'`, no inline scripts or styles, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'` (or `'self'` + `ALLOW_EMBED_FROM` origins, which are validated at startup). `X-Frame-Options: DENY` when embedding is off. `Referrer-Policy: no-referrer`. `Permissions-Policy` allows camera, microphone and wake lock for the app's own origin only.
- `login.js` follows `?next=` only to `/camera` paths (no open redirect).

### MediaMTX

- Its API (`:9997`) and WHIP endpoint (`:8889`) aren't published. The app authenticates to both as `__webipcam__` with the app secret, and the auth hook accepts that user for every action.
- The internal endpoint on port 9000 must stay on the Docker network: it accepts the app user and would let anyone test stream passwords without limits.

## 5. ICE candidates

Inside Docker, MediaMTX only knows its container IP, which the LAN can't reach. For every WHIP answer, the app resolves the hostname the browser used to open the site (and `WEBRTC_ADDITIONAL_HOSTS`) to IP addresses and adds them as host candidates (UDP and passive TCP) on `WEBRTC_PUBLIC_PORT` to every media section. MediaMTX multiplexes all WebRTC sessions on port 8189 and demuxes by ICE username, so any address that reaches that port works. Hostnames are resolved because browsers ignore FQDN candidates.

## 6. Design decisions

| Decision | Why |
|---|---|
| MediaMTX for WebRTC → RTSP | Mature WHIP ingest and RTSP server with an HTTP auth hook. The app stays small: accounts, UI and glue. |
| WHIP proxied through the app | Only a logged-in stream can publish, and only to its own path. MediaMTX's HTTP side stays private, and the app can fix the ICE candidates in the answer. |
| Auth hook instead of MediaMTX users | Passwords live in one place, hashed; changing one takes effect for RTSP immediately. |
| Stateless signed cookies with a password-hash fingerprint | No session store, and a password change still revokes every session of that account. |
| JSON file store | One admin and a handful of streams: kept in memory, written atomically. |
| Plain ES2017, no build step, no frameworks | Old phones and tablets are the target devices. |
| `TRUST_PROXY=true` = private networks | Works for Nginx Proxy Manager on the same host or LAN without configuration, and clients can't fake their IP through it. |

## 7. Known limitations / ideas

- RTSP logins (MediaMTX, port 8554) aren't rate-limited by the app. Keep 8554 on the LAN or behind a VPN.
- Login limits are in memory with fixed windows. Anyone who can reach the login can use up an account's 50 failures, and new sign-ins to that account then wait until the window ends. Existing sessions keep working.
- Sessions can't be revoked one by one; logout only clears the cookie, and a password change revokes all sessions of that account.
- `/setup` is open until the admin account exists: create it before exposing the app.
- With `TRUST_PROXY=true`, hosts on the LAN that reach port 8080 directly can claim any client IP (the per-account limit still applies).
- One publisher per stream. The camera streams only while the page is open; mobile browsers may pause it in the background, and the page recovers when it becomes visible again.
- Audio is Opus (what browsers send); NVRs without Opus need audio off or an ffmpeg transcode.

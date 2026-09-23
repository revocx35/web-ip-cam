'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');

const { Store } = require('./db');
const sec = require('./security');
const { MediaMTX, APP_USER, resolveHostIPs, injectCandidates } = require('./mediamtx');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const config = {
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
  httpPort: parseInt(env.HTTP_PORT || '8080', 10),
  httpsPort: parseInt(env.HTTPS_PORT || '8443', 10),
  httpsEnabled: bool(env.HTTPS_ENABLED, true),
  internalPort: parseInt(env.INTERNAL_PORT || '9000', 10),
  tlsCert: env.TLS_CERT_FILE || '',
  tlsKey: env.TLS_KEY_FILE || '',
  trustProxy: env.TRUST_PROXY || '',
  mtxApi: env.MEDIAMTX_API_URL || 'http://mediamtx:9997',
  mtxWebrtc: env.MEDIAMTX_WEBRTC_URL || 'http://mediamtx:8889',
  rtspHost: env.RTSP_PUBLIC_HOST || '',
  rtspPort: parseInt(env.RTSP_PUBLIC_PORT || '8554', 10),
  webrtcPort: parseInt(env.WEBRTC_PUBLIC_PORT || '8189', 10),
  webrtcAutoCandidate: bool(env.WEBRTC_AUTO_CANDIDATE, true),
  // Origins allowed to show the app in an iframe (e.g. a Home Assistant dashboard)
  embedOrigins: (env.ALLOW_EMBED_FROM || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  webrtcExtraHosts: (env.WEBRTC_ADDITIONAL_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
};

const store = new Store(config.dataDir);
const mtx = new MediaMTX({ apiUrl: config.mtxApi, webrtcUrl: config.mtxWebrtc, secret: store.secret });
const limiter = new sec.RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

const COOKIE = 'wic_session';
const ADMIN_TTL = 7 * 24 * 3600 * 1000;
const STREAM_TTL = 365 * 24 * 3600 * 1000;
const STREAM_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIEWS = path.join(__dirname, '..', 'views');

for (const o of config.embedOrigins) {
  if (!/^https?:\/\/[^\s/;,']+$/.test(o)) throw new Error(`ALLOW_EMBED_FROM: "${o}" is not an origin like https://ha.example.com`);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(req, res, payload, ttl) {
  const token = sec.signToken({ ...payload, exp: Date.now() + ttl }, store.secret);
  const flags = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite(req)}`, `Max-Age=${Math.floor(ttl / 1000)}`];
  if (req.secure) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}

function clearSession(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite(req)}${req.secure ? '; Secure' : ''}; Max-Age=0`);
}

// When embedding is enabled the cookie must also be sent inside the iframe.
// SameSite=None requires Secure, so plain-HTTP requests fall back to Lax.
function sameSite(req) {
  if (!config.embedOrigins.length) return 'Strict';
  return req.secure ? 'None' : 'Lax';
}

// Returns { type: 'admin' } | { type: 'stream', name } | null
function getSession(req) {
  const payload = sec.verifyToken(parseCookies(req.headers.cookie)[COOKIE], store.secret);
  if (!payload) return null;
  if (payload.t === 'admin') {
    const admin = store.getAdmin();
    if (admin && payload.v === sec.hashVersion(admin.hash)) return { type: 'admin', username: admin.username };
  } else if (payload.t === 'stream') {
    const stream = store.getStream(payload.n);
    if (stream && payload.v === sec.hashVersion(stream.hash)) return { type: 'stream', name: stream.name };
  }
  return null;
}

function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s || s.type !== 'admin') return res.status(401).json({ error: 'Admin login required' });
  req.session = s;
  next();
}

function requireStream(req, res, next) {
  const s = getSession(req);
  if (!s || s.type !== 'stream') return res.status(401).json({ error: 'Stream login required' });
  req.session = s;
  next();
}

// ---------------------------------------------------------------------------
// Public web app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) {
  const tp = config.trustProxy;
  app.set('trust proxy', /^\d+$/.test(tp) ? parseInt(tp, 10) : bool(tp, false) || tp);
}

const frameAncestors = config.embedOrigins.length ? `'self' ${config.embedOrigins.join(' ')}` : "'none'";

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      `default-src 'self'; img-src 'self' data:; media-src 'self' blob: mediastream:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'self'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), screen-wake-lock=(self)',
  });
  if (!config.embedOrigins.length) res.set('X-Frame-Options', 'DENY');
  next();
});

app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

const page = (name) => (req, res) => res.sendFile(path.join(VIEWS, `${name}.html`));

app.get('/', (req, res) => {
  if (!store.getAdmin()) return res.redirect('/setup');
  const s = getSession(req);
  if (s && s.type === 'admin') return res.redirect('/admin');
  if (s && s.type === 'stream') return res.redirect('/camera');
  res.redirect('/login');
});

app.get('/setup', (req, res, next) => (store.getAdmin() ? res.redirect('/login') : page('setup')(req, res, next)));
app.get('/login', (req, res, next) => (store.getAdmin() ? page('login')(req, res, next) : res.redirect('/setup')));
app.get('/admin', (req, res, next) => {
  const s = getSession(req);
  return s && s.type === 'admin' ? page('admin')(req, res, next) : res.redirect('/login');
});
app.get('/camera', (req, res, next) => {
  const s = getSession(req);
  if (s && s.type === 'stream') return page('camera')(req, res, next);
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

const api = express.Router();
api.use(express.json({ limit: '16kb' }));

function rtspInfo(req, name) {
  const host = config.rtspHost || req.hostname;
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return { host, port: config.rtspPort, url: `rtsp://${hostPart}:${config.rtspPort}/${name}` };
}

function withCredentials(url, name, password) {
  return url.replace('rtsp://', `rtsp://${encodeURIComponent(name)}:${encodeURIComponent(password)}@`);
}

api.get('/state', (req, res) => {
  res.json({ setupDone: !!store.getAdmin(), session: getSession(req), secure: req.secure });
});

api.post('/setup', (req, res) => {
  if (store.getAdmin()) return res.status(409).json({ error: 'Admin account already exists' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^.{1,64}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Username must be 1-64 characters' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const hash = sec.hashPassword(password);
  store.setAdmin({ username: username.trim(), hash, createdAt: new Date().toISOString() });
  setSession(req, res, { t: 'admin', v: sec.hashVersion(hash) }, ADMIN_TTL);
  res.json({ ok: true });
});

api.post('/login/admin', (req, res) => {
  const key = `admin:${req.ip}`;
  if (limiter.blocked(key)) return res.status(429).json({ error: 'Too many attempts, try again later' });
  const admin = store.getAdmin();
  const { username, password } = req.body || {};
  if (!admin || typeof username !== 'string' || username.trim() !== admin.username || !sec.verifyPassword(password, admin.hash)) {
    limiter.fail(key);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  limiter.reset(key);
  setSession(req, res, { t: 'admin', v: sec.hashVersion(admin.hash) }, ADMIN_TTL);
  res.json({ ok: true });
});

api.post('/login/stream', (req, res) => {
  const key = `stream:${req.ip}`;
  if (limiter.blocked(key)) return res.status(429).json({ error: 'Too many attempts, try again later' });
  const { name, password } = req.body || {};
  const stream = typeof name === 'string' ? store.getStream(name.trim()) : null;
  if (!stream || !sec.verifyPassword(password, stream.hash)) {
    limiter.fail(key);
    return res.status(401).json({ error: 'Wrong stream name or password' });
  }
  limiter.reset(key);
  setSession(req, res, { t: 'stream', n: stream.name, v: sec.hashVersion(stream.hash) }, STREAM_TTL);
  res.json({ ok: true });
});

api.post('/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

api.put('/admin/password', requireAdmin, (req, res) => {
  const admin = store.getAdmin();
  const { current, password } = req.body || {};
  if (!sec.verifyPassword(current, admin.hash)) return res.status(403).json({ error: 'Current password is wrong' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const hash = sec.hashPassword(password);
  store.setAdmin({ ...admin, hash });
  setSession(req, res, { t: 'admin', v: sec.hashVersion(hash) }, ADMIN_TTL);
  res.json({ ok: true });
});

function validStreamPassword(p) {
  return typeof p === 'string' && p.length >= 4 && p.length <= 128;
}

api.get('/streams', requireAdmin, async (req, res) => {
  let status = null;
  let mediaServer = true;
  try {
    status = await mtx.pathStatus();
  } catch (err) {
    mediaServer = false;
  }
  const streams = store.listStreams().map((s) => {
    const st = status && status.get(s.name);
    return {
      name: s.name,
      createdAt: s.createdAt,
      rtsp: rtspInfo(req, s.name),
      live: !!(st && st.ready),
      liveSince: st && st.ready ? st.readyTime : null,
      viewers: st ? st.readers : 0,
      tracks: st ? st.tracks : [],
    };
  });
  res.json({ mediaServer, streams });
});

api.post('/streams', requireAdmin, (req, res) => {
  const { name, password } = req.body || {};
  if (typeof name !== 'string' || !STREAM_NAME_RE.test(name) || name === APP_USER) {
    return res.status(400).json({ error: 'Name may only contain letters, digits, "-" and "_" (max 64)' });
  }
  if (!validStreamPassword(password)) return res.status(400).json({ error: 'Password must be 4-128 characters' });
  if (store.getStream(name)) return res.status(409).json({ error: 'A stream with this name already exists' });
  store.putStream(name, { hash: sec.hashPassword(password), createdAt: new Date().toISOString() });
  const rtsp = rtspInfo(req, name);
  res.status(201).json({ name, rtsp, rtspUrlWithCredentials: withCredentials(rtsp.url, name, password) });
});

api.put('/streams/:name/password', requireAdmin, async (req, res) => {
  const stream = store.getStream(req.params.name);
  if (!stream) return res.status(404).json({ error: 'No such stream' });
  const { password } = req.body || {};
  if (!validStreamPassword(password)) return res.status(400).json({ error: 'Password must be 4-128 characters' });
  store.putStream(stream.name, { hash: sec.hashPassword(password) });
  verifyCache.clear();
  await mtx.kickPublisher(stream.name);
  const rtsp = rtspInfo(req, stream.name);
  res.json({ ok: true, rtspUrlWithCredentials: withCredentials(rtsp.url, stream.name, password) });
});

api.delete('/streams/:name', requireAdmin, async (req, res) => {
  const stream = store.getStream(req.params.name);
  if (!stream) return res.status(404).json({ error: 'No such stream' });
  store.deleteStream(stream.name);
  verifyCache.clear();
  await mtx.kickPublisher(stream.name);
  res.json({ ok: true });
});

// --- WHIP proxy: browser -> app -> MediaMTX --------------------------------
// The browser never talks HTTP to MediaMTX directly: the app authenticates
// the stream session, forwards the SDP offer with its own credentials, and
// patches reachable ICE candidates into the answer. Media then flows
// directly between the browser and MediaMTX's WebRTC port (UDP/TCP 8189).

const whipSessions = new Map(); // id -> { name, location, created }

function pruneWhipSessions() {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  for (const [id, s] of whipSessions) if (s.created < cutoff) whipSessions.delete(id);
}

api.post('/whip', requireStream, express.text({ type: 'application/sdp', limit: '256kb' }), async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.startsWith('v=')) {
    return res.status(400).json({ error: 'Expected an SDP offer' });
  }
  const name = req.session.name;
  let upstream;
  try {
    upstream = await mtx.whipPost(name, req.body);
  } catch (err) {
    console.error('WHIP upstream error:', err.message);
    return res.status(502).json({ error: 'Media server unreachable' });
  }
  const body = await upstream.text();
  if (upstream.status !== 201) {
    console.error(`WHIP upstream returned ${upstream.status}: ${body.slice(0, 200)}`);
    return res.status(502).json({ error: `Media server rejected the stream (${upstream.status})` });
  }

  let answer = body;
  // Browsers ignore hostname candidates, so everything is resolved to IPs.
  const hosts = [...config.webrtcExtraHosts];
  if (config.webrtcAutoCandidate) hosts.push(req.hostname);
  const ips = (await Promise.all(hosts.map(resolveHostIPs))).flat();
  answer = injectCandidates(answer, [...new Set(ips)], config.webrtcPort);

  const id = crypto.randomBytes(16).toString('hex');
  const location = upstream.headers.get('location');
  if (location) {
    pruneWhipSessions();
    const loc = new URL(location, config.mtxWebrtc + '/');
    whipSessions.set(id, { name, location: loc.pathname + loc.search, created: Date.now() });
  }
  res.status(201).set({ 'Content-Type': 'application/sdp', Location: `/api/whip/${id}` }).send(answer);
});

api.delete('/whip/:id', requireStream, async (req, res) => {
  const s = whipSessions.get(req.params.id);
  if (!s || s.name !== req.session.name) return res.status(404).end();
  whipSessions.delete(req.params.id);
  await mtx.whipDelete(s.location).catch(() => {});
  res.status(200).end();
});

api.get('/camera/status', requireStream, async (req, res) => {
  try {
    const st = (await mtx.pathStatus()).get(req.session.name);
    res.json({ name: req.session.name, live: !!(st && st.ready), viewers: st ? st.readers : 0, tracks: st ? st.tracks : [] });
  } catch {
    res.json({ name: req.session.name, live: null, viewers: 0, tracks: [] });
  }
});

api.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', api);

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Internal endpoint for MediaMTX external HTTP authentication
// (not published outside the Docker network)
// ---------------------------------------------------------------------------

// Cache of recently verified (stream, password) pairs so RTSP clients that
// re-authenticate every request don't cost a full scrypt each time.
const verifyCache = new Map();

function verifyStreamCredentials(stream, password) {
  const key = crypto.createHash('sha256').update(`${stream.name}\0${password}\0${stream.hash}`).digest('hex');
  if (verifyCache.has(key)) return true;
  if (!sec.verifyPassword(password, stream.hash)) return false;
  if (verifyCache.size > 1000) verifyCache.clear();
  verifyCache.set(key, true);
  return true;
}

const internal = express();
internal.disable('x-powered-by');
internal.use(express.json({ limit: '16kb' }));

internal.post('/mediamtx/auth', (req, res) => {
  const { user = '', password = '', action = '', path: p = '', protocol = '', ip = '' } = req.body || {};

  // The app itself (WHIP publishing on behalf of a logged-in camera, API calls)
  if (user === APP_USER && sec.safeEqual(password, store.secret)) return res.status(200).end();

  // RTSP / WebRTC viewers: username = stream name, password = stream password
  if (action === 'read' && user === p) {
    const stream = store.getStream(p);
    if (stream && verifyStreamCredentials(stream, password)) return res.status(200).end();
  }

  if (user) console.log(`Denied ${protocol} ${action} on "${p}" for user "${user}" from ${ip}`);
  res.status(401).end();
});

internal.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// TLS + startup
// ---------------------------------------------------------------------------

function loadTls() {
  if (config.tlsCert && config.tlsKey) {
    return { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) };
  }
  // Browsers only grant camera access on secure (HTTPS) origins, so generate
  // a long-lived self-signed certificate on first start.
  const dir = path.join(config.dataDir, 'certs');
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  if (!fs.existsSync(cert) || !fs.existsSync(key)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Generating self-signed TLS certificate...');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', key, '-out', cert,
      '-subj', '/CN=web-ip-cam',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    fs.chmodSync(key, 0o600);
  }
  return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
}

http.createServer(app).listen(config.httpPort, () => console.log(`HTTP  listening on :${config.httpPort}`));
if (config.httpsEnabled) {
  https.createServer(loadTls(), app).listen(config.httpsPort, () => console.log(`HTTPS listening on :${config.httpsPort}`));
}
internal.listen(config.internalPort, () => console.log(`Internal auth endpoint on :${config.internalPort}`));

if (!store.getAdmin()) console.log('No admin account yet - open the web UI to create one.');

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

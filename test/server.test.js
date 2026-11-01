'use strict';
// Unit-level tests against a real app process without MediaMTX: node --test test/server.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const http = require('http');

const PORT = 18000 + Math.floor(Math.random() * 1000);
let fakeMtx;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;

before(async () => {
  // A MediaMTX stand-in whose WHIP endpoint drops the connection halfway through the answer.
  fakeMtx = http.createServer((req, res) => {
    if (req.url.endsWith('/whip')) {
      res.writeHead(201, { 'Content-Type': 'application/sdp', 'Content-Length': '1000' });
      res.write('v=0\r\n');
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.writeHead(404).end();
  }).listen(PORT + 2);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wic-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DATA_DIR: dir, HTTPS_ENABLED: 'false', HTTP_PORT: String(PORT),
      INTERNAL_PORT: String(PORT + 1), MEDIAMTX_API_URL: 'http://127.0.0.1:1', MEDIAMTX_WEBRTC_URL: `http://127.0.0.1:${PORT + 2}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/state'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(() => { proc.kill(); fakeMtx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function adminCookie() {
  let res = await fetch(BASE + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse' }) });
  if (res.status === 409) {
    res = await fetch(BASE + '/api/login/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct horse' }) });
  }
  assert.strictEqual(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('a malformed cookie from another app on the same host does not break every page', async () => {
  const cookie = await adminCookie();
  const res = await fetch(BASE + '/api/state', { headers: { Cookie: `other=%E0%A4%A; ${cookie}` } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).session.type, 'admin');
});

const json = (method, body, cookie) => ({ method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body) });

test('a stream named __proto__ is refused instead of silently not being stored', async () => {
  const cookie = await adminCookie();
  const res = await fetch(BASE + '/api/streams', json('POST', { name: '__proto__', password: 'abcdefgh1' }, cookie));
  assert.strictEqual(res.status, 400);
});

test('a WHIP answer cut off by MediaMTX gives 502 and does not crash the app', async () => {
  const admin = await adminCookie();
  await fetch(BASE + '/api/streams', json('POST', { name: 'cam1', password: 'abcdefgh1' }, admin));
  const login = await fetch(BASE + '/api/login/stream', json('POST', { name: 'cam1', password: 'abcdefgh1' }));
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(BASE + '/api/whip', { method: 'POST', headers: { 'Content-Type': 'application/sdp', Cookie: cookie }, body: 'v=0\r\n' });
  assert.strictEqual(res.status, 502);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(proc.exitCode, null, 'app process exited');
  assert.strictEqual((await fetch(BASE + '/api/state')).status, 200);
});

test('API answers are not cached (they contain RTSP passwords)', async () => {
  const cookie = await adminCookie();
  const res = await fetch(BASE + '/api/streams', json('POST', { name: 'cam2', password: 'abcdefgh1' }, cookie));
  assert.strictEqual(res.status, 201);
  assert.match((await res.json()).rtspUrlWithCredentials, /abcdefgh1/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

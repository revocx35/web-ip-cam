'use strict';
// Unit-level tests against a real app process without MediaMTX: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wic-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, DATA_DIR: dir, HTTPS_ENABLED: 'false', HTTP_PORT: String(PORT),
      INTERNAL_PORT: String(PORT + 1), MEDIAMTX_API_URL: 'http://127.0.0.1:1', MEDIAMTX_WEBRTC_URL: 'http://127.0.0.1:1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/state'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

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

// Logs into the stream with a headless Chromium using a fake camera, waits
// until it is live, then checks the RTSP output with ffprobe.
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');

const BASE = 'https://localhost:8443';
const RTSP = 'rtsp://cam1:campass123@localhost:8554/cam1';

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('console', (m) => console.log('[browser]', m.text()));

  try {
    await page.goto(`${BASE}/login`);
    await page.fill('#stream-name', 'cam1');
    await page.fill('#stream-password', 'campass123');
    await page.click('#stream-form button[type=submit]');
    await page.waitForURL('**/camera');
    await page.waitForFunction(() => document.querySelector('#conn-badge').textContent === 'LIVE', null, { timeout: 45000 });
    console.log('Camera page is LIVE');

    // give MediaMTX a moment to receive keyframes
    await page.waitForTimeout(3000);
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-rtsp_transport', 'tcp', '-show_entries', 'stream=codec_type,codec_name,width,height',
      '-of', 'json', RTSP,
    ], { timeout: 30000 }).toString();
    console.log(out);
    const streams = JSON.parse(out).streams || [];
    if (!streams.some((s) => s.codec_type === 'video')) throw new Error('no video stream in RTSP output');
    if (!streams.some((s) => s.codec_type === 'audio')) throw new Error('no audio stream in RTSP output');
    console.log('RTSP output OK');
  } catch (err) {
    console.error('E2E failure:', err.message);
    console.error('Page status:', await page.textContent('#conn-badge').catch(() => '?'), '|', await page.textContent('#msg').catch(() => '?'));
    await page.screenshot({ path: 'e2e-failure.png' }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();

/**
 * Prints exactly what the Edge client puts on the wire - the WebSocket URL it
 * opens and the text frames it sends - in both the default mode and
 * ?edge_bare_ws=1. Useful when writing or debugging a relay: whatever appears
 * here is what the relay has to accept.
 *
 *   npm run dump-edge
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockEdgeServer } from './mock-edge-server.mjs';

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8150;
const EDGE_PORT = 8151;
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 600));

const edge = await startMockEdgeServer(EDGE_PORT);
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

async function capture(label, query) {
  const before = edge.report.requests.length;
  const page = await browser.newPage();
  await page.goto(`${BASE}/${query}`, { waitUntil: 'networkidle' });
  await page.setInputFiles('#file-input', fileURLToPath(new URL('../test-book.epub', import.meta.url)));
  await page.waitForSelector('.sent[data-i]', { timeout: 15000 });
  await page.locator('#btn-settings').click();
  await page.selectOption('#voice-select', 'edge:vi-VN-HoaiMyNeural');
  await page.locator('#panel-settings [data-close]').click();
  await page.locator('#btn-play').click();

  for (let i = 0; i < 60 && edge.report.requests.length === before; i++) {
    await page.waitForTimeout(250);
  }
  for (let i = 0; i < 40 && (edge.report.requests[before]?.frames.length ?? 0) < 2; i++) {
    await page.waitForTimeout(250);
  }
  await page.close();

  const request = edge.report.requests[before];
  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
  if (!request) {
    console.log('(không có kết nối nào tới máy chủ)');
    return;
  }
  console.log(`\n--- WebSocket URL (đường dẫn + query) ---\n${request.rawUrl}`);
  console.log(`\n--- Origin header ---\n${request.origin ?? '(không có)'}`);
  request.frames.forEach((frame, i) => {
    console.log(`\n--- Frame ${i + 1} (text) ---`);
    console.log(frame.replace(/\r\n/g, '\\r\\n\n'));
  });
}

await capture(
  'MẶC ĐỊNH - client tự xác thực như với endpoint thật của Microsoft',
  `?edge_endpoint=ws://localhost:${EDGE_PORT}/edge/v1&edge_format=mp3`,
);
await capture(
  'BARE - ?edge_bare_ws=1, URL không kèm tham số nào của client',
  `?edge_endpoint=ws://localhost:${EDGE_PORT}/edge/v1&edge_format=mp3&edge_bare_ws=1`,
);

console.log(`\n${'='.repeat(72)}`);
console.log('Máy chủ phải trả về: text frame Path:turn.start, một hoặc nhiều');
console.log('binary frame (2 byte big-endian độ dài header, header chứa Path:audio,');
console.log('rồi audio), và text frame Path:turn.end để kết thúc.');

await browser.close();
await edge.close();
server.kill();

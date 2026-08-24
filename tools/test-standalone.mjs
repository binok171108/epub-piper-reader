/**
 * Checks epub-reader-standalone.html the way it will actually be used: opened
 * straight off disk as a file:// page, with no server behind it.
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMockEdgeServer } from './mock-edge-server.mjs';

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const EDGE_PORT = 8161;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const fileUrl = pathToFileURL(fileURLToPath(new URL('../public/epub-reader-standalone.html', import.meta.url))).href;
const epub = fileURLToPath(new URL('../test-book.epub', import.meta.url));

// A deliberately slow relay: buffering only matters when synthesis takes time.
const edge = await startMockEdgeServer(EDGE_PORT, { delayMs: 700 });
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

try {
  await page.goto(fileUrl);
  check('mở được từ file:// (không cần server)', await page.locator('#welcome h1').isVisible());

  await page.setInputFiles('#file-input', epub);
  await page.waitForSelector('.sent[data-i]', { timeout: 20000 });
  check('mở EPUB', (await page.locator('#book-title').textContent()) === 'Sách thử nghiệm');

  const sentences = await page.$$eval('.sent[data-i]', (nodes) => nodes.length);
  check('tách câu', sentences === 7, `${sentences} câu`);
  check('ảnh hiển thị', (await page.$eval('#chapter img', (el) => el.naturalWidth)) > 0);

  await page.locator('#btn-toc').click();
  const toc = await page.$$eval('#toc-list button', (nodes) => nodes.map((n) => n.textContent));
  check('mục lục', JSON.stringify(toc) === JSON.stringify(['Chương một', 'Chương hai']), toc.join(' | '));
  await page.locator('#panel-toc [data-close]').click();

  // Point the Edge engine at the mock relay, exactly as a user would.
  await page.locator('#btn-settings').click();
  await page.selectOption('#engine-select', 'edge');
  await page.locator('#edge-endpoint').fill(`ws://localhost:${EDGE_PORT}/edge/v1`);
  await page.locator('#edge-endpoint').dispatchEvent('change');
  await page.locator('#edge-voice').fill('vi-VN-HoaiMyNeural');
  await page.locator('#edge-voice').dispatchEvent('change');
  check('chuyển sang Edge thì hiện ô relay', await page.locator('#field-edge').isVisible());
  await page.locator('#panel-settings [data-close]').click();

  const before = edge.report.requests.length;
  await page.locator('#btn-play').click();
  const duration = await page
    .waitForFunction(
      () => {
        const audio = document.getElementById('audio');
        return audio.src.startsWith('blob:') && audio.duration > 0.2 ? audio.duration : false;
      },
      null,
      { timeout: 40000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('Edge relay phát được audio từ file://', duration > 0.2, `${Number(duration).toFixed(2)}s`);

  // Batching: the whole seven-sentence chapter fits in one 700-character
  // request, so the relay is contacted once rather than seven times.
  const requests = edge.report.requests.length - before;
  check('gộp cả chương vào một yêu cầu', requests === 1, `${requests} yêu cầu cho 7 câu`);

  // Highlighting must still move sentence by sentence inside that one request,
  // which is what the WordBoundary metadata is for.
  const advanced = await page
    .waitForFunction(() => Number(document.querySelector('.sent--active')?.dataset.i ?? -1) >= 2, null, {
      timeout: 60000,
    })
    .then(() => true)
    .catch(() => false);
  check('vẫn highlight từng câu trong một yêu cầu', advanced);

  // Two colours: sentences with audio waiting, and the one being spoken.
  const colours = await page.evaluate(() => {
    const ready = [...document.querySelectorAll('.sent--ready')];
    const active = document.querySelector('.sent--active');
    const other = ready.find((el) => el !== active);
    const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    return { readyCount: ready.length, activeBg: bg(active), readyBg: bg(other) };
  });
  check('câu đã có audio được tô sẵn', colours.readyCount > 1, `${colours.readyCount} câu`);
  check(
    'câu đang đọc khác màu với câu chỉ mới có audio',
    Boolean(colours.activeBg) && colours.activeBg !== colours.readyBg,
    `đang đọc ${colours.activeBg} · đã đệm ${colours.readyBg}`,
  );
  check(
    'chỉ dùng một yêu cầu cho nhiều câu đã highlight',
    edge.report.requests.length - before === 1,
    `${edge.report.requests.length - before} yêu cầu`,
  );

  // The old cache claimed a slot with null, which read as "not cached" and made
  // every sentence be synthesised twice - once wasted, once waited on.
  const texts = edge.report.requests.map((r) => r.decoded).filter(Boolean);
  const duplicates = texts.filter((t, i) => texts.indexOf(t) !== i);
  check(
    'không câu nào bị tổng hợp hai lần',
    duplicates.length === 0,
    duplicates.length ? `trùng: ${JSON.stringify(duplicates.slice(0, 3))}` : `${texts.length} yêu cầu, không trùng`,
  );

  const request = edge.report.requests[before];
  check('gửi đúng giọng', request?.voice === 'vi-VN-HoaiMyNeural', String(request?.voice));
  check(
    'URL thuần, Origin là file://',
    request?.bare === true && !request.rawUrl.includes('?'),
    `${request?.rawUrl} origin=${request?.origin}`,
  );
  check('máy chủ không thấy lỗi giao thức', edge.report.problems.length === 0, edge.report.problems.join(' || '));

  await page.locator('#btn-play').click();

  // A relay that forwards no WordBoundary metadata: highlighting has to fall
  // back to estimating from character counts rather than stop moving.
  const plainPort = EDGE_PORT + 1;
  const plain = await startMockEdgeServer(plainPort, { delayMs: 200, metadata: false });
  const plainPage = await browser.newPage();
  plainPage.on('pageerror', (error) => errors.push(String(error)));
  await plainPage.goto(fileUrl);
  await plainPage.setInputFiles('#file-input', epub);
  await plainPage.waitForSelector('.sent[data-i]', { timeout: 20000 });
  await plainPage.locator('#btn-settings').click();
  await plainPage.selectOption('#engine-select', 'edge');
  await plainPage.locator('#edge-endpoint').fill(`ws://localhost:${plainPort}/edge/v1`);
  await plainPage.locator('#edge-endpoint').dispatchEvent('change');
  await plainPage.locator('#panel-settings [data-close]').click();
  await plainPage.locator('#btn-play').click();
  const fallback = await plainPage
    .waitForFunction(() => Number(document.querySelector('.sent--active')?.dataset.i ?? -1) >= 2, null, {
      timeout: 60000,
    })
    .then(() => true)
    .catch(() => false);
  check('không có metadata vẫn highlight được (ước lượng)', fallback);
  await plainPage.locator('#btn-play').click();
  await plainPage.close();
  await plain.close();

  // A relay that stalls on long input: the reader must shrink its requests and
  // keep going rather than stopping at the timeout.
  const stallPort = EDGE_PORT + 2;
  const stall = await startMockEdgeServer(stallPort, { maxChars: 120 });
  const stallPage = await browser.newPage();
  stallPage.on('pageerror', (error) => errors.push(String(error)));
  await stallPage.goto(
    `${fileUrl}?edge_endpoint=ws://localhost:${stallPort}/edge/v1` +
      '&engine=edge&edge_voice=vi-VN-HoaiMyNeural' +
      '&edge_timeout_base=800&edge_timeout_per_char=2',
  );
  await stallPage.setInputFiles('#file-input', epub);
  await stallPage.waitForSelector('.sent[data-i]', { timeout: 20000 });
  await stallPage.locator('#btn-play').click();

  const recovered = await stallPage
    .waitForFunction(
      () => {
        const audio = document.getElementById('audio');
        return audio.src.startsWith('blob:') && audio.duration > 0.2;
      },
      null,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  const shrunk = await stallPage.evaluate(() => Number(localStorage.getItem('chunkChars')));
  check('timeout thì tự giảm kích thước yêu cầu và đọc tiếp', recovered, `còn ${shrunk} ký tự`);
  check(
    'đã thực sự giảm xuống mức relay chịu được',
    shrunk > 0 && shrunk <= 120,
    `${shrunk} ký tự (relay chỉ nhận 120)`,
  );
  await stallPage.locator('#btn-play').click();
  await stallPage.close();
  await stall.close();

  // Headless Chromium exposes no speech voices; the page must say so, not break.
  await page.locator('#btn-settings').click();
  await page.selectOption('#engine-select', 'system');
  check('chuyển về giọng hệ thống không lỗi', await page.locator('#field-system').isVisible());
} catch (error) {
  check('chạy hết kịch bản', false, error.message);
} finally {
  const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('không có lỗi JavaScript', real.length === 0, real.slice(0, 3).join(' || '));
  await browser.close();
  await edge.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} kiểm tra đạt.`);
process.exit(failed.length ? 1 : 0);

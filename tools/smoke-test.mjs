/**
 * Headless smoke test: opens the app in Chromium, loads a generated EPUB and
 * checks parsing, segmentation, navigation, and that both WebAssembly
 * components (eSpeak-NG phonemiser and onnxruntime-web) actually boot.
 *
 * Voice models are NOT downloaded here - that needs network access to
 * Hugging Face and 60 MB of traffic.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockEdgeServer } from './mock-edge-server.mjs';

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 8123;
const EDGE_PORT = 8131;
const BASE = `http://localhost:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const server = spawn(process.execPath, [fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const stop = async (browser) => {
  await browser?.close();
  server.kill();
};

await new Promise((r) => setTimeout(r, 600));

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
  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('trang tải được', await page.locator('#welcome h1').isVisible());

  /* ---------------------------------------------------------- open EPUB */
  await page.setInputFiles('#file-input', fileURLToPath(new URL('../test-book.epub', import.meta.url)));
  await page.waitForSelector('.sent[data-i]', { timeout: 15000 });

  check('tiêu đề sách', (await page.locator('#book-title').textContent()) === 'Sách thử nghiệm');
  check('tác giả', (await page.locator('#book-author').textContent()) === 'Tác giả Thử');

  const sentences = await page.$$eval('.sent[data-i]', (nodes) =>
    nodes.map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
  );
  check('tách câu', sentences.length === 7, `${sentences.length} câu: ${JSON.stringify(sentences)}`);
  check('không tách ở số thập phân', sentences.some((s) => s.includes('12.500 đồng')));
  check('không tách ở viết tắt "TS."', sentences.some((s) => s.startsWith('TS. Nguyễn')));

  const bold = await page.$eval('.sent[data-i]:has(strong) strong', (el) => el.textContent);
  check('giữ định dạng inline', bold === 'chữ đậm ở giữa câu', bold);

  check('bỏ CSS của nhà xuất bản', (await page.locator('#chapter link, #chapter style').count()) === 0);

  const imageWidth = await page.$eval('#chapter img', (el) => el.naturalWidth);
  check('ảnh trong EPUB hiển thị được', imageWidth > 0, `naturalWidth=${imageWidth}`);

  /* ------------------------------------------------------- highlighting */
  await page.locator('.sent[data-i="2"]').click();
  check('bấm vào câu để chọn', await page.locator('.sent[data-i="2"]').evaluate((el) => el.classList.contains('sent--active')));

  /* --------------------------------------------------------------- TOC */
  await page.locator('#btn-toc').click();
  const tocLabels = await page.$$eval('#toc-list button', (nodes) => nodes.map((n) => n.textContent));
  check('mục lục', JSON.stringify(tocLabels) === JSON.stringify(['Chương một', 'Chương hai']), tocLabels.join(' | '));
  await page.locator('#toc-list button', { hasText: 'Chương hai' }).click();
  await page.waitForFunction(() => document.querySelector('#chapter h1')?.textContent === 'Chương hai');
  check('chuyển chương từ mục lục', true);

  /* ------------------------------------------------------ persistence */
  await page.waitForTimeout(300); // let the IndexedDB write commit
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.sent[data-i]', { timeout: 15000 });
  check('mở lại sách sau khi tải lại trang', (await page.locator('#book-title').textContent()) === 'Sách thử nghiệm');
  check('nhớ đúng chương', (await page.locator('#chapter h1').textContent()) === 'Chương hai');

  /* ---------------------------------------------- eSpeak-NG phonemiser */
  const phonemes = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/piper/piper_phonemize.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('không tải được piper_phonemize.js'));
      document.head.append(script);
    });
    const lines = [];
    const module = await window.createPiperPhonemize({
      print: (line) => lines.push(line),
      printErr: () => {},
      locateFile: (file) => `./vendor/piper/${file.split('/').pop()}`,
    });
    module.callMain([
      '-l', 'vi',
      '--input', JSON.stringify([{ text: 'Xin chào, đây là thử nghiệm.' }]),
      '--espeak_data', '/espeak-ng-data',
    ]);
    const line = lines.find((l) => l.includes('phoneme_ids'));
    return line ? JSON.parse(line) : null;
  });
  check(
    'eSpeak-NG WASM tạo phoneme tiếng Việt',
    Array.isArray(phonemes?.phoneme_ids) && phonemes.phoneme_ids.length > 20,
    phonemes ? `${phonemes.phoneme_ids.length} ids, "${phonemes.phonemes.slice(0, 8).join('')}…"` : 'không có kết quả',
  );

  /* --------------------------------------------------- onnxruntime-web */
  const ortResult = await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/ort/ort.wasm.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('không tải được ort.wasm.min.js'));
      document.head.append(script);
    });
    window.ort.env.wasm.wasmPaths = new URL('./vendor/ort/', location.href).href;
    window.ort.env.wasm.numThreads = 1;
    window.ort.env.logLevel = 'error';
    try {
      // Deliberately invalid model: reaching the protobuf parser proves the
      // WebAssembly runtime itself started up.
      await window.ort.InferenceSession.create(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      return 'unexpected-success';
    } catch (error) {
      return String(error.message ?? error);
    }
  });
  check(
    'onnxruntime-web WASM khởi động',
    /protobuf|Protobuf|deserialize|Load model|failed to load/i.test(ortResult),
    ortResult.slice(0, 120),
  );

  /* ------------------------------------------ end-to-end tổng hợp giọng */
  // Uses the tiny stand-in model from tools/make-test-model.mjs, which has the
  // same signature as a real Piper voice, so the whole worker path runs.
  const tts = await browser.newPage();
  tts.on('pageerror', (error) => errors.push(String(error)));
  await tts.goto(`${BASE}/?model=./test-assets/tiny.onnx&config=./test-assets/tiny.onnx.json`, {
    waitUntil: 'networkidle',
  });
  await tts.setInputFiles('#file-input', fileURLToPath(new URL('../test-book.epub', import.meta.url)));
  await tts.waitForSelector('.sent[data-i]', { timeout: 15000 });
  await tts.locator('#btn-play').click();

  // The unlock clip is a few tens of milliseconds of silence; anything longer
  // is audio the model actually produced.
  const duration = await tts
    .waitForFunction(
      () => {
        const audio = document.getElementById('audio');
        return audio.src.startsWith('blob:') && audio.duration > 0.2 ? audio.duration : false;
      },
      null,
      { timeout: 90000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('tổng hợp ra audio thật', duration > 0.2, `câu đầu dài ${Number(duration).toFixed(2)}s`);

  const activeIndex = () =>
    tts.evaluate(() => Number(document.querySelector('.sent--active')?.dataset.i ?? -1));
  const reached = await tts
    .waitForFunction(() => Number(document.querySelector('.sent--active')?.dataset.i ?? -1) >= 2, null, {
      timeout: 90000,
    })
    .then(() => true)
    .catch(() => false);
  check('tự chuyển câu khi đọc xong', reached, `đang ở câu ${await activeIndex()}`);

  const nextChapter = await tts
    .waitForFunction(() => document.querySelector('#chapter h1')?.textContent === 'Chương hai', null, {
      timeout: 120000,
    })
    .then(() => true)
    .catch(() => false);
  check('tự sang chương kế tiếp khi hết chương', nextChapter);

  await tts.locator('#btn-play').click(); // pause

  /* --------------------------------------------------------- offline */
  // Everything the app needs is cached by now: the shell via the service
  // worker, the WASM runtime via the runtime cache, the voice via the model
  // cache. Cutting the network must not change anything.
  await tts.context().setOffline(true);
  await tts.reload({ waitUntil: 'domcontentloaded' });
  const openedOffline = await tts
    .waitForSelector('.sent[data-i]', { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check('mở lại được khi không có mạng', openedOffline);

  if (openedOffline) {
    await tts.locator('#btn-play').click();
    const offlineAudio = await tts
      .waitForFunction(
        () => {
          const audio = document.getElementById('audio');
          return audio.src.startsWith('blob:') && audio.duration > 0.2;
        },
        null,
        { timeout: 90000 },
      )
      .then(() => true)
      .catch(() => false);
    check('vẫn tổng hợp được giọng khi không có mạng', offlineAudio);
  }
  await tts.context().setOffline(false);
  await tts.close();

  /* --------------------------------------------------------- Edge TTS */
  // Against tools/mock-edge-server.mjs, which speaks Microsoft's protocol and
  // recomputes the Sec-MS-GEC token itself to check what the client sent.
  const edge = await startMockEdgeServer(EDGE_PORT);
  const edgePage = await browser.newPage();
  edgePage.on('pageerror', (error) => errors.push(String(error)));
  const edgeQuery =
    `?edge_endpoint=ws://localhost:${EDGE_PORT}/edge/v1` +
    '&edge_format=riff-24khz-16bit-mono-pcm';
  await edgePage.goto(`${BASE}/${edgeQuery}`, { waitUntil: 'networkidle' });
  await edgePage.setInputFiles('#file-input', fileURLToPath(new URL('../test-book.epub', import.meta.url)));
  await edgePage.waitForSelector('.sent[data-i]', { timeout: 15000 });

  await edgePage.locator('#btn-settings').click();
  const groups = await edgePage.$$eval('#voice-select optgroup', (nodes) =>
    nodes.map((n) => n.label),
  );
  check(
    'giọng chia nhóm theo engine',
    groups.length === 2 && groups[0].includes('Trên máy'),
    groups.join(' | '),
  );

  await edgePage.locator('#edge-name').fill('vi-VN-NamMinhNeural');
  await edgePage.locator('#btn-add-edge').click();
  const added = await edgePage.$$eval('#voice-select option', (nodes) =>
    nodes.map((n) => n.value),
  );
  check('thêm được giọng Edge tự nhập', added.includes('edge:vi-VN-NamMinhNeural'));

  await edgePage.selectOption('#voice-select', 'edge:vi-VN-HoaiMyNeural');
  check(
    'chọn giọng Edge thì ẩn phần tải model',
    await edgePage.locator('#model-field').isHidden(),
  );
  await edgePage.locator('#panel-settings [data-close]').click();
  await edgePage.locator('#btn-play').click();

  const edgeDuration = await edgePage
    .waitForFunction(
      () => {
        const audio = document.getElementById('audio');
        return audio.src.startsWith('blob:') && audio.duration > 0.2 ? audio.duration : false;
      },
      null,
      { timeout: 30000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('Edge TTS trả về audio phát được', edgeDuration > 0.2, `${Number(edgeDuration).toFixed(2)}s`);

  const edgeAdvanced = await edgePage
    .waitForFunction(() => Number(document.querySelector('.sent--active')?.dataset.i ?? -1) >= 2, null, {
      timeout: 60000,
    })
    .then(() => true)
    .catch(() => false);
  check('Edge TTS đọc liên tiếp nhiều câu', edgeAdvanced);
  await edgePage.locator('#btn-play').click(); // pause
  await edgePage.close();

  const first = edge.report.requests[0] ?? {};
  check('máy chủ không thấy lỗi giao thức', edge.report.problems.length === 0, edge.report.problems.join(' || '));
  check('gửi đúng tên giọng', first.voice === 'vi-VN-HoaiMyNeural', String(first.voice));
  check('gửi đúng outputFormat', first.format === 'riff-24khz-16bit-mono-pcm', String(first.format));

  // Batching: the seven-sentence chapter goes out as one paragraph-sized
  // request rather than seven separate ones.
  // Playback runs into chapter two, so count only what chapter one cost.
  const chapterOne = edge.report.requests.filter((r) => r.decoded?.startsWith('Chương một'));
  check(
    'gộp cả chương vào một yêu cầu',
    chapterOne.length === 1,
    `${chapterOne.length} yêu cầu cho 7 câu`,
  );
  check(
    'yêu cầu chứa cả chương',
    first.decoded?.startsWith('Chương một') && first.decoded?.includes('kết thúc ở đây'),
    JSON.stringify(first.decoded?.slice(0, 60)),
  );
  // The chapter contains "Toán & Lý < Hoá." - it must arrive XML-escaped and
  // decode back to exactly the same characters.
  check(
    'escape XML đúng cho ký tự đặc biệt',
    first.text?.includes('Toán &amp; Lý &lt; Hoá.') && first.decoded?.includes('Toán & Lý < Hoá.'),
    first.text?.includes('&amp;') ? 'có escape' : 'không thấy escape',
  );
  // A relay that streams headerless PCM (?edge_format=pcm): the client has to
  // recognise there is no container and wrap the samples itself.
  const pcmPage = await browser.newPage();
  pcmPage.on('pageerror', (error) => errors.push(String(error)));
  await pcmPage.goto(
    `${BASE}/?edge_endpoint=ws://localhost:${EDGE_PORT}/edge/v1&edge_format=pcm`,
    { waitUntil: 'networkidle' },
  );
  // Each browser.newPage() gets its own context, so the book must be reopened.
  await pcmPage.setInputFiles('#file-input', fileURLToPath(new URL('../test-book.epub', import.meta.url)));
  await pcmPage.waitForSelector('.sent[data-i]', { timeout: 15000 });
  await pcmPage.locator('#btn-settings').click();
  await pcmPage.selectOption('#voice-select', 'edge:vi-VN-HoaiMyNeural');
  await pcmPage.locator('#panel-settings [data-close]').click();
  await pcmPage.locator('#btn-play').click();
  const pcmDuration = await pcmPage
    .waitForFunction(
      () => {
        const audio = document.getElementById('audio');
        return audio.src.startsWith('blob:') && audio.duration > 0.2 ? audio.duration : false;
      },
      null,
      { timeout: 30000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('phát được PCM thô từ relay', pcmDuration > 0.2, `${Number(pcmDuration).toFixed(2)}s`);
  await pcmPage.locator('#btn-play').click();
  await pcmPage.close();

  // ?edge_bare_ws=1: a relay that mints its own credentials wants the URL left
  // alone, so nothing of ours may appear in the query string.
  const barePage = await browser.newPage();
  barePage.on('pageerror', (error) => errors.push(String(error)));
  await barePage.goto(
    `${BASE}/?edge_endpoint=ws://localhost:${EDGE_PORT}/edge/v1&edge_bare_ws=1&edge_format=riff-24khz-16bit-mono-pcm`,
    { waitUntil: 'networkidle' },
  );
  await barePage.setInputFiles('#file-input', fileURLToPath(new URL('../test-book.epub', import.meta.url)));
  await barePage.waitForSelector('.sent[data-i]', { timeout: 15000 });
  await barePage.locator('#btn-settings').click();
  await barePage.selectOption('#voice-select', 'edge:vi-VN-HoaiMyNeural');
  await barePage.locator('#panel-settings [data-close]').click();
  const bareBefore = edge.report.requests.length;
  await barePage.locator('#btn-play').click();
  const bareDuration = await barePage
    .waitForFunction(
      () => {
        const audio = document.getElementById('audio');
        return audio.src.startsWith('blob:') && audio.duration > 0.2 ? audio.duration : false;
      },
      null,
      { timeout: 30000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check('bare WS vẫn tổng hợp được', bareDuration > 0.2, `${Number(bareDuration).toFixed(2)}s`);
  const bareRequest = edge.report.requests[bareBefore];
  check(
    'bare WS không gửi query nào',
    bareRequest?.bare === true && !bareRequest.rawUrl.includes('?'),
    bareRequest?.rawUrl ?? 'không có kết nối',
  );
  await barePage.locator('#btn-play').click();
  await barePage.close();

  await edge.close();

  /* --------------------------------------------------- service worker */
  const swActive = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active);
  });
  check('service worker hoạt động', swActive);
} catch (error) {
  check('chạy hết kịch bản', false, error.message);
} finally {
  const realErrors = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check('không có lỗi JavaScript', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));
  await stop(browser);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} kiểm tra đạt.`);
process.exit(failed.length ? 1 : 0);

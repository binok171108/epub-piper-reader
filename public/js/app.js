/**
 * UI layer: wires the EPUB parser, the sentence segmenter and the Piper
 * playback engine together.
 */
import { openEpub } from './epub.js';
import { segment } from './segment.js';
import { Reader } from './player.js';
import {
  allVoices,
  customVoice,
  edgeOptions,
  getVoice,
  modelUrls,
  rememberEdgeVoice,
  voiceForLanguage,
} from './voices.js';
import {
  cachedModelBytes,
  deleteBook,
  deleteModel,
  getBook,
  getPosition,
  isModelCached,
  listBooks,
  requestPersistence,
  saveBook,
  savePosition,
  storageEstimate,
} from './store.js';

const $ = (id) => document.getElementById(id);

const els = {
  body: document.body,
  title: $('book-title'),
  author: $('book-author'),
  chapter: $('chapter'),
  welcomeHint: $('welcome-hint'),
  player: $('player'),
  status: $('status'),
  progressFill: $('progress-fill'),
  play: $('btn-play'),
  scrim: $('scrim'),
  toast: $('toast'),
  bookList: $('book-list'),
  tocList: $('toc-list'),
  voiceSelect: $('voice-select'),
  voiceNote: $('voice-note'),
  edgeField: $('edge-field'),
  edgeName: $('edge-name'),
  addEdge: $('btn-add-edge'),
  modelField: $('model-field'),
  download: $('btn-download'),
  downloadProgress: $('download-progress'),
  downloadFill: $('download-fill'),
  storageInfo: $('storage-info'),
  rateRange: $('rate-range'),
  rateValue: $('rate-value'),
  rateChip: $('btn-rate'),
  lengthRange: $('length-range'),
  lengthValue: $('length-value'),
  fontRange: $('font-range'),
  optScroll: $('opt-scroll'),
  about: $('about'),
};

const settings = {
  voice: localStorage.getItem('voice') || '',
  rate: Number(localStorage.getItem('rate') || 1),
  lengthScale: Number(localStorage.getItem('lengthScale') || 1),
  fontSize: Number(localStorage.getItem('fontSize') || 18),
  autoScroll: localStorage.getItem('autoScroll') !== '0',
};

const reader = new Reader($('audio'));

let book = null;
let bookId = null;
let chapterIndex = 0;
let sentenceCount = 0;
let loadedVoiceId = null;
let voiceLoading = null;
let saveTimer = 0;

/* ------------------------------------------------------------------- ui */

function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function openPanel(id) {
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== id;
  els.scrim.hidden = false;
}

function closePanels() {
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true;
  els.scrim.hidden = true;
}

/* --------------------------------------------------------------- library */

async function refreshLibrary() {
  const books = await listBooks();
  els.bookList.replaceChildren();
  if (!books.length) {
    els.bookList.innerHTML = '<li><button disabled><small>Chưa có sách nào.</small></button></li>';
    return;
  }
  books.sort((a, b) => b.openedAt - a.openedAt);
  for (const record of books) {
    const li = document.createElement('li');
    li.className = 'row';
    const open = document.createElement('button');
    open.innerHTML = `${record.title}<small>${record.author || 'Không rõ tác giả'} · ${formatBytes(record.bytes)}</small>`;
    open.setAttribute('aria-current', String(record.id === bookId));
    open.addEventListener('click', () => {
      closePanels();
      loadBook(record.id);
    });
    const remove = document.createElement('button');
    remove.className = 'list__remove';
    remove.textContent = 'Xoá';
    remove.addEventListener('click', async () => {
      await deleteBook(record.id);
      refreshLibrary();
    });
    li.append(open, remove);
    els.bookList.append(li);
  }
}

async function importFile(file) {
  if (!file) return;
  els.welcomeHint.textContent = 'Đang mở tệp…';
  try {
    const buffer = await file.arrayBuffer();
    const parsed = await openEpub(buffer);
    const id = `${parsed.identifier || file.name}::${file.size}`;
    await saveBook({
      id,
      title: parsed.title,
      author: parsed.author,
      language: parsed.language,
      bytes: file.size,
      data: buffer,
      openedAt: Date.now(),
    });
    parsed.close();
    await refreshLibrary();
    await loadBook(id);
  } catch (error) {
    els.welcomeHint.textContent = '';
    toast(`Không mở được EPUB: ${error.message}`, 6000);
  }
}

async function loadBook(id) {
  const record = await getBook(id);
  if (!record) return;

  book?.close();
  reader.pause();
  book = await openEpub(record.data);
  bookId = id;
  record.openedAt = Date.now();
  saveBook(record);

  els.title.textContent = book.title;
  els.author.textContent = book.author;
  document.title = `${book.title} · Đọc EPUB`;
  els.body.dataset.view = 'reading';
  els.player.hidden = false;
  els.welcomeHint.textContent = '';

  // Match the book's language unless the reader picked a voice themselves.
  if (!localStorage.getItem('voice') && !customVoice()) {
    settings.voice = voiceForLanguage(book.language).id;
    els.voiceSelect.value = settings.voice;
    updateVoiceNote();
  }

  renderToc();
  const position = (await getPosition(id)) ?? { chapter: 0, sentence: 0 };
  showChapter(position.chapter, position.sentence);
  refreshStorageInfo();
}

function renderToc() {
  els.tocList.replaceChildren();
  for (const entry of book.toc) {
    const index = book.chapterIndexForPath(entry.path);
    if (index < 0) continue;
    const li = document.createElement('li');
    li.dataset.depth = String(Math.min(entry.depth, 2));
    const button = document.createElement('button');
    button.textContent = entry.label || `Phần ${index + 1}`;
    button.setAttribute('aria-current', String(index === chapterIndex));
    button.addEventListener('click', () => {
      closePanels();
      showChapter(index, 0);
    });
    li.append(button);
    els.tocList.append(li);
  }
}

/* --------------------------------------------------------------- chapter */

function showChapter(index, sentenceIndex = 0) {
  chapterIndex = Math.min(Math.max(index, 0), book.chapters.length - 1);
  els.chapter.hidden = false;
  els.chapter.innerHTML = book.chapterHtml(chapterIndex);

  const sentences = segment(els.chapter);
  sentenceCount = sentences.length;
  reader.load(sentences, sentenceIndex);
  highlight(reader.index, false);

  for (const button of els.tocList.querySelectorAll('button')) {
    button.setAttribute('aria-current', 'false');
  }
  window.scrollTo(0, 0);
  if (sentenceIndex > 0) highlight(sentenceIndex, true);
  if (!sentences.length) {
    els.status.textContent = 'Phần này không có văn bản để đọc.';
  }
  persistPosition(true);
}

function highlight(index, scroll) {
  for (const el of els.chapter.querySelectorAll('.sent--active')) el.classList.remove('sent--active');
  const target = els.chapter.querySelector(`.sent[data-i="${index}"]`);
  if (!target) return;
  target.classList.add('sent--active');
  if (scroll && settings.autoScroll) {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  els.progressFill.style.width = sentenceCount
    ? `${((index + 1) / sentenceCount) * 100}%`
    : '0%';
}

/** Sentence moves are debounced; chapter moves and page-hide write at once. */
function persistPosition(immediate = false) {
  clearTimeout(saveTimer);
  const write = () => {
    if (bookId) savePosition(bookId, { chapter: chapterIndex, sentence: reader.index });
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 800);
}

function changeChapter(delta, autoplay) {
  const next = chapterIndex + delta;
  if (next < 0 || next >= book.chapters.length) {
    toast(delta > 0 ? 'Đã hết sách.' : 'Đây là phần đầu tiên.');
    return;
  }
  showChapter(next, 0);
  if (autoplay) startPlayback();
}

/* ------------------------------------------------------------------- tts */

/** The privacy story differs per engine, so say which one is in effect. */
function updateAbout() {
  els.about.textContent =
    getVoice(settings.voice).provider === 'edge'
      ? 'Đang dùng Edge TTS: mỗi câu được gửi tới máy chủ Microsoft để tổng hợp, ' +
        'nên cần mạng và văn bản có rời khỏi máy. Chọn một giọng ở nhóm "Trên máy" ' +
        'để quay lại chế độ hoàn toàn offline.'
      : 'Giọng đọc do model Piper (VITS) chạy bằng WebAssembly ngay trên thiết bị tạo ra. ' +
        'Không có văn bản nào rời khỏi máy bạn.';
}

function updateVoiceNote() {
  const voice = getVoice(settings.voice);
  els.voiceNote.textContent = voice.note;
  updateAbout();

  // The Edge name field stays visible whatever is selected - it is the only
  // way to reach voices beyond the short built-in list.
  const isEdge = voice.provider === 'edge';
  els.modelField.hidden = isEdge;
  if (isEdge) return; // nothing to download

  isModelCached(modelUrls(voice).model).then((cached) => {
    els.download.textContent = cached ? 'Đã có trên máy ✓' : 'Tải model về máy';
    els.download.disabled = cached;
  });
}

/** Loads the selected voice, downloading it on first use. */
function ensureVoice() {
  const voice = getVoice(settings.voice);
  if (loadedVoiceId === voice.id) return Promise.resolve();
  if (voiceLoading) return voiceLoading;

  reader.lengthScale = settings.lengthScale === 1 ? null : settings.lengthScale;
  voiceLoading = reader
    .setVoice(voice, modelUrls(voice), edgeOptions())
    .then(() => {
      loadedVoiceId = voice.id;
      els.status.textContent = '';
      updateVoiceNote();
      refreshStorageInfo();
    })
    .catch((error) => {
      toast(`Không nạp được giọng đọc: ${error.message}`, 6000);
      throw error;
    })
    .finally(() => {
      voiceLoading = null;
      els.downloadProgress.hidden = true;
    });
  return voiceLoading;
}

async function startPlayback() {
  if (!book) return;
  reader.unlock(); // must happen inside the tap handler on iOS
  setupMediaSession();
  els.status.textContent = 'Đang chuẩn bị…';
  try {
    await ensureVoice();
  } catch {
    return;
  }
  reader.setRate(settings.rate);
  reader.play();
}

function setupMediaSession() {
  if (!('mediaSession' in navigator) || !book) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.title,
    artist: book.author || 'EPUB',
    album: book.toc[chapterIndex]?.label ?? '',
    artwork: book.coverUrl ? [{ src: book.coverUrl, sizes: '512x512' }] : [],
  });
  const handlers = {
    play: () => startPlayback(),
    pause: () => reader.pause(),
    previoustrack: () => reader.seek(reader.index - 1),
    nexttrack: () => reader.seek(reader.index + 1),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* unsupported action */
    }
  }
}

/* ------------------------------------------------------------- settings */

async function refreshStorageInfo() {
  const [cached, estimate] = await Promise.all([cachedModelBytes(), storageEstimate()]);
  const parts = [`Model đã lưu: ${formatBytes(cached)}`];
  if (estimate?.usage != null) parts.push(`tổng dữ liệu ứng dụng: ${formatBytes(estimate.usage)}`);
  els.storageInfo.textContent = `${parts.join(' · ')}.`;
}

function applySettings() {
  document.documentElement.style.setProperty('--reader-size', `${settings.fontSize}px`);
  els.rateRange.value = String(settings.rate);
  els.rateValue.textContent = `${settings.rate.toFixed(2)}×`;
  els.rateChip.textContent = `${settings.rate.toFixed(1)}×`;
  els.lengthRange.value = String(settings.lengthScale);
  els.lengthValue.textContent = settings.lengthScale === 1 ? 'mặc định' : settings.lengthScale.toFixed(2);
  els.fontRange.value = String(settings.fontSize);
  els.optScroll.checked = settings.autoScroll;
  reader.setRate(settings.rate);
}

function save(key, value) {
  localStorage.setItem(key, String(value));
}

/* --------------------------------------------------------------- events */

reader.addEventListener('sentence', (event) => {
  highlight(event.detail, true);
  persistPosition();
});

reader.addEventListener('state', (event) => {
  const playing = event.detail === 'playing';
  els.play.textContent = playing ? '❚❚' : '▶';
  els.play.setAttribute('aria-label', playing ? 'Tạm dừng' : 'Phát');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = event.detail;
});

reader.addEventListener('status', (event) => {
  els.status.textContent = event.detail.message;
});

reader.addEventListener('progress', (event) => {
  const { loaded, total, label } = event.detail;
  if (!total) return;
  els.downloadProgress.hidden = false;
  els.downloadFill.style.width = `${(loaded / total) * 100}%`;
  const what = label === 'model' ? 'model giọng' : 'cấu hình';
  els.status.textContent = `Đang tải ${what}: ${formatBytes(loaded)} / ${formatBytes(total)}`;
});

reader.addEventListener('failed', (event) => toast(event.detail, 6000));
reader.addEventListener('chapterend', () => changeChapter(1, true));

els.chapter.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-internal]');
  if (link) {
    const index = book.chapterIndexForPath(link.dataset.internal);
    if (index >= 0) showChapter(index, 0);
    return;
  }
  const sentence = event.target.closest('.sent[data-i]');
  if (!sentence) return;
  reader.seek(Number(sentence.dataset.i));
  persistPosition();
});

$('btn-play').addEventListener('click', () => (reader.playing ? reader.pause() : startPlayback()));
$('btn-prev').addEventListener('click', () => reader.seek(reader.index - 1));
$('btn-next').addEventListener('click', () => reader.seek(reader.index + 1));
$('btn-prev-chapter').addEventListener('click', () => changeChapter(-1, reader.playing));
$('btn-next-chapter').addEventListener('click', () => changeChapter(1, reader.playing));

els.rateChip.addEventListener('click', () => {
  const steps = [0.8, 1, 1.15, 1.3, 1.5, 1.75];
  const next = steps[(steps.findIndex((s) => s >= settings.rate) + 1) % steps.length];
  settings.rate = next;
  save('rate', next);
  applySettings();
});

$('btn-library').addEventListener('click', () => {
  refreshLibrary();
  openPanel('panel-library');
});
$('btn-toc').addEventListener('click', () => {
  if (book) renderToc();
  openPanel('panel-toc');
});
$('btn-settings').addEventListener('click', () => {
  refreshStorageInfo();
  openPanel('panel-settings');
});
els.scrim.addEventListener('click', closePanels);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', closePanels);
}

for (const input of [$('file-input'), $('file-input-2')]) {
  input.addEventListener('change', (event) => {
    closePanels();
    importFile(event.target.files[0]);
    event.target.value = '';
  });
}

els.voiceSelect.addEventListener('change', async () => {
  settings.voice = els.voiceSelect.value;
  save('voice', settings.voice);
  loadedVoiceId = null;
  updateVoiceNote();
  const wasPlaying = reader.playing;
  reader.pause();
  if (wasPlaying) startPlayback();
});

els.addEdge.addEventListener('click', () => {
  const name = els.edgeName.value.trim();
  if (!/^[a-z]{2,3}-[A-Za-z]{2,}-\w+$/.test(name)) {
    toast('Tên giọng không đúng dạng, ví dụ đúng: vi-VN-HoaiMyNeural', 5000);
    return;
  }
  rememberEdgeVoice(name);
  els.edgeName.value = '';
  settings.voice = `edge:${name}`;
  save('voice', settings.voice);
  loadedVoiceId = null;
  populateVoices();
  toast(`Đã thêm giọng ${name}.`);
});

els.download.addEventListener('click', async () => {
  els.download.disabled = true;
  els.download.textContent = 'Đang tải…';
  await requestPersistence();
  try {
    await ensureVoice();
    toast('Đã sẵn sàng dùng offline.');
  } catch {
    els.download.disabled = false;
  }
  updateVoiceNote();
  refreshStorageInfo();
});

$('btn-delete-model').addEventListener('click', async () => {
  const urls = modelUrls(getVoice(settings.voice));
  await deleteModel(urls.model, urls.config);
  loadedVoiceId = null;
  updateVoiceNote();
  refreshStorageInfo();
  toast('Đã xoá model khỏi máy.');
});

els.rateRange.addEventListener('input', () => {
  settings.rate = Number(els.rateRange.value);
  save('rate', settings.rate);
  applySettings();
});

els.lengthRange.addEventListener('change', () => {
  settings.lengthScale = Number(els.lengthRange.value);
  save('lengthScale', settings.lengthScale);
  reader.lengthScale = settings.lengthScale === 1 ? null : settings.lengthScale;
  applySettings();
  if (reader.sentenceCount) reader.seek(reader.index); // re-synthesise from here
});

els.fontRange.addEventListener('input', () => {
  settings.fontSize = Number(els.fontRange.value);
  save('fontSize', settings.fontSize);
  applySettings();
});

els.optScroll.addEventListener('change', () => {
  settings.autoScroll = els.optScroll.checked;
  save('autoScroll', settings.autoScroll ? '1' : '0');
});

for (const event of ['pagehide', 'visibilitychange']) {
  window.addEventListener(event, () => persistPosition(true));
}

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, textarea')) return;
  if (event.key === ' ') {
    event.preventDefault();
    reader.playing ? reader.pause() : startPlayback();
  } else if (event.key === 'ArrowRight') reader.seek(reader.index + 1);
  else if (event.key === 'ArrowLeft') reader.seek(reader.index - 1);
  else if (event.key === 'Escape') closePanels();
});

/* ---------------------------------------------------------------- start */

const GROUPS = [
  ['piper', 'Trên máy · chạy offline'],
  ['edge', 'Microsoft Edge · cần mạng'],
];

function populateVoices() {
  els.voiceSelect.replaceChildren();
  const voices = allVoices();
  for (const [provider, title] of GROUPS) {
    const group = document.createElement('optgroup');
    group.label = title;
    for (const voice of voices.filter((v) => v.provider === provider)) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.label} (${voice.quality})`;
      group.append(option);
    }
    if (group.children.length) els.voiceSelect.append(group);
  }

  // A voice passed on the URL wins over whatever was saved last time.
  const custom = customVoice();
  if (custom) settings.voice = custom.id;
  else if (!settings.voice || !voices.some((v) => v.id === settings.voice)) {
    settings.voice = voiceForLanguage(navigator.language).id;
  }
  els.voiceSelect.value = settings.voice;
  updateVoiceNote();
}

async function boot() {
  populateVoices();
  applySettings();
  await refreshLibrary();
  refreshStorageInfo();

  updateAbout();

  const books = await listBooks();
  if (books.length) {
    books.sort((a, b) => b.openedAt - a.openedAt);
    await loadBook(books[0].id);
  }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (error) {
      console.warn('Service worker không đăng ký được:', error);
    }
  }
}

boot();

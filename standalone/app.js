/**
 * Single-file build: the reader without the PWA machinery.
 *
 * A file:// page gets no service worker, no reliable IndexedDB and no way to
 * fetch the 39 MB Piper runtime, so this build drops the on-device engine and
 * offers the two things that do work from a lone HTML file: the voices iOS
 * already has, and an Edge TTS relay over WebSocket.
 *
 * openEpub, segment and EdgeTts are inlined ahead of this script by
 * tools/make-standalone.mjs.
 */

const $ = (id) => document.getElementById(id);

/** localStorage throws on file:// in some browsers; degrade to memory. */
const store = (() => {
  const memory = new Map();
  try {
    localStorage.setItem('__probe', '1');
    localStorage.removeItem('__probe');
    return {
      get: (k, d) => localStorage.getItem(k) ?? d,
      set: (k, v) => localStorage.setItem(k, String(v)),
    };
  } catch {
    return {
      get: (k, d) => (memory.has(k) ? memory.get(k) : d),
      set: (k, v) => memory.set(k, String(v)),
    };
  }
})();

const settings = {
  engine: store.get('engine', 'system'),
  systemVoice: store.get('systemVoice', ''),
  endpoint: store.get('endpoint', ''),
  edgeVoice: store.get('edgeVoice', 'vi-VN-HoaiMyNeural'),
  bareWs: store.get('bareWs', '1') === '1',
  mp3: store.get('mp3', '1') === '1',
  rate: Number(store.get('rate', 1)),
  autoScroll: store.get('autoScroll', '1') === '1',
  fontSize: Number(store.get('fontSize', 18)),
};

let book = null;
let chapterIndex = 0;
let sentences = [];

/* --------------------------------------------------------------- helpers */

function toast(message, ms = 3600) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function openPanel(id) {
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== id;
  $('scrim').hidden = false;
}

function closePanels() {
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = true;
  $('scrim').hidden = true;
}

/* --------------------------------------------------------- system voices */

/** iOS ships the voice list asynchronously; wait for it once. */
function systemVoices() {
  return new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length) {
      resolve(existing);
      return;
    }
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener('voiceschanged', done);
    setTimeout(done, 2000);
  });
}

/** Long utterances get cut off on iOS, so each sentence is spoken in pieces. */
function speechChunks(text, max = 180) {
  if (text.length <= max) return [text];
  const parts = text.match(/[^,;:—–]+[,;:—–]*\s*/g) ?? [text];
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if (current && (current + part).length > max) {
      chunks.push(current.trim());
      current = '';
    }
    current += part;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

class SystemEngine {
  constructor() {
    this.voices = [];
  }

  async ready() {
    this.voices = await systemVoices();
  }

  /** Resolves when the whole sentence has been spoken. */
  speak(text, { rate, voiceUri, signal }) {
    return new Promise((resolve, reject) => {
      const pieces = speechChunks(text);
      let spoken = 0;
      const voice = this.voices.find((v) => v.voiceURI === voiceUri);

      const onAbort = () => {
        speechSynthesis.cancel();
        reject(new Error('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const next = () => {
        if (signal?.aborted) return;
        if (spoken >= pieces.length) {
          signal?.removeEventListener('abort', onAbort);
          resolve();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(pieces[spoken++]);
        utterance.rate = rate;
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        utterance.onend = next;
        utterance.onerror = (event) => {
          if (event.error === 'interrupted' || event.error === 'canceled') return;
          signal?.removeEventListener('abort', onAbort);
          reject(new Error(event.error || 'lỗi giọng hệ thống'));
        };
        speechSynthesis.speak(utterance);
      };

      speechSynthesis.cancel();
      next();
    });
  }

  stop() {
    speechSynthesis.cancel();
  }
}

/* ------------------------------------------------------------ edge relay */

class EdgeEngine {
  constructor(audio) {
    this.audio = audio;
    this.client = null;
    this.cache = new Map();
    this.generation = 0;
  }

  configure() {
    if (!settings.endpoint) throw new Error('Chưa nhập địa chỉ relay trong Cài đặt.');
    this.client = new EdgeTts({
      voice: settings.edgeVoice,
      endpoint: settings.endpoint,
      bareWs: settings.bareWs,
      format: settings.mp3 ? 'audio-24khz-48kbitrate-mono-mp3' : 'riff-24khz-16bit-mono-pcm',
    });
    this.reset();
  }

  reset() {
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.generation++;
  }

  /** Renders ahead so the next sentence is usually ready in time. */
  prefetch(index) {
    for (let i = index; i <= index + 2; i++) {
      if (i >= sentences.length || this.cache.has(i)) continue;
      this.cache.set(i, null); // claim the slot
      const generation = this.generation;
      this.client
        .synthesize(sentences[i])
        .then((blob) => {
          if (generation === this.generation) this.cache.set(i, URL.createObjectURL(blob));
          else this.cache.delete(i);
        })
        .catch(() => this.cache.delete(i));
    }
  }

  async speak(index, { rate, signal }) {
    if (!this.client) this.configure();
    this.prefetch(index);

    let url = this.cache.get(index);
    if (!url) {
      const generation = this.generation;
      const blob = await this.client.synthesize(sentences[index], { signal });
      if (generation !== this.generation) throw new Error('cancelled');
      url = URL.createObjectURL(blob);
      this.cache.set(index, url);
    }
    this.prefetch(index + 1);

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.audio.onended = null;
        this.audio.onerror = null;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        this.audio.pause();
        reject(new Error('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.audio.onended = () => {
        cleanup();
        resolve();
      };
      this.audio.onerror = () => {
        cleanup();
        reject(new Error('Không phát được audio trả về từ relay.'));
      };
      this.audio.src = url;
      this.audio.playbackRate = rate;
      this.audio.play().catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  stop() {
    this.audio.pause();
    this.generation++;
  }
}

/* ---------------------------------------------------------------- player */

const engines = { system: new SystemEngine(), edge: new EdgeEngine($('audio')) };

const player = {
  index: 0,
  playing: false,
  abort: null,
  unlocked: false,

  /** iOS only lets an <audio> element play if it started inside a gesture. */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    const audio = $('audio');
    audio.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
    audio.play().catch(() => {});
  },

  async start(from = null) {
    if (!sentences.length) return;
    if (from != null) this.index = from;
    this.unlock();
    this.playing = true;
    this.setButton();

    if (settings.engine === 'system') await engines.system.ready();
    else {
      try {
        engines.edge.configure();
      } catch (error) {
        this.stop();
        toast(error.message, 5000);
        return;
      }
    }
    this.loop();
  },

  async loop() {
    while (this.playing && this.index < sentences.length) {
      this.abort = new AbortController();
      highlight(this.index, true);
      $('status').textContent = '';
      try {
        if (settings.engine === 'system') {
          await engines.system.speak(sentences[this.index], {
            rate: settings.rate,
            voiceUri: settings.systemVoice,
            signal: this.abort.signal,
          });
        } else {
          $('status').textContent = 'Đang tổng hợp…';
          await engines.edge.speak(this.index, {
            rate: settings.rate,
            signal: this.abort.signal,
          });
        }
      } catch (error) {
        if (error.message === 'cancelled') return; // seek or pause took over
        this.stop();
        toast(error.message, 6000);
        return;
      }
      if (!this.playing) return;
      this.index++;
    }
    if (this.playing) {
      this.stop();
      changeChapter(1, true);
    }
  },

  stop() {
    this.playing = false;
    this.abort?.abort();
    engines.system.stop();
    engines.edge.stop();
    $('status').textContent = '';
    this.setButton();
  },

  seek(index) {
    const target = Math.min(Math.max(index, 0), Math.max(sentences.length - 1, 0));
    this.index = target;
    highlight(target, true);
    if (this.playing) {
      this.abort?.abort();
      engines.system.stop();
      engines.edge.stop();
      this.loop();
    }
  },

  setButton() {
    $('btn-play').textContent = this.playing ? '❚❚' : '▶';
  },
};

/* --------------------------------------------------------------- chapter */

function highlight(index, scroll) {
  for (const el of $('chapter').querySelectorAll('.sent--active')) {
    el.classList.remove('sent--active');
  }
  const target = $('chapter').querySelector(`.sent[data-i="${index}"]`);
  $('progress-fill').style.width = sentences.length
    ? `${((index + 1) / sentences.length) * 100}%`
    : '0%';
  if (!target) return;
  target.classList.add('sent--active');
  if (scroll && settings.autoScroll) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function showChapter(index, sentenceIndex = 0) {
  chapterIndex = Math.min(Math.max(index, 0), book.chapters.length - 1);
  $('chapter').hidden = false;
  $('chapter').innerHTML = book.chapterHtml(chapterIndex);
  sentences = segment($('chapter'));
  engines.edge.reset();
  player.index = sentenceIndex;
  window.scrollTo(0, 0);
  highlight(sentenceIndex, sentenceIndex > 0);
  if (!sentences.length) $('status').textContent = 'Phần này không có văn bản để đọc.';
}

function changeChapter(delta, autoplay) {
  const next = chapterIndex + delta;
  if (next < 0 || next >= book.chapters.length) {
    toast(delta > 0 ? 'Đã hết sách.' : 'Đây là phần đầu tiên.');
    return;
  }
  showChapter(next, 0);
  renderToc();
  if (autoplay) player.start(0);
}

function renderToc() {
  const list = $('toc-list');
  list.replaceChildren();
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
      const wasPlaying = player.playing;
      player.stop();
      showChapter(index, 0);
      if (wasPlaying) player.start(0);
    });
    li.append(button);
    list.append(li);
  }
}

async function openFile(file) {
  if (!file) return;
  $('welcome-hint').textContent = 'Đang mở tệp…';
  try {
    book?.close();
    book = await openEpub(await file.arrayBuffer());
    $('book-title').textContent = book.title;
    $('book-author').textContent = book.author;
    document.title = `${book.title} · Đọc EPUB`;
    document.body.dataset.view = 'reading';
    $('player').hidden = false;
    $('welcome-hint').textContent = '';
    renderToc();
    showChapter(0, 0);
  } catch (error) {
    $('welcome-hint').textContent = '';
    toast(`Không mở được EPUB: ${error.message}`, 6000);
  }
}

/* -------------------------------------------------------------- settings */

function applySettings() {
  document.documentElement.style.setProperty('--reader-size', `${settings.fontSize}px`);
  $('engine-select').value = settings.engine;
  $('field-system').hidden = settings.engine !== 'system';
  $('field-edge').hidden = settings.engine !== 'edge';
  $('edge-endpoint').value = settings.endpoint;
  $('edge-voice').value = settings.edgeVoice;
  $('edge-bare').checked = settings.bareWs;
  $('edge-mp3').checked = settings.mp3;
  $('rate-range').value = String(settings.rate);
  $('rate-value').textContent = `${settings.rate.toFixed(2)}×`;
  $('btn-rate').textContent = `${settings.rate.toFixed(1)}×`;
  $('font-range').value = String(settings.fontSize);
  $('opt-scroll').checked = settings.autoScroll;
  $('about').textContent =
    settings.engine === 'edge'
      ? 'Mỗi câu được gửi tới relay để tổng hợp, nên cần mạng và văn bản có rời khỏi máy.'
      : 'Giọng do iOS tổng hợp ngay trên máy. Không có văn bản nào rời khỏi thiết bị.';
}

async function fillSystemVoices() {
  const select = $('system-voice');
  const voices = await systemVoices();
  select.replaceChildren();
  const sorted = [...voices].sort((a, b) => {
    const vi = (v) => (v.lang.toLowerCase().startsWith('vi') ? 0 : 1);
    return vi(a) - vi(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
  });
  for (const voice of sorted) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    select.append(option);
  }
  if (!sorted.length) {
    select.innerHTML = '<option value="">Trình duyệt không báo giọng nào</option>';
    return;
  }
  if (!settings.systemVoice || !sorted.some((v) => v.voiceURI === settings.systemVoice)) {
    settings.systemVoice = sorted[0].voiceURI;
  }
  select.value = settings.systemVoice;
}

/* ---------------------------------------------------------------- events */

$('file-input').addEventListener('change', (event) => {
  openFile(event.target.files[0]);
  event.target.value = '';
});
$('btn-open').addEventListener('click', () => $('file-input').click());

$('chapter').addEventListener('click', (event) => {
  const link = event.target.closest('a[data-internal]');
  if (link) {
    const index = book.chapterIndexForPath(link.dataset.internal);
    if (index >= 0) {
      const wasPlaying = player.playing;
      player.stop();
      showChapter(index, 0);
      if (wasPlaying) player.start(0);
    }
    return;
  }
  const sentence = event.target.closest('.sent[data-i]');
  if (sentence) player.seek(Number(sentence.dataset.i));
});

$('btn-play').addEventListener('click', () => (player.playing ? player.stop() : player.start()));
$('btn-prev').addEventListener('click', () => player.seek(player.index - 1));
$('btn-next').addEventListener('click', () => player.seek(player.index + 1));
$('btn-prev-chapter').addEventListener('click', () => {
  const wasPlaying = player.playing;
  player.stop();
  changeChapter(-1, wasPlaying);
});
$('btn-next-chapter').addEventListener('click', () => {
  const wasPlaying = player.playing;
  player.stop();
  changeChapter(1, wasPlaying);
});

$('btn-rate').addEventListener('click', () => {
  const steps = [0.8, 1, 1.15, 1.3, 1.5, 1.75];
  settings.rate = steps[(steps.findIndex((s) => s >= settings.rate) + 1) % steps.length];
  store.set('rate', settings.rate);
  applySettings();
});

$('btn-toc').addEventListener('click', () => {
  if (book) renderToc();
  openPanel('panel-toc');
});
$('btn-settings').addEventListener('click', () => openPanel('panel-settings'));
$('scrim').addEventListener('click', closePanels);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', closePanels);
}

$('engine-select').addEventListener('change', () => {
  player.stop();
  settings.engine = $('engine-select').value;
  store.set('engine', settings.engine);
  applySettings();
});

for (const [id, key, prop] of [
  ['edge-endpoint', 'endpoint', 'value'],
  ['edge-voice', 'edgeVoice', 'value'],
  ['edge-bare', 'bareWs', 'checked'],
  ['edge-mp3', 'mp3', 'checked'],
]) {
  $(id).addEventListener('change', () => {
    settings[key] = $(id)[prop];
    store.set(key, prop === 'checked' ? (settings[key] ? '1' : '0') : settings[key]);
    engines.edge.client = null; // rebuilt with the new settings on next play
    engines.edge.reset();
    applySettings();
  });
}

$('system-voice').addEventListener('change', () => {
  settings.systemVoice = $('system-voice').value;
  store.set('systemVoice', settings.systemVoice);
});

$('rate-range').addEventListener('input', () => {
  settings.rate = Number($('rate-range').value);
  store.set('rate', settings.rate);
  applySettings();
});

$('font-range').addEventListener('input', () => {
  settings.fontSize = Number($('font-range').value);
  store.set('fontSize', settings.fontSize);
  applySettings();
});

$('opt-scroll').addEventListener('change', () => {
  settings.autoScroll = $('opt-scroll').checked;
  store.set('autoScroll', settings.autoScroll ? '1' : '0');
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, textarea')) return;
  if (event.key === ' ') {
    event.preventDefault();
    player.playing ? player.stop() : player.start();
  } else if (event.key === 'ArrowRight') player.seek(player.index + 1);
  else if (event.key === 'ArrowLeft') player.seek(player.index - 1);
  else if (event.key === 'Escape') closePanels();
});

/* ----------------------------------------------------------------- start */

// Settings can also be seeded from the URL, which makes a bookmark enough to
// configure the relay: ?edge_endpoint=...&edge_voice=...&engine=edge
const params = new URLSearchParams(location.search);
if (params.get('edge_endpoint')) {
  settings.endpoint = params.get('edge_endpoint');
  settings.engine = 'edge';
}
if (params.get('edge_voice')) settings.edgeVoice = params.get('edge_voice');
if (params.get('engine')) settings.engine = params.get('engine');

applySettings();
fillSystemVoices().then(applySettings);

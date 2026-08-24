import { EdgeTts } from './edge-tts.js';
import { activeSentence, buildChunks, chunkIndexBySentence, sentenceStarts } from './chunking.js';

/**
 * Drives playback through a single <audio> element, which is what gives iOS
 * lock-screen controls and lets audio continue when the screen turns off.
 *
 * The queue works in *units*, not sentences. Piper runs on the device, so one
 * sentence per unit keeps latency low. Edge voices go over the network, where
 * a request costs a connection setup regardless of how much audio comes back -
 * there a unit is a whole paragraph, and sentence highlighting is recovered
 * from the WordBoundary metadata inside it.
 */

/** How many units to synthesise ahead of the one being played. */
const LOOKAHEAD = 2;

export function encodeWav(pcm, sampleRate) {
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

export class Reader extends EventTarget {
  #worker = null;
  #edge = null;
  #provider = 'piper';
  #abort = new AbortController();
  #pending = new Map(); // request id -> {resolve, reject}
  #nextId = 1;
  #ready = null;
  #cache = new Map(); // unit index -> {url, boundaries}
  #inFlight = new Set();
  #failed = new Set();
  #generation = 0;
  #sentences = [];
  #units = [];
  #unitOf = []; // sentence index -> unit index
  #index = 0; // sentence index
  #unit = -1; // unit currently loaded into the audio element
  #starts = null; // sentence start times inside that unit
  #playing = false;
  #unlocked = false;

  constructor(audio) {
    super();
    this.audio = audio;
    this.lengthScale = null;
    this.rate = 1;
    /** Characters per request for network voices. */
    this.chunkChars = 700;
    this.lastStat = null;
    this.audio.addEventListener('ended', () => this.#advance());
    this.audio.addEventListener('error', () => {
      if (this.#playing) this.#advance();
    });
    this.audio.addEventListener('timeupdate', () => this.#followAudio());
  }

  get index() {
    return this.#index;
  }

  get playing() {
    return this.#playing;
  }

  get sentenceCount() {
    return this.#sentences.length;
  }

  /** Throughput of the last network request, or null for on-device voices. */
  get stat() {
    return this.lastStat;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ------------------------------------------------------------- worker */

  #ensureWorker() {
    if (this.#worker) return this.#worker;
    this.#worker = new Worker(new URL('./tts-worker.js', import.meta.url));
    this.#worker.onmessage = ({ data }) => {
      if (data.type === 'audio') {
        this.#pending.get(data.id)?.resolve(data);
        this.#pending.delete(data.id);
      } else if (data.type === 'error' && data.id != null) {
        this.#pending.get(data.id)?.reject(new Error(data.message));
        this.#pending.delete(data.id);
      } else if (data.type === 'error') {
        this.#emit('failed', data.message);
      } else if (data.type === 'ready') {
        this.#emit('ready', data);
      } else {
        this.#emit(data.type, data); // status | progress
      }
    };
    return this.#worker;
  }

  /**
   * Selects the voice to read with. Edge voices are ready immediately; Piper
   * voices have to be downloaded and loaded into the worker first.
   */
  setVoice(voice, urls, edgeOptions = {}) {
    this.#clearCache();
    this.#provider = voice.provider;
    this.#rebuildUnits();

    if (voice.provider === 'edge') {
      this.#edge = new EdgeTts({ voice: voice.name, ...edgeOptions });
      this.#ready = Promise.resolve({ voice: voice.id });
      this.#emit('status', { message: '' });
      return this.#ready;
    }

    this.#edge = null;
    const worker = this.#ensureWorker();
    this.#ready = new Promise((resolve, reject) => {
      const onReady = (event) => {
        cleanup();
        resolve(event.detail);
      };
      const onFail = (event) => {
        cleanup();
        reject(new Error(event.detail));
      };
      const cleanup = () => {
        this.removeEventListener('ready', onReady);
        this.removeEventListener('failed', onFail);
      };
      this.addEventListener('ready', onReady);
      this.addEventListener('failed', onFail);
    });
    worker.postMessage({ type: 'init', voice: voice.id, modelUrl: urls.model, configUrl: urls.config });
    return this.#ready;
  }

  /* --------------------------------------------------------------- units */

  #rebuildUnits() {
    this.#units =
      this.#provider === 'edge'
        ? buildChunks(this.#sentences, this.chunkChars)
        : this.#sentences.map((text, index) => ({
            text,
            first: index,
            last: index,
            ranges: [{ index, start: 0 }],
          }));
    this.#unitOf = chunkIndexBySentence(this.#units);
    this.#unit = -1;
    this.#starts = null;
  }

  /** Piper's synthesis-speed knob expressed the way Edge wants it. */
  #edgeRate() {
    if (!this.lengthScale) return '+0%';
    const percent = Math.round((1 / this.lengthScale - 1) * 100);
    return `${percent >= 0 ? '+' : ''}${percent}%`;
  }

  /** Produces one unit of audio, whichever engine is selected. */
  #renderUnit(text) {
    if (this.#edge) {
      this.#edge.rate = this.#edgeRate();
      const started = performance.now();
      return this.#edge.synthesize(text, { signal: this.#abort.signal }).then(({ blob, boundaries }) => {
        this.lastStat = { chars: text.length, ms: Math.round(performance.now() - started) };
        return { url: URL.createObjectURL(blob), boundaries };
      });
    }
    if (!this.#worker) return Promise.reject(new Error('Chưa chọn giọng đọc.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ type: 'synth', id, text, lengthScale: this.lengthScale });
    }).then(({ pcm, sampleRate }) => ({
      url: URL.createObjectURL(encodeWav(pcm, sampleRate)),
      boundaries: null,
    }));
  }

  /* -------------------------------------------------------------- queue */

  #clearCache() {
    for (const entry of this.#cache.values()) URL.revokeObjectURL(entry.url);
    this.#cache.clear();
    this.#inFlight.clear();
    this.#failed.clear();
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#unit = -1;
    this.#starts = null;
  }

  async #prepare(unit) {
    if (unit < 0 || unit >= this.#units.length) return;
    if (this.#cache.has(unit) || this.#inFlight.has(unit)) return;
    if (this.#failed.has(unit)) return; // a failure must not retry in a loop

    const generation = this.#generation;
    this.#inFlight.add(unit);
    try {
      const rendered = await this.#renderUnit(this.#units[unit].text);
      if (generation !== this.#generation) {
        URL.revokeObjectURL(rendered.url);
        return; // seeked away while rendering
      }
      this.#cache.set(unit, rendered);
      this.#emit('buffered', unit);
      if (this.#playing && unit === this.#unitOf[this.#index] && this.audio.paused) {
        this.#playCurrent();
      }
    } catch (error) {
      if (generation === this.#generation) {
        this.#failed.add(unit);
        this.#emit('failed', error.message);
      }
    } finally {
      this.#inFlight.delete(unit);
      this.#trim();
      this.#fill();
    }
  }

  #fill() {
    if (!this.#ready) return; // no voice selected yet
    const from = this.#unitOf[this.#index] ?? 0;
    for (let i = from; i <= from + LOOKAHEAD; i++) this.#prepare(i);
  }

  /** Drops audio well behind or ahead of the cursor to bound memory use. */
  #trim() {
    const from = this.#unitOf[this.#index] ?? 0;
    for (const [unit, entry] of this.#cache) {
      if (unit < from - 1 || unit > from + LOOKAHEAD + 1) {
        URL.revokeObjectURL(entry.url);
        this.#cache.delete(unit);
      }
    }
  }

  /* ----------------------------------------------------------- playback */

  /** iOS only lets an <audio> element play if it was started by a gesture. */
  unlock() {
    if (this.#unlocked) return;
    this.#unlocked = true;
    const silence = URL.createObjectURL(encodeWav(new Float32Array(1024), 22050));
    this.audio.src = silence;
    this.audio.play().catch(() => {}).finally(() => URL.revokeObjectURL(silence));
  }

  load(sentences, startIndex = 0) {
    this.#clearCache();
    this.#sentences = sentences;
    this.#index = Math.min(Math.max(startIndex, 0), Math.max(sentences.length - 1, 0));
    this.#rebuildUnits();
    this.#emit('sentence', this.#index);
  }

  async play(fromIndex = null) {
    if (fromIndex != null && fromIndex !== this.#index) {
      this.#index = fromIndex;
      this.#clearCache();
      this.#emit('sentence', this.#index);
    }
    if (!this.#sentences.length) return;
    this.#playing = true;
    this.#emit('state', 'playing');
    try {
      await this.#ready;
    } catch {
      this.pause(); // setVoice already reported why
      return;
    }
    if (!this.#playing) return; // paused while the voice was loading
    this.#fill();
    this.#playCurrent();
  }

  #playCurrent() {
    const unit = this.#unitOf[this.#index] ?? 0;
    const entry = this.#cache.get(unit);
    if (!entry) {
      this.#emit('status', { message: 'Đang tổng hợp giọng đọc…' });
      return;
    }

    // Already playing the right unit: just move the playhead.
    if (unit === this.#unit && this.#starts) {
      this.#seekWithin(unit);
      if (this.audio.paused) this.audio.play().catch(() => {});
      return;
    }

    this.#unit = unit;
    this.#starts = null;
    this.audio.onloadedmetadata = () => {
      this.#starts = sentenceStarts(this.#units[unit], entry.boundaries, this.audio.duration);
      if (this.lastStat) this.lastStat.seconds = this.audio.duration;
      this.#seekWithin(unit);
    };
    this.audio.src = entry.url;
    this.audio.playbackRate = this.rate;
    this.audio.play().catch((error) => this.#emit('failed', error.message));
    this.#emit('status', { message: '' });
  }

  /** Jumps to where the current sentence begins inside the loaded unit. */
  #seekWithin(unit) {
    if (!this.#starts) return;
    const offset = this.#units[unit].ranges.findIndex((r) => r.index === this.#index);
    if (offset > 0 && this.#starts[offset] != null) this.audio.currentTime = this.#starts[offset];
  }

  /** Keeps the highlighted sentence in step with a multi-sentence unit. */
  #followAudio() {
    if (!this.#playing || !this.#starts || this.#unit < 0) return;
    const unit = this.#units[this.#unit];
    if (unit.ranges.length < 2) return;
    const index = unit.ranges[activeSentence(this.#starts, this.audio.currentTime)].index;
    if (index !== this.#index) {
      this.#index = index;
      this.#emit('sentence', index);
    }
  }

  pause() {
    this.#playing = false;
    this.audio.pause();
    this.#emit('state', 'paused');
  }

  toggle() {
    return this.#playing ? this.pause() : this.play();
  }

  #advance() {
    if (!this.#playing) return;
    const unit = this.#unitOf[this.#index] ?? 0;
    const next = (this.#units[unit]?.last ?? this.#index) + 1;
    if (next >= this.#sentences.length) {
      this.#playing = false;
      this.#emit('state', 'paused');
      this.#emit('chapterend');
      return;
    }
    this.seek(next);
  }

  seek(index) {
    const clamped = Math.min(Math.max(index, 0), Math.max(this.#sentences.length - 1, 0));
    const unit = this.#unitOf[clamped] ?? 0;
    const jumped = Math.abs(unit - (this.#unitOf[this.#index] ?? 0)) > LOOKAHEAD + 1;
    this.#index = clamped;
    this.#emit('sentence', clamped);
    if (jumped) this.#clearCache();
    this.#trim();
    this.#fill();
    if (this.#playing) this.#playCurrent();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  destroy() {
    this.pause();
    this.#clearCache();
    this.#worker?.terminate();
    this.#worker = null;
    this.#edge = null;
  }
}

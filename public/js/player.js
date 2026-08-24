import { EdgeTts } from './edge-tts.js';

/**
 * Drives playback: keeps a small look-ahead of synthesised sentences so the
 * next one is usually ready before the current finishes, and feeds them to a
 * single <audio> element (which is what lets iOS keep playing with the screen
 * locked and show lock-screen controls).
 */

/** How many sentences to synthesise ahead of the one being played. */
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
  #abort = new AbortController();
  #pending = new Map(); // request id -> {resolve, reject}
  #nextId = 1;
  #ready = null;
  #cache = new Map(); // sentence index -> blob URL
  #inFlight = new Set();
  #failed = new Set();
  #generation = 0;
  #sentences = [];
  #index = 0;
  #playing = false;
  #unlocked = false;

  constructor(audio) {
    super();
    this.audio = audio;
    this.lengthScale = null;
    this.rate = 1;
    this.audio.addEventListener('ended', () => this.#advance());
    this.audio.addEventListener('error', () => {
      if (this.#playing) this.#advance();
    });
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

  /** Piper's synthesis-speed knob expressed the way Edge wants it. */
  #edgeRate() {
    if (!this.lengthScale) return '+0%';
    const percent = Math.round((1 / this.lengthScale - 1) * 100);
    return `${percent >= 0 ? '+' : ''}${percent}%`;
  }

  /** Produces one sentence of audio, whichever engine is selected. */
  #renderSentence(text) {
    if (this.#edge) {
      this.#edge.rate = this.#edgeRate();
      return this.#edge.synthesize(text, { signal: this.#abort.signal }).then((r) => r.blob);
    }
    if (!this.#worker) return Promise.reject(new Error('Chưa chọn giọng đọc.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ type: 'synth', id, text, lengthScale: this.lengthScale });
    }).then(({ pcm, sampleRate }) => encodeWav(pcm, sampleRate));
  }

  /* -------------------------------------------------------------- queue */

  #clearCache() {
    for (const url of this.#cache.values()) URL.revokeObjectURL(url);
    this.#cache.clear();
    this.#inFlight.clear();
    this.#failed.clear();
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
  }

  /** Synthesises `index` if it is not already cached or being worked on. */
  async #prepare(index) {
    if (index < 0 || index >= this.#sentences.length) return;
    if (this.#cache.has(index) || this.#inFlight.has(index)) return;
    if (this.#failed.has(index)) return; // a failure must not retry in a loop

    const generation = this.#generation;
    this.#inFlight.add(index);
    try {
      const blob = await this.#renderSentence(this.#sentences[index]);
      if (generation !== this.#generation) return; // seeked away while rendering
      this.#cache.set(index, URL.createObjectURL(blob));
      this.#emit('buffered', index);
      if (this.#playing && index === this.#index && this.audio.paused) this.#playCurrent();
    } catch (error) {
      if (generation === this.#generation) {
        this.#failed.add(index);
        this.#emit('failed', error.message);
      }
    } finally {
      this.#inFlight.delete(index);
      this.#trim();
      this.#fill();
    }
  }

  #fill() {
    if (!this.#ready) return; // no voice selected yet
    for (let i = this.#index; i <= this.#index + LOOKAHEAD; i++) this.#prepare(i);
  }

  /** Drops audio well behind or ahead of the cursor to bound memory use. */
  #trim() {
    for (const [index, url] of this.#cache) {
      if (index < this.#index - 1 || index > this.#index + LOOKAHEAD + 1) {
        URL.revokeObjectURL(url);
        this.#cache.delete(index);
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
    const url = this.#cache.get(this.#index);
    if (!url) {
      this.#emit('status', { message: 'Đang tổng hợp giọng đọc…' });
      return;
    }
    this.audio.src = url;
    this.audio.playbackRate = this.rate; // not all browsers keep it across src
    this.audio.play().catch((error) => this.#emit('failed', error.message));
    this.#emit('status', { message: '' });
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
    if (this.#index + 1 >= this.#sentences.length) {
      this.#playing = false;
      this.#emit('state', 'paused');
      this.#emit('chapterend');
      return;
    }
    this.seek(this.#index + 1);
  }

  seek(index) {
    const clamped = Math.min(Math.max(index, 0), Math.max(this.#sentences.length - 1, 0));
    const jumped = Math.abs(clamped - this.#index) > LOOKAHEAD + 1;
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
    this.#abort.abort();
    this.#worker?.terminate();
    this.#worker = null;
    this.#edge = null;
  }
}

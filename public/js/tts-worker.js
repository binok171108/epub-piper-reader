/* eslint-env worker */
/**
 * Piper (VITS) text-to-speech worker.
 *
 * Runs entirely on the device: eSpeak-NG (compiled to WebAssembly) turns text
 * into phoneme ids, then onnxruntime-web runs the voice model over them to
 * produce PCM audio. Kept off the main thread so a 2-3 second inference never
 * blocks scrolling or the audio element.
 *
 * This is a classic worker on purpose - both dependencies ship as UMD scripts.
 */
importScripts('../vendor/ort/ort.wasm.min.js', '../vendor/piper/piper_phonemize.js');

const MODEL_CACHE = 'piper-models-v1';
/** Piper degrades on very long inputs; keep each inference bounded. */
const MAX_CHARS = 320;

const vendorBase = new URL('../vendor/', self.location.href).href;

let phonemizer = null;
let phonemizerOutput = [];
let session = null;
let config = null;
let voiceId = null;

function post(message, transfer) {
  self.postMessage(message, transfer ?? []);
}

/* ------------------------------------------------------------ phonemizer */

async function getPhonemizer() {
  if (phonemizer) return phonemizer;
  phonemizer = await createPiperPhonemize({
    print: (line) => phonemizerOutput.push(line),
    printErr: (line) => console.warn('[piper]', line),
    locateFile: (file) => `${vendorBase}piper/${file.split('/').pop()}`,
  });
  return phonemizer;
}

/**
 * eSpeak-NG exposes a CLI-style entry point; callMain can be invoked
 * repeatedly on one module instance, so the 18 MB phoneme data set is only
 * parsed once per session.
 */
function phonemize(text, espeakVoice) {
  phonemizerOutput = [];
  phonemizer.callMain([
    '-l', espeakVoice,
    '--input', JSON.stringify([{ text }]),
    '--espeak_data', '/espeak-ng-data',
  ]);
  const line = phonemizerOutput.find((l) => l.includes('phoneme_ids'));
  if (!line) throw new Error('Không tạo được phoneme cho đoạn văn bản này.');
  return JSON.parse(line).phoneme_ids;
}

/* ------------------------------------------------------------- model I/O */

async function fetchCached(url, label) {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Tải model thất bại (${response.status}).`);

  const total = Number(response.headers.get('Content-Length') ?? 0);
  const reader = response.body?.getReader();
  const chunks = [];
  let loaded = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    post({ type: 'progress', label, loaded, total });
  }
  if (!chunks.length) chunks.push(new Uint8Array(await response.arrayBuffer()));

  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  await cache.put(
    url,
    new Response(bytes, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
      },
    }),
  );
  return bytes;
}

async function init({ voice, modelUrl, configUrl }) {
  if (voiceId === voice && session) {
    post({ type: 'ready', voice, sampleRate: config.audio.sample_rate });
    return;
  }

  ort.env.wasm.wasmPaths = `${vendorBase}ort/`;
  // SharedArrayBuffer needs cross-origin isolation, which GitHub Pages (and
  // most static hosts) cannot provide, so stay single-threaded.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';

  post({ type: 'status', message: 'Đang tải cấu hình giọng…' });
  const configBytes = await fetchCached(configUrl, 'config');
  config = JSON.parse(new TextDecoder().decode(configBytes));

  post({ type: 'status', message: 'Đang tải model giọng đọc…' });
  const modelBytes = await fetchCached(modelUrl, 'model');

  post({ type: 'status', message: 'Đang khởi tạo bộ tổng hợp…' });
  await getPhonemizer();

  session?.release?.();
  session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  voiceId = voice;

  post({ type: 'ready', voice, sampleRate: config.audio.sample_rate });
}

/* ------------------------------------------------------------- inference */

/** Splits over-long sentences on clause boundaries, then on whitespace. */
function chunk(text) {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CHARS) return trimmed ? [trimmed] : [];

  const parts = trimmed.match(/[^,;:—–]+[,;:—–]*\s*/g) ?? [trimmed];
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if (current && (current + part).length > MAX_CHARS) {
      chunks.push(current.trim());
      current = '';
    }
    if (part.length > MAX_CHARS) {
      let line = '';
      for (const word of part.split(/\s+/)) {
        if (line && `${line} ${word}`.length > MAX_CHARS) {
          chunks.push(line);
          line = word;
        } else {
          line = line ? `${line} ${word}` : word;
        }
      }
      current = line;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function synthesizeChunk(text, lengthScale) {
  const ids = phonemize(text, config.espeak.voice);
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([ids.length], BigInt)),
    scales: new ort.Tensor(
      'float32',
      Float32Array.from([
        config.inference.noise_scale,
        lengthScale ?? config.inference.length_scale,
        config.inference.noise_w,
      ]),
    ),
  };
  if (Object.keys(config.speaker_id_map ?? {}).length) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]));
  }
  const results = await session.run(feeds);
  return results[session.outputNames[0]].data;
}

async function synthesize({ id, text, lengthScale }) {
  if (!session) throw new Error('Bộ tổng hợp chưa sẵn sàng.');
  const pieces = [];
  for (const part of chunk(text)) pieces.push(await synthesizeChunk(part, lengthScale));

  const total = pieces.reduce((n, p) => n + p.length, 0);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const piece of pieces) {
    pcm.set(piece, offset);
    offset += piece.length;
  }
  post({ type: 'audio', id, pcm, sampleRate: config.audio.sample_rate }, [pcm.buffer]);
}

self.onmessage = async (event) => {
  const { type, ...payload } = event.data;
  try {
    if (type === 'init') await init(payload);
    else if (type === 'synth') await synthesize(payload);
  } catch (error) {
    post({ type: 'error', id: payload.id, message: error?.message ?? String(error) });
  }
};

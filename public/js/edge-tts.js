/**
 * Microsoft Edge "read aloud" text-to-speech, spoken over the same WebSocket
 * protocol the edge-tts tooling uses.
 *
 * Unlike the Piper engine this one needs the network: audio is synthesised by
 * Microsoft's servers, so the text of whatever is being read leaves the device.
 * In exchange the voices are much better than what fits in a 60 MB local model
 * and nothing has to be downloaded first.
 *
 * One caveat that cannot be worked around from a web page: browsers set the
 * `Origin` header themselves, and it is not known whether Microsoft's endpoint
 * accepts arbitrary web origins. If it refuses the handshake, point
 * `?edge_endpoint=` at a relay you control.
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const DEFAULT_ENDPOINT =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
/** Sent as Sec-MS-GEC-Version; drifts with Edge releases. */
const DEFAULT_GEC_VERSION = '1-130.0.2849.68';
const DEFAULT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/**
 * A request's budget has to scale with how much text it carries: a paragraph
 * is fifteen times the work of a sentence, and a fixed timeout sized for one
 * sentence will cut off every batched request.
 */
const TIMEOUT_BASE_MS = 15000;
const TIMEOUT_PER_CHAR_MS = 40;
const TIMEOUT_MAX_MS = 180000;

/** Audio container per output format, used only when the bytes say nothing. */
const FORMAT_MIME = {
  'audio-16khz-32kbitrate-mono-mp3': 'audio/mpeg',
  'audio-24khz-48kbitrate-mono-mp3': 'audio/mpeg',
  'audio-24khz-96kbitrate-mono-mp3': 'audio/mpeg',
  'audio-48khz-96kbitrate-mono-mp3': 'audio/mpeg',
  'riff-24khz-16bit-mono-pcm': 'audio/wav',
};

/** Assumed when a headerless PCM stream does not state its rate. */
const DEFAULT_PCM_RATE = 24000;

/** Difference between the Windows file time epoch and the Unix epoch. */
const WINDOWS_EPOCH_OFFSET_SECONDS = 11644473600n;
/** 100-nanosecond ticks per second. */
const TICKS_PER_SECOND = 10000000n;
/** The token is only regenerated every five minutes. */
const TOKEN_WINDOW_SECONDS = 300n;

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Rounds the current time down to a five-minute Windows file time and hashes it
 * with the trusted client token - the anti-abuse value the endpoint expects.
 */
export async function secMsGec(now = Date.now()) {
  let ticks = BigInt(Math.floor(now / 1000)) + WINDOWS_EPOCH_OFFSET_SECONDS;
  ticks -= ticks % TOKEN_WINDOW_SECONDS;
  ticks *= TICKS_PER_SECOND;
  const bytes = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  return hex(await crypto.subtle.digest('SHA-256', bytes)).toUpperCase();
}

/** The exact date shape the protocol's X-Timestamp header uses. */
function timestamp(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

/**
 * 32 hex characters, the shape the protocol wants for request and connection
 * ids. crypto.randomUUID needs a secure context, which a file:// page does not
 * reliably get, so this degrades instead of throwing.
 */
function randomId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function startsWith(bytes, text, offset = 0) {
  if (bytes.length < offset + text.length) return false;
  return [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
}

/**
 * Works out the container from the bytes themselves. A relay may label its
 * output however it likes, and an <audio> element with the wrong MIME type
 * simply refuses to play, so the stream is trusted over the label.
 */
function sniffAudio(bytes) {
  if (startsWith(bytes, 'RIFF') && startsWith(bytes, 'WAVE', 8)) return 'audio/wav';
  if (startsWith(bytes, 'OggS')) return 'audio/ogg';
  if (startsWith(bytes, 'fLaC')) return 'audio/flac';
  if (startsWith(bytes, 'ID3')) return 'audio/mpeg';
  // MPEG frame sync: eleven set bits.
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/** Sample rate named by a format string such as "riff-24khz-16bit-mono-pcm". */
function rateFromFormat(format, fallback) {
  const match = /(\d+)\s*khz/i.exec(format);
  return match ? Number(match[1]) * 1000 : fallback;
}

/** Wraps signed 16-bit mono samples in a WAV header so <audio> can play them. */
function wavFromPcm(bytes, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  header.setUint32(4, 36 + bytes.length, true);
  ascii(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, 'data');
  header.setUint32(40, bytes.length, true);
  return new Uint8Array([...new Uint8Array(header.buffer), ...bytes]);
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char];
  });
}

/** Locale prefix of a voice name, e.g. "vi-VN-HoaiMyNeural" -> "vi-VN". */
export function localeOf(voiceName) {
  const parts = voiceName.split('-');
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
}

function buildSsml({ voice, text, rate, pitch, volume }) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${localeOf(voice)}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

/** Binary frames are a 2-byte big-endian header length, the header, then audio. */
/**
 * Pulls WordBoundary events out of an audio.metadata frame. Offsets arrive in
 * 100-nanosecond ticks; the word text is what lets them be lined up against
 * the text that was sent.
 */
function collectBoundaries(frame, out) {
  const split = frame.indexOf('\r\n\r\n');
  if (split < 0) return;
  let payload;
  try {
    payload = JSON.parse(frame.slice(split + 4));
  } catch {
    return;
  }
  for (const item of payload.Metadata ?? []) {
    if (item.Type !== 'WordBoundary') continue;
    const text = item.Data?.text?.Text;
    if (typeof text !== 'string') continue;
    out.push({ timeMs: (item.Data.Offset ?? 0) / 10000, text });
  }
}

function readBinaryFrame(buffer) {
  const view = new DataView(buffer);
  const headerLength = view.getUint16(0);
  const header = new TextDecoder().decode(new Uint8Array(buffer, 2, headerLength));
  return { header, audio: new Uint8Array(buffer, 2 + headerLength) };
}

export class EdgeTts {
  constructor({
    voice,
    endpoint = DEFAULT_ENDPOINT,
    gecVersion = DEFAULT_GEC_VERSION,
    format = DEFAULT_FORMAT,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
    pcmRate = DEFAULT_PCM_RATE,
    bareWs = false,
    wordBoundary = true,
    timeoutBaseMs = TIMEOUT_BASE_MS,
    timeoutPerCharMs = TIMEOUT_PER_CHAR_MS,
  }) {
    this.voice = voice;
    this.endpoint = endpoint;
    this.gecVersion = gecVersion;
    this.format = format;
    this.rate = rate;
    this.pitch = pitch;
    this.volume = volume;
    this.pcmRate = Number(pcmRate) || DEFAULT_PCM_RATE;
    this.bareWs = Boolean(bareWs);
    this.wordBoundary = Boolean(wordBoundary);
    this.timeoutBaseMs = Number(timeoutBaseMs) || TIMEOUT_BASE_MS;
    this.timeoutPerCharMs = Number(timeoutPerCharMs) || TIMEOUT_PER_CHAR_MS;
  }

  timeoutFor(text) {
    return Math.min(TIMEOUT_MAX_MS, this.timeoutBaseMs + text.length * this.timeoutPerCharMs);
  }

  /** Turns the collected frames into something the player can actually play. */
  #toBlob(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const sniffed = sniffAudio(bytes);
    if (sniffed) return new Blob([bytes], { type: sniffed });

    // Nothing recognisable at the front: headerless PCM is the one case worth
    // rescuing, since a relay can legitimately stream raw samples.
    if (/pcm|raw/i.test(this.format)) {
      const rate = rateFromFormat(this.format, this.pcmRate);
      return new Blob([wavFromPcm(bytes, rate)], { type: 'audio/wav' });
    }
    return new Blob([bytes], { type: FORMAT_MIME[this.format] ?? 'audio/mpeg' });
  }

  async #url() {
    const url = new URL(this.endpoint);
    // Microsoft's own endpoint authenticates from the query string. A relay
    // that mints its own credentials has no use for these and may reject
    // unknown parameters outright, so bareWs leaves the URL untouched.
    if (!this.bareWs) {
      url.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN);
      url.searchParams.set('Sec-MS-GEC', await secMsGec());
      url.searchParams.set('Sec-MS-GEC-Version', this.gecVersion);
      url.searchParams.set('ConnectionId', randomId());
    }
    return url.href;
  }

  /**
   * Synthesises one piece of text. A fresh socket per request keeps this free
   * of the reconnect and idle-timeout handling a pooled socket would need;
   * the reader's look-ahead hides the extra round trip.
   */
  async synthesize(text, { signal } = {}) {
    const socket = new WebSocket(await this.#url());
    socket.binaryType = 'arraybuffer';
    const requestId = randomId();
    const chunks = [];
    const boundaries = [];
    /** What actually arrived, so a timeout can say where things stopped. */
    const seen = { turnStart: false, audioBytes: 0 };
    const budget = this.timeoutFor(text);

    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        error ? reject(error) : resolve(result);
      };
      const done = () => finish(null, { blob: this.#toBlob(chunks), boundaries });
      const onAbort = () => finish(new Error('Đã huỷ yêu cầu.'));
      const timer = setTimeout(() => {
        const got = [
          seen.turnStart ? 'đã bắt đầu phiên' : 'chưa có turn.start',
          `${seen.audioBytes} byte audio`,
          `${boundaries.length} mốc từ`,
        ].join(', ');
        const error = new Error(
          `Edge TTS không phản hồi sau ${Math.round(budget / 1000)} giây ` +
            `cho ${text.length} ký tự (${got}).`,
        );
        error.timedOut = true;
        finish(error);
      }, budget);
      signal?.addEventListener('abort', onAbort, { once: true });

      socket.onopen = () => {
        socket.send(
          `X-Timestamp:${timestamp()}\r\n` +
            'Content-Type:application/json; charset=utf-8\r\n' +
            'Path:speech.config\r\n\r\n' +
            JSON.stringify({
              context: {
                synthesis: {
                  audio: {
                    metadataoptions: {
                      sentenceBoundaryEnabled: 'false',
                      // Word boundaries let a long request still be highlighted
                      // word by word instead of all at once.
                      wordBoundaryEnabled: this.wordBoundary ? 'true' : 'false',
                    },
                    outputFormat: this.format,
                  },
                },
              },
            }),
        );
        socket.send(
          `X-RequestId:${requestId}\r\n` +
            'Content-Type:application/ssml+xml\r\n' +
            `X-Timestamp:${timestamp()}Z\r\n` +
            'Path:ssml\r\n\r\n' +
            buildSsml({
              voice: this.voice,
              text,
              rate: this.rate,
              pitch: this.pitch,
              volume: this.volume,
            }),
        );
      };

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.start')) {
            seen.turnStart = true;
            return;
          }
          if (event.data.includes('Path:audio.metadata')) {
            collectBoundaries(event.data, boundaries);
            return;
          }
          if (event.data.includes('Path:turn.end')) {
            if (!chunks.length) {
              finish(new Error('Edge TTS trả về phiên không có audio.'));
              return;
            }
            done();
          }
          return;
        }
        const { header, audio } = readBinaryFrame(event.data);
        if (header.includes('Path:audio') && audio.length) {
          chunks.push(audio);
          seen.audioBytes += audio.length;
        }
      };

      socket.onerror = () =>
        finish(
          new Error(
            'Không kết nối được Edge TTS. Có thể do mất mạng hoặc máy chủ từ chối origin của trang web.',
          ),
        );

      socket.onclose = (event) => {
        if (chunks.length) done();
        else finish(new Error(`Edge TTS đóng kết nối (mã ${event.code}).`));
      };
    });
  }
}

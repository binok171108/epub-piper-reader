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
const REQUEST_TIMEOUT_MS = 20000;

/** Audio container per output format, so the Blob gets a type the player can use. */
const FORMAT_MIME = {
  'audio-16khz-32kbitrate-mono-mp3': 'audio/mpeg',
  'audio-24khz-48kbitrate-mono-mp3': 'audio/mpeg',
  'audio-24khz-96kbitrate-mono-mp3': 'audio/mpeg',
  'audio-48khz-96kbitrate-mono-mp3': 'audio/mpeg',
  'riff-24khz-16bit-mono-pcm': 'audio/wav',
};

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
  }) {
    this.voice = voice;
    this.endpoint = endpoint;
    this.gecVersion = gecVersion;
    this.format = format;
    this.rate = rate;
    this.pitch = pitch;
    this.volume = volume;
    this.mime = FORMAT_MIME[format] ?? 'audio/mpeg';
  }

  async #url() {
    const url = new URL(this.endpoint);
    url.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN);
    url.searchParams.set('Sec-MS-GEC', await secMsGec());
    url.searchParams.set('Sec-MS-GEC-Version', this.gecVersion);
    url.searchParams.set('ConnectionId', crypto.randomUUID().replaceAll('-', ''));
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
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const chunks = [];

    return new Promise((resolve, reject) => {
      const finish = (error, blob) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (socket.readyState === WebSocket.OPEN) socket.close();
        error ? reject(error) : resolve(blob);
      };
      const onAbort = () => finish(new Error('Đã huỷ yêu cầu.'));
      const timer = setTimeout(
        () => finish(new Error('Edge TTS không phản hồi (quá 20 giây).')),
        REQUEST_TIMEOUT_MS,
      );
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
                      wordBoundaryEnabled: 'false',
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
          if (event.data.includes('Path:turn.end')) {
            if (!chunks.length) {
              finish(new Error('Edge TTS trả về phiên không có audio.'));
              return;
            }
            finish(null, new Blob(chunks, { type: this.mime }));
          }
          return;
        }
        const { header, audio } = readBinaryFrame(event.data);
        if (header.includes('Path:audio') && audio.length) chunks.push(audio);
      };

      socket.onerror = () =>
        finish(
          new Error(
            'Không kết nối được Edge TTS. Có thể do mất mạng hoặc máy chủ từ chối origin của trang web.',
          ),
        );

      socket.onclose = (event) => {
        if (chunks.length) finish(null, new Blob(chunks, { type: this.mime }));
        else finish(new Error(`Edge TTS đóng kết nối (mã ${event.code}).`));
      };
    });
  }
}

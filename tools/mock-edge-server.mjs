/**
 * Stand-in for Microsoft's read-aloud endpoint, speaking the same WebSocket
 * protocol, so the Edge TTS client can be tested without the real service.
 *
 * It is strict on purpose: every framing or parameter mistake is recorded and
 * served from GET /__report, which the smoke test asserts on. The Sec-MS-GEC
 * token is recomputed here independently and compared with what the client
 * sent.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SAMPLE_RATE = 24000;

const report = { requests: [], problems: [] };

function expectedGec(now = Date.now()) {
  let ticks = BigInt(Math.floor(now / 1000)) + 11644473600n;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  return createHash('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

/** Splits a protocol frame into its headers and body. */
function parseMessage(text) {
  const split = text.indexOf('\r\n\r\n');
  const headers = Object.fromEntries(
    text
      .slice(0, split)
      .split('\r\n')
      .map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  return { headers, body: text.slice(split + 4) };
}

function wav(seconds) {
  const samples = Math.max(1, Math.round(SAMPLE_RATE * seconds));
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220) * 6000), 44 + i * 2);
  }
  return buffer;
}

/** Wraps a payload the way the service frames binary audio messages. */
function audioFrame(requestId, payload) {
  const header = Buffer.from(
    `X-RequestId:${requestId}\r\nContent-Type:audio/x-wav\r\nPath:audio\r\n\r\n`,
    'utf8',
  );
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length);
  return Buffer.concat([length, header, payload]);
}

export function startMockEdgeServer(port, { delayMs = 0 } = {}) {
  const http = createServer((req, res) => {
    if (req.url.startsWith('/__report')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const params = url.searchParams;
    const problems = [];

    // A relay that mints its own credentials gets a bare URL (edge_bare_ws),
    // so the query-string checks only apply when the client was asked to
    // authenticate the way Microsoft's endpoint expects.
    const bare = !params.has('TrustedClientToken') && !params.has('Sec-MS-GEC');
    if (!bare) {
      if (params.get('TrustedClientToken') !== TRUSTED_CLIENT_TOKEN) {
        problems.push('TrustedClientToken sai hoặc thiếu');
      }
      // Accept the neighbouring five-minute window too, so a tick over the
      // boundary mid-test is not reported as a client bug.
      const sent = params.get('Sec-MS-GEC');
      if (sent !== expectedGec() && sent !== expectedGec(Date.now() - 300000)) {
        problems.push(`Sec-MS-GEC không khớp (nhận ${sent})`);
      }
      if (!/^1-\d+\.\d+\.\d+\.\d+$/.test(params.get('Sec-MS-GEC-Version') ?? '')) {
        problems.push(`Sec-MS-GEC-Version sai dạng (${params.get('Sec-MS-GEC-Version')})`);
      }
      if (!/^[0-9a-f]{32}$/.test(params.get('ConnectionId') ?? '')) {
        problems.push('ConnectionId phải là uuid không dấu gạch');
      }
    }

    const entry = {
      origin: request.headers.origin ?? null,
      rawUrl: request.url,
      bare,
      frames: [],
      problems,
    };
    report.requests.push(entry);

    let format = null;
    socket.on('message', (data) => {
      const frame = data.toString('utf8');
      entry.frames.push(frame);
      const { headers, body } = parseMessage(frame);

      if (headers.Path === 'speech.config') {
        format = JSON.parse(body).context?.synthesis?.audio?.outputFormat ?? null;
        entry.format = format;
        if (!headers['X-Timestamp']) problems.push('speech.config thiếu X-Timestamp');
        return;
      }

      if (headers.Path !== 'ssml') {
        problems.push(`Path lạ: ${headers.Path}`);
        return;
      }
      if (!format) problems.push('gửi ssml trước speech.config');
      if (headers['Content-Type']?.trim() !== 'application/ssml+xml') {
        problems.push(`Content-Type của ssml sai: ${headers['Content-Type']}`);
      }
      const requestId = headers['X-RequestId']?.trim();
      if (!/^[0-9a-f]{32}$/.test(requestId ?? '')) problems.push('X-RequestId sai dạng');

      entry.ssml = body;
      entry.voice = body.match(/<voice name='([^']+)'/)?.[1] ?? null;
      entry.rate = body.match(/rate='([^']+)'/)?.[1] ?? null;
      const text = body.match(/<prosody[^>]*>([\s\S]*)<\/prosody>/)?.[1] ?? '';
      entry.text = text;
      entry.decoded = text.replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name],
      );
      if (/[<>&](?!(amp|lt|gt|quot|apos);)/.test(text)) problems.push('văn bản chưa escape XML');

      report.problems.push(...problems.map((p) => `${entry.voice ?? '?'}: ${p}`));

      // One second of audio per 15 characters, delivered in two chunks so the
      // client's concatenation is exercised. A format naming pcm without riff
      // gets raw samples, the way a relay streaming PCM would send them.
      const full = wav(Math.max(0.4, text.length / 15));
      const audio = /pcm/i.test(format ?? '') && !/riff/i.test(format ?? '')
        ? full.subarray(44)
        : full;
      socket.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.start\r\n\r\n{}`,
      );
      const split = Math.min(2044, audio.length);
      // delayMs stands in for a slow relay, which is what makes buffering
      // behaviour observable in a test.
      setTimeout(() => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(audioFrame(requestId, audio.subarray(0, split)));
        socket.send(audioFrame(requestId, audio.subarray(split)));
        socket.send(
          `X-RequestId:${requestId}\r\nContent-Type:application/json; charset=utf-8\r\nPath:turn.end\r\n\r\n{}`,
        );
      }, delayMs);
    });
  });

  return new Promise((resolve) => {
    http.listen(port, () => resolve({ report, close: () => new Promise((r) => http.close(r)) }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8130);
  await startMockEdgeServer(port);
  console.log(`Mock Edge TTS on ws://localhost:${port}/`);
}

/**
 * Builds epub-reader-standalone.html: the whole reader as one file, with no
 * network dependencies of its own.
 *
 * The EPUB parser, the sentence segmenter and the Edge TTS client are the same
 * sources the PWA uses - they are inlined here rather than reimplemented, so
 * the two builds cannot drift apart.
 *
 *   npm run standalone
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'epub-reader-standalone.html');

/** Turns an ES module into something that can be concatenated into one script. */
function flatten(source, label) {
  const lines = source.split('\n');
  const kept = [];
  for (const line of lines) {
    if (/^import\s.*;\s*$/.test(line)) continue; // dependencies are inlined instead
    if (/^export\s*\{[^}]*\}\s*;?\s*$/.test(line)) continue; // re-export of a local name
    kept.push(line.replace(/^export\s+/, ''));
  }
  return `\n/* ===== ${label} ===== */\n${kept.join('\n')}`;
}

async function read(...parts) {
  return readFile(join(root, ...parts), 'utf8');
}

/** Names a relay by what distinguishes it: "vieneu (8686)". */
function labelFor(url) {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split('/').filter(Boolean)[0] ?? 'relay';
    return parsed.port ? `${name} (${parsed.port})` : name;
  } catch {
    return url;
  }
}

/**
 * `--endpoint=wss://... --voice=vi-VN-HoaiMyNeural --engine=edge`
 * `--endpoint` may be repeated; the first becomes the default and all of them
 * appear as presets in the settings panel.
 */
function buildDefaults() {
  const defaults = {};
  const endpoints = [];
  for (const arg of process.argv.slice(2)) {
    const match = /^--(endpoint|voice|engine)=(.*)$/.exec(arg);
    if (!match) throw new Error(`Tham số không hiểu: ${arg}`);
    if (match[1] === 'endpoint') endpoints.push(match[2]);
    else defaults[match[1]] = match[2];
  }
  if (endpoints.length) {
    defaults.endpoint = endpoints[0];
    defaults.endpoints = endpoints.map((url) => ({ url, label: labelFor(url) }));
    // Baking in a relay address only makes sense if that engine is selected.
    if (!defaults.engine) defaults.engine = 'edge';
  }
  return defaults;
}

async function main() {
  const shell = await read('standalone', 'shell.html');
  const css = await read('public', 'app.css');

  const modules = [
    ['fflate', await read('public', 'vendor', 'fflate.mjs')],
    ['epub.js', await read('public', 'js', 'epub.js')],
    ['segment.js', await read('public', 'js', 'segment.js')],
    ['chunking.js', await read('public', 'js', 'chunking.js')],
    ['edge-tts.js', await read('public', 'js', 'edge-tts.js')],
    ['standalone app', await read('standalone', 'app.js')],
  ];

  const defaults = buildDefaults();
  let script = modules.map(([label, source]) => flatten(source, label)).join('\n');

  const placeholder = 'const BUILD_DEFAULTS = {};';
  if (!script.includes(placeholder)) throw new Error('Không tìm thấy BUILD_DEFAULTS.');
  script = script.replace(placeholder, `const BUILD_DEFAULTS = ${JSON.stringify(defaults)};`);

  const html = shell
    .replace('/*STYLE*/', () => css)
    .replace('/*SCRIPT*/', () => script);

  if (html.includes('/*STYLE*/') || html.includes('/*SCRIPT*/')) {
    throw new Error('Không thay được placeholder trong shell.html.');
  }

  await writeFile(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`public/epub-reader-standalone.html  ${kb} KB`);
  if (Object.keys(defaults).length) {
    console.log(`Mặc định nhúng sẵn: ${JSON.stringify(defaults)}`);
  }
  console.log('Mở trực tiếp bằng trình duyệt, hoặc đặt lên bất kỳ host tĩnh nào.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

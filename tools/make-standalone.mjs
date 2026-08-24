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

async function main() {
  const shell = await read('standalone', 'shell.html');
  const css = await read('public', 'app.css');

  const modules = [
    ['fflate', await read('public', 'vendor', 'fflate.mjs')],
    ['epub.js', await read('public', 'js', 'epub.js')],
    ['segment.js', await read('public', 'js', 'segment.js')],
    ['edge-tts.js', await read('public', 'js', 'edge-tts.js')],
    ['standalone app', await read('standalone', 'app.js')],
  ];

  const script = modules.map(([label, source]) => flatten(source, label)).join('\n');

  const html = shell
    .replace('/*STYLE*/', () => css)
    .replace('/*SCRIPT*/', () => script);

  if (html.includes('/*STYLE*/') || html.includes('/*SCRIPT*/')) {
    throw new Error('Không thay được placeholder trong shell.html.');
  }

  await writeFile(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`public/epub-reader-standalone.html  ${kb} KB`);
  console.log('Mở trực tiếp bằng trình duyệt, hoặc đặt lên bất kỳ host tĩnh nào.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

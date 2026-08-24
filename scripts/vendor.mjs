/**
 * Copies the WebAssembly runtime files out of node_modules into public/vendor/
 * so the PWA can serve every dependency same-origin (needed for the service
 * worker to cache them for offline use).
 *
 * Run with: npm run vendor   (also runs automatically after npm install)
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');

/** [source module path, destination path relative to public/vendor] */
const FILES = [
  ['fflate/esm/browser.js', 'fflate.mjs'],
  ['onnxruntime-web/dist/ort.wasm.min.js', 'ort/ort.wasm.min.js'],
  ['onnxruntime-web/dist/ort-wasm-simd.wasm', 'ort/ort-wasm-simd.wasm'],
  ['onnxruntime-web/dist/ort-wasm.wasm', 'ort/ort-wasm.wasm'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.js', 'piper/piper_phonemize.js'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.wasm', 'piper/piper_phonemize.wasm'],
  ['@diffusionstudio/piper-wasm/build/piper_phonemize.data', 'piper/piper_phonemize.data'],
];

async function main() {
  await mkdir(vendor, { recursive: true });
  const manifest = [];

  for (const [from, to] of FILES) {
    // Read straight out of node_modules: several packages restrict deep
    // imports through their "exports" map, which would break require.resolve.
    let src = join(root, 'node_modules', from);
    try {
      await stat(src);
    } catch {
      try {
        src = require.resolve(from);
      } catch {
        throw new Error(`Missing dependency file "${from}". Run \`npm install\` first.`);
      }
    }
    const dest = join(vendor, to);
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
    const { size } = await stat(dest);
    manifest.push({ path: `vendor/${to}`, bytes: size });
    console.log(`  ${to.padEnd(34)} ${(size / 1e6).toFixed(2)} MB`);
  }

  // The service worker reads this to know what to pre-cache for offline use.
  await writeFile(
    join(vendor, 'manifest.json'),
    JSON.stringify({ generated: new Date().toISOString(), files: manifest }, null, 2),
  );

  const total = manifest.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`\nVendored ${manifest.length} files into public/vendor (${(total / 1e6).toFixed(1)} MB total).`);
  await readdir(vendor); // sanity check that the directory is readable
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

/**
 * Packs public/ into dist/ plus a single zip, for hosts that take a folder or
 * an upload instead of a git repository (Cloudflare Pages direct upload,
 * Netlify Drop, any static web server).
 *
 * Run: npm run dist
 */
import { zipSync } from 'fflate';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const distDir = join(root, 'dist');
const zipPath = join(root, 'epub-reader-site.zip');

/** Test fixtures must not ship in a deployable bundle. */
const EXCLUDE = new Set(['test-assets']);

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else files.push(full);
  }
  return files;
}

async function main() {
  try {
    await stat(join(publicDir, 'vendor', 'ort'));
  } catch {
    throw new Error('public/vendor chưa có. Chạy `npm install` (hoặc `npm run vendor`) trước.');
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(publicDir, distDir, {
    recursive: true,
    filter: (src) => !EXCLUDE.has(relative(publicDir, src)),
  });

  const entries = {};
  let total = 0;
  for (const file of await walk(distDir)) {
    const bytes = await readFile(file);
    entries[relative(distDir, file).split('\\').join('/')] = new Uint8Array(bytes);
    total += bytes.length;
  }

  const zipped = zipSync(entries, { level: 9 });
  await writeFile(zipPath, zipped);

  console.log(`dist/                  ${Object.keys(entries).length} tệp, ${(total / 1e6).toFixed(1)} MB`);
  console.log(`epub-reader-site.zip   ${(zipped.length / 1e6).toFixed(1)} MB`);
  console.log('\nKéo thả zip (hoặc thư mục dist/) vào Cloudflare Pages / Netlify Drop là chạy.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

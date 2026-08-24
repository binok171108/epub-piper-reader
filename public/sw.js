/* eslint-env serviceworker */
/**
 * Offline shell for the reader.
 *
 * The app files are pre-cached on install; the WebAssembly runtime under
 * /vendor/ (about 30 MB) is cached the first time it is actually used, so the
 * install stays fast. Voice models are cached separately by the page itself,
 * in "piper-models-v1", which this worker never touches.
 */
const VERSION = 'v1';
const SHELL = `epub-reader-shell-${VERSION}`;
const RUNTIME = `epub-reader-runtime-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './js/app.js',
  './js/chunking.js',
  './js/edge-tts.js',
  './js/epub.js',
  './js/player.js',
  './js/segment.js',
  './js/store.js',
  './js/tts-worker.js',
  './js/voices.js',
  './vendor/fflate.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('epub-reader-') && key !== SHELL && key !== RUNTIME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Cache-first, used for the immutable WebAssembly payloads. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/** Fresh when online, cached when not - used for the app shell. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request) ?? await cache.match('./index.html');
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // voice models handle their own cache

  if (url.pathname.includes('/vendor/')) {
    event.respondWith(cacheFirst(request, RUNTIME));
  } else {
    event.respondWith(networkFirst(request));
  }
});

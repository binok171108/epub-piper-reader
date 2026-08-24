/**
 * Persistence layer.
 *
 *   - Voice models live in the Cache API, keyed by their download URL, so the
 *     service worker and the page share one copy.
 *   - Opened books and reading positions live in IndexedDB.
 */
const MODEL_CACHE = 'piper-models-v1';
const DB_NAME = 'epub-piper-reader';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/* ------------------------------------------------------------------ books */

export function saveBook(book) {
  return tx('books', 'readwrite', (store) => store.put(book));
}

export function listBooks() {
  return tx('books', 'readonly', (store) => store.getAll());
}

export function getBook(id) {
  return tx('books', 'readonly', (store) => store.get(id));
}

export function deleteBook(id) {
  return tx('books', 'readwrite', (store) => store.delete(id));
}

/* -------------------------------------------------------------- positions */

export function savePosition(bookId, position) {
  return tx('positions', 'readwrite', (store) => store.put(position, bookId));
}

export function getPosition(bookId) {
  return tx('positions', 'readonly', (store) => store.get(bookId));
}

/* ----------------------------------------------------------- voice models */

export async function isModelCached(url) {
  const cache = await caches.open(MODEL_CACHE);
  return Boolean(await cache.match(url));
}

export async function deleteModel(...urls) {
  const cache = await caches.open(MODEL_CACHE);
  await Promise.all(urls.map((url) => cache.delete(url)));
}

/** Total bytes currently held in the model cache. */
export async function cachedModelBytes() {
  const cache = await caches.open(MODEL_CACHE);
  let total = 0;
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    total += Number(response?.headers.get('Content-Length') ?? 0);
  }
  return total;
}

/** Asks the browser not to evict our storage (iOS clears it otherwise). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate() {
  try {
    return (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    return null;
  }
}

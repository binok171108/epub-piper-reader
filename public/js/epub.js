/**
 * Minimal EPUB 2/3 reader: unzips the container, walks the OPF package
 * document and hands back chapters as sanitised HTML plus a table of contents.
 *
 * Everything here runs against the raw zip entries held in memory, so no
 * network access and no server component is involved.
 */
import { unzip, unzipSync } from '../vendor/fflate.mjs';

const XML = 'application/xml';

/** A blob URL only renders in <img> if the blob carries a usable MIME type. */
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function guessMime(path) {
  return MIME_BY_EXTENSION[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
}

/** Resolves `rel` against the directory of `base`, EPUB paths being zip paths. */
function resolvePath(base, rel) {
  const stack = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(rel).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function parseXml(text, type = XML) {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.querySelector('parsererror')) throw new Error('Tệp EPUB có XML không hợp lệ.');
  return doc;
}

async function unzipFile(buffer) {
  const bytes = new Uint8Array(buffer);
  try {
    return await new Promise((ok, fail) => {
      unzip(bytes, (err, files) => (err ? fail(err) : ok(files)));
    });
  } catch {
    // fflate's async path needs Workers; fall back to the synchronous inflate.
    return unzipSync(bytes);
  }
}

/** Wraps zip entries with lazy text decoding and lazy blob-URL creation. */
class Resources {
  constructor(files) {
    this.files = files;
    this.urls = new Map();
    this.decoder = new TextDecoder('utf-8');
  }

  has(path) {
    return Object.prototype.hasOwnProperty.call(this.files, path);
  }

  bytes(path) {
    const data = this.files[path];
    if (!data) throw new Error(`Không tìm thấy "${path}" trong EPUB.`);
    return data;
  }

  text(path) {
    return this.decoder.decode(this.bytes(path));
  }

  /** Blob URL for an internal resource, created once and reused. */
  url(path, mime) {
    if (!this.urls.has(path)) {
      if (!this.has(path)) return null;
      const blob = new Blob([this.bytes(path)], { type: mime || guessMime(path) });
      this.urls.set(path, URL.createObjectURL(blob));
    }
    return this.urls.get(path);
  }

  revoke() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

function readMetadata(pkg) {
  const get = (tag) => pkg.getElementsByTagNameNS('*', tag)[0]?.textContent?.trim() ?? '';
  return {
    title: get('title') || 'Sách không tên',
    author: get('creator'),
    language: (get('language') || '').toLowerCase(),
    identifier: get('identifier'),
  };
}

function readManifest(pkg, opfPath) {
  const items = new Map();
  for (const el of pkg.getElementsByTagNameNS('*', 'item')) {
    const id = el.getAttribute('id');
    const href = el.getAttribute('href');
    if (!id || !href) continue;
    items.set(id, {
      id,
      path: resolvePath(opfPath, href),
      mime: el.getAttribute('media-type') || '',
      properties: (el.getAttribute('properties') || '').split(/\s+/).filter(Boolean),
    });
  }
  return items;
}

function readSpine(pkg, manifest) {
  const spineEl = pkg.getElementsByTagNameNS('*', 'spine')[0];
  const spine = [];
  if (!spineEl) return { spine, tocId: null };
  for (const ref of spineEl.getElementsByTagNameNS('*', 'itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (item) spine.push(item);
  }
  return { spine, tocId: spineEl.getAttribute('toc') };
}

/** EPUB 3 navigation document: <nav epub:type="toc"><ol><li><a href>. */
function readNavToc(res, navItem) {
  const doc = parseXml(res.text(navItem.path), 'text/html');
  const nav =
    [...doc.querySelectorAll('nav')].find(
      (n) => (n.getAttribute('epub:type') || n.getAttribute('type') || '').includes('toc'),
    ) ?? doc.querySelector('nav');
  if (!nav) return [];

  const walk = (list, depth) => {
    const out = [];
    for (const li of list.children) {
      const a = li.querySelector(':scope > a, :scope > span');
      const href = a?.getAttribute?.('href');
      if (a) {
        out.push({
          label: a.textContent.trim(),
          path: href ? resolvePath(navItem.path, href.split('#')[0]) : null,
          hash: href?.includes('#') ? href.split('#')[1] : null,
          depth,
        });
      }
      const child = li.querySelector(':scope > ol, :scope > ul');
      if (child) out.push(...walk(child, depth + 1));
    }
    return out;
  };
  const list = nav.querySelector('ol, ul');
  return list ? walk(list, 0) : [];
}

/** EPUB 2 fallback: the NCX document referenced by spine@toc. */
function readNcxToc(res, ncxItem) {
  const doc = parseXml(res.text(ncxItem.path));
  const walk = (parent, depth) => {
    const out = [];
    for (const point of parent.children) {
      if (point.localName !== 'navPoint') continue;
      const label = point.getElementsByTagNameNS('*', 'text')[0]?.textContent?.trim() ?? '';
      const href = point.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src') ?? '';
      out.push({
        label,
        path: href ? resolvePath(ncxItem.path, href.split('#')[0]) : null,
        hash: href.includes('#') ? href.split('#')[1] : null,
        depth,
      });
      out.push(...walk(point, depth + 1));
    }
    return out;
  };
  const map = doc.getElementsByTagNameNS('*', 'navMap')[0];
  return map ? walk(map, 0) : [];
}

/**
 * Turns one spine document into HTML that is safe to inject into the reader:
 * scripts and publisher stylesheets are dropped, internal image references are
 * swapped for blob URLs and internal links become data attributes.
 */
function renderChapter(res, item) {
  const doc = parseXml(res.text(item.path), 'text/html');
  const body = doc.body ?? doc.documentElement;

  for (const el of body.querySelectorAll('script, style, link, iframe, object, embed')) {
    el.remove();
  }

  for (const img of body.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    const url = src && !/^(https?:|data:)/i.test(src) ? res.url(resolvePath(item.path, src)) : src;
    if (url) img.setAttribute('src', url);
    else img.remove();
    img.removeAttribute('srcset');
    img.setAttribute('loading', 'lazy');
  }

  // SVG <image xlink:href> is common for full-page cover art.
  for (const image of body.querySelectorAll('image')) {
    const href = image.getAttribute('xlink:href') || image.getAttribute('href');
    const url = href && !/^(https?:|data:)/i.test(href) ? res.url(resolvePath(item.path, href)) : href;
    if (url) {
      image.setAttribute('href', url);
      image.removeAttribute('xlink:href');
    }
  }

  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      // Internal links are resolved by the reader, not by the browser.
      const [target, hash] = href.split('#');
      a.dataset.internal = target ? resolvePath(item.path, target) : item.path;
      if (hash) a.dataset.hash = hash;
      a.removeAttribute('href');
    }
  }

  for (const el of body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    }
  }

  return body.innerHTML;
}

export async function openEpub(buffer) {
  const res = new Resources(await unzipFile(buffer));

  const container = parseXml(res.text('META-INF/container.xml'));
  const opfPath = container
    .getElementsByTagNameNS('*', 'rootfile')[0]
    ?.getAttribute('full-path');
  if (!opfPath) throw new Error('Không đọc được container.xml - tệp có thể không phải EPUB.');

  const pkg = parseXml(res.text(opfPath));
  const manifest = readManifest(pkg, opfPath);
  const { spine, tocId } = readSpine(pkg, manifest);
  if (!spine.length) throw new Error('EPUB không có nội dung nào trong spine.');

  let toc = [];
  try {
    const navItem = [...manifest.values()].find((i) => i.properties.includes('nav'));
    const ncxItem = tocId ? manifest.get(tocId) : null;
    if (navItem) toc = readNavToc(res, navItem);
    else if (ncxItem) toc = readNcxToc(res, ncxItem);
  } catch {
    toc = []; // A broken TOC should never stop the book from opening.
  }
  // Keep only entries that point at a document we can actually show.
  const spinePaths = new Set(spine.map((i) => i.path));
  toc = toc.filter((entry) => entry.path && spinePaths.has(entry.path));
  if (!toc.length) {
    toc = spine.map((item, i) => ({ label: `Phần ${i + 1}`, path: item.path, hash: null, depth: 0 }));
  }

  const meta = readMetadata(pkg);
  const coverItem =
    [...manifest.values()].find((i) => i.properties.includes('cover-image')) ??
    manifest.get(
      [...pkg.getElementsByTagNameNS('*', 'meta')].find((m) => m.getAttribute('name') === 'cover')
        ?.getAttribute('content') ?? '',
    );

  return {
    ...meta,
    coverUrl: coverItem ? res.url(coverItem.path, coverItem.mime) : null,
    chapters: spine.map((item, index) => ({ index, path: item.path, id: item.id })),
    toc,
    /** Renders a spine document on demand - large books stay cheap to open. */
    chapterHtml(index) {
      return renderChapter(res, spine[index]);
    },
    chapterIndexForPath(path) {
      return spine.findIndex((item) => item.path === path);
    },
    close() {
      res.revoke();
    },
  };
}

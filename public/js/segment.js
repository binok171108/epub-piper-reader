/**
 * Splits rendered chapter HTML into sentences, wrapping each one in
 * <span class="sent" data-i="N"> so the reader can highlight whatever the
 * TTS engine is currently speaking without losing the publisher's inline
 * markup (bold, italics, links, footnote refs...).
 */

const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM',
  'FONT', 'I', 'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP',
  'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR',
]);

const SENTENCE_END = /[.!?…。！？;]/;
const CLOSERS = /[)"'”’\]»、]/;

/** Trailing tokens that end in a period but do not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'e.g', 'i.e', 'no', 'vol', 'fig', 'ch',
  'ts', 'ths', 'gs', 'pgs', 'ks', 'bs', 'tp', 'nxb', 'tr', 'th', 'p', 'q', 'cf', 'al',
]);

function isAbbreviation(text, dotIndex) {
  let start = dotIndex;
  while (start > 0 && !/[\s("'“„]/.test(text[start - 1])) start--;
  return ABBREVIATIONS.has(text.slice(start, dotIndex).toLowerCase());
}

/**
 * Cuts a text node's contents into pieces, marking the ones that complete a
 * sentence. Trailing whitespace stays with the piece it follows.
 */
function splitText(data) {
  const pieces = [];
  let start = 0;

  for (let i = 0; i < data.length; i++) {
    if (!SENTENCE_END.test(data[i])) continue;

    let end = i + 1;
    while (end < data.length && (SENTENCE_END.test(data[end]) || CLOSERS.test(data[end]))) end++;

    const next = data[end];
    if (next !== undefined && !/\s/.test(next)) {
      i = end - 1; // "3.5" or "a.b" - not a sentence break.
      continue;
    }
    if (data[i] === '.' && isAbbreviation(data, i)) continue;

    let after = end;
    while (after < data.length && /\s/.test(data[after])) after++;
    pieces.push({ text: data.slice(start, after), ends: true });
    start = after;
    i = after - 1;
  }

  if (start < data.length) pieces.push({ text: data.slice(start), ends: false });
  return pieces;
}

/** Leaf blocks: elements holding text with no other text-holding element inside. */
function collectBlocks(root) {
  const blocks = [];
  const walk = (el) => {
    let claimed = false;
    for (const child of el.children) {
      if (walk(child)) claimed = true;
    }
    if (claimed || INLINE.has(el.tagName)) return claimed;
    if (el.textContent.trim() === '' && !el.querySelector('img, svg')) return false;
    blocks.push(el);
    return true;
  };
  walk(root);
  return blocks;
}

function wrapBlock(block, sentences) {
  const frag = document.createDocumentFragment();
  const ancestors = []; // original inline elements currently open
  let clones = []; // their counterparts inside the current sentence span
  let span = null;
  let buffer = '';

  const tip = () => (clones.length ? clones[clones.length - 1] : span);

  const openSpan = () => {
    span = document.createElement('span');
    span.className = 'sent';
    frag.appendChild(span);
    clones = [];
    let target = span;
    for (const original of ancestors) {
      const clone = original.cloneNode(false);
      target.appendChild(clone);
      clones.push(clone);
      target = clone;
    }
    buffer = '';
  };

  const closeSpan = () => {
    const text = buffer.replace(/\s+/g, ' ').trim();
    if (text) {
      span.dataset.i = String(sentences.length);
      sentences.push(text);
    } else {
      span.classList.remove('sent'); // markup only (images, ornaments) - nothing to read
    }
    openSpan();
  };

  const process = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        for (const piece of splitText(child.data)) {
          tip().appendChild(document.createTextNode(piece.text));
          buffer += piece.text;
          if (piece.ends) closeSpan();
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === 'BR') {
          tip().appendChild(child.cloneNode(false));
          buffer += ' ';
          closeSpan();
        } else if (INLINE.has(child.tagName) && child.tagName !== 'IMG') {
          const clone = child.cloneNode(false);
          tip().appendChild(clone);
          ancestors.push(child);
          clones.push(clone);
          process(child);
          ancestors.pop();
          clones.pop();
        } else {
          tip().appendChild(child.cloneNode(true));
          buffer += child.textContent;
        }
      }
    }
  };

  openSpan();
  process(block);
  closeSpan();
  if (span && !span.hasChildNodes()) span.remove(); // trailing empty span

  block.replaceChildren(frag);
}

/**
 * Rewrites `container` in place and returns the sentence texts in reading
 * order. Index N corresponds to `.sent[data-i="N"]`.
 */
export function segment(container) {
  const sentences = [];
  for (const block of collectBlocks(container)) wrapBlock(block, sentences);
  return sentences;
}

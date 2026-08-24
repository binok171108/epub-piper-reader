/**
 * Grouping sentences into synthesis requests, and finding them again inside
 * the resulting audio.
 *
 * Shared by both builds so the two cannot drift apart.
 */

/**
 * Groups consecutive sentences into one request.
 *
 * One request per sentence means paying a connection setup for three to five
 * seconds of speech. When that overhead approaches the length of the audio,
 * synthesis cannot outrun playback and no amount of buffering helps - the
 * buffer just drains more slowly. Asking for a paragraph at a time amortises
 * the overhead across far more audio.
 *
 * Sentences are never split: a sentence longer than the limit becomes a chunk
 * of its own rather than being cut in half.
 *
 * `firstMaxChars` sizes only the opening request. Nothing is playing yet at
 * that point and the reader is waiting, so it pays to keep the first one
 * short; once audio is running there is a whole chunk's worth of time to
 * fetch the next, and bigger is cheaper.
 */
export function buildChunks(sentences, maxChars, firstMaxChars = maxChars) {
  const chunks = [];
  let current = null;
  sentences.forEach((text, index) => {
    const limit = chunks.length <= 1 ? firstMaxChars : maxChars;
    if (current && current.text.length + 1 + text.length > limit) current = null;
    if (!current) {
      current = { first: index, last: index, text: '', ranges: [] };
      chunks.push(current);
    }
    const start = current.text.length ? current.text.length + 1 : 0;
    current.text = current.text ? `${current.text} ${text}` : text;
    current.ranges.push({ index, start });
    current.last = index;
  });
  return chunks;
}

/** Maps sentence index -> chunk index. */
export function chunkIndexBySentence(chunks) {
  const map = [];
  chunks.forEach((chunk, index) => {
    for (const range of chunk.ranges) map[range.index] = index;
  });
  return map;
}

/**
 * Where each sentence of a chunk begins, in seconds.
 *
 * WordBoundary events give an audio offset per spoken word; walking them
 * against the text recovers a character position, and from there a sentence.
 * Without metadata the split is estimated from character counts, which drifts
 * a little but still tracks the reading.
 */
export function sentenceStarts(chunk, boundaries, duration) {
  if (boundaries?.length) {
    const marks = [];
    let cursor = 0;
    for (const boundary of boundaries) {
      const at = chunk.text.indexOf(boundary.text, cursor);
      if (at < 0) continue;
      cursor = at + boundary.text.length;
      marks.push({ charPos: at, seconds: boundary.timeMs / 1000 });
    }
    if (marks.length) {
      return chunk.ranges.map((range, i) => {
        if (i === 0) return 0;
        return marks.find((mark) => mark.charPos >= range.start)?.seconds ?? null;
      });
    }
  }
  const total = chunk.text.length || 1;
  return chunk.ranges.map((range) => (duration || 0) * (range.start / total));
}

/** Index into `starts` of the sentence being spoken at `seconds`. */
export function activeSentence(starts, seconds) {
  let current = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] != null && starts[i] <= seconds) current = i;
  }
  return current;
}

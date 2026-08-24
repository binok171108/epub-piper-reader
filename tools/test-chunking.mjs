/**
 * Pure checks on how sentences are grouped into requests. No browser needed.
 */
import { buildChunks, chunkIndexBySentence, sentenceStarts } from '../public/js/chunking.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const sentences = [
  'Câu đầu tiên.',
  'Một câu rất dài được lặp lại nhiều lần để vượt quá giới hạn. '.repeat(12).trim(),
  'Câu ngắn.',
  ...Array.from({ length: 30 }, (_, i) => `Câu số ${i} có độ dài trung bình để gom nhóm.`),
];

const chunks = buildChunks(sentences, 900, 300);

/* Sentences must survive whole - the whole point of grouping by sentence. */
const rejoined = chunks.map((chunk) => chunk.text).join(' ');
check('ghép các chunk lại đúng bằng văn bản gốc', rejoined === sentences.join(' '));

const everySentenceWhole = sentences.every((sentence) =>
  chunks.some((chunk) => chunk.text.includes(sentence)),
);
check('không câu nào bị cắt giữa hai chunk', everySentenceWhole);

const longest = sentences[1];
const holder = chunks.find((chunk) => chunk.text.includes(longest));
check(
  'câu dài hơn giới hạn vẫn nguyên vẹn trong một chunk',
  Boolean(holder),
  `câu ${longest.length} ký tự, chunk ${holder?.text.length} ký tự`,
);

/* Ramp: the opening request is short, the rest are not. */
check('chunk đầu ngắn hơn giới hạn mở đầu', chunks[0].text.length <= 300, `${chunks[0].text.length} ký tự`);
const later = chunks.slice(1).filter((chunk) => chunk.ranges.length > 1);
check(
  'các chunk sau dùng giới hạn lớn hơn',
  later.length > 0 && later.some((chunk) => chunk.text.length > 300),
  later.map((chunk) => chunk.text.length).join(', '),
);

/* Bookkeeping the players depend on. */
const map = chunkIndexBySentence(chunks);
check(
  'mỗi câu thuộc đúng một chunk',
  sentences.every((_, i) => chunks[map[i]]?.ranges.some((range) => range.index === i)),
);
check('không có chunk rỗng', chunks.every((chunk) => chunk.text.trim().length > 0));

/* Sentence offsets, with metadata and without. */
const simple = buildChunks(['Xin chào bạn.', 'Hôm nay trời đẹp.'], 900);
const withMeta = sentenceStarts(
  simple[0],
  [
    { text: 'Xin', timeMs: 0 },
    { text: 'chào', timeMs: 400 },
    { text: 'bạn', timeMs: 800 },
    { text: 'Hôm', timeMs: 1500 },
  ],
  3,
);
check('mốc câu lấy từ metadata', withMeta[0] === 0 && withMeta[1] === 1.5, JSON.stringify(withMeta));

const estimated = sentenceStarts(simple[0], [], 3);
check(
  'không có metadata thì ước lượng theo ký tự',
  estimated[0] === 0 && estimated[1] > 0 && estimated[1] < 3,
  JSON.stringify(estimated.map((n) => Number(n.toFixed(2)))),
);

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} kiểm tra đạt.`);
process.exit(failed ? 1 : 0);

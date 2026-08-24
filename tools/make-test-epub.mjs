// Builds a small EPUB 3 file used by the smoke test.
import { zipSync, strToU8 } from 'fflate';
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';

const chapter = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title><link rel="stylesheet" href="style.css"/></head>
<body><h1>${title}</h1>${body}</body></html>`;

const files = {
  'mimetype': strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
  'OEBPS/book.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-book-0001</dc:identifier>
    <dc:title>Sách thử nghiệm</dc:title>
    <dc:creator>Tác giả Thử</dc:creator>
    <dc:language>vi</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="pic" href="img/pic.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`),
  'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Mục lục</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Chương một</a></li>
  <li><a href="ch2.xhtml">Chương hai</a></li>
</ol></nav></body></html>`),
  'OEBPS/style.css': strToU8('body { color: red }'),
  // 1x1 PNG - checks that internal images become usable blob URLs.
  'OEBPS/img/pic.png': new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  ),
  'OEBPS/ch1.xhtml': strToU8(
    chapter(
      'Chương một',
      `<p>Xin chào các bạn. Hôm nay trời rất đẹp!</p>
       <p>Giá vé là 12.500 đồng nên <em>không hề</em> đắt. TS. Nguyễn nói vậy.</p>
       <p>Câu này có <strong>chữ đậm ở giữa câu</strong> và kết thúc ở đây.</p>
       <p>Toán &amp; Lý &lt; Hoá.</p>
       <p><img src="img/pic.png" alt="ảnh minh hoạ"/></p>`,
    ),
  ),
  'OEBPS/ch2.xhtml': strToU8(
    chapter('Chương hai', '<p>Đoạn đầu của chương hai. Đoạn này có hai câu.</p>'),
  ),
};

writeFileSync(new URL('../test-book.epub', import.meta.url), zipSync(files, { level: 0 }));
console.log('Wrote test-book.epub');

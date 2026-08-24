# Đọc EPUB · Piper TTS

PWA đọc sách EPUB thành tiếng, với hai lựa chọn giọng:

| Engine | Chạy ở đâu | Cần mạng | Đánh đổi |
|---|---|---|---|
| **Piper (VITS)** — mặc định | WebAssembly trên chính thiết bị | Chỉ lần tải model đầu | Hoàn toàn offline, không văn bản nào rời khỏi máy. Phải tải model, giọng kém tự nhiên hơn |
| **Microsoft Edge TTS** | Máy chủ Microsoft | Mọi câu | Giọng hay hơn hẳn, không phải tải gì. **Văn bản được gửi đi để tổng hợp** |

Được viết cho iPhone/iPad (thêm vào màn hình chính), nhưng chạy trên mọi trình
duyệt hiện đại.

## Nó hoạt động thế nào

```
tệp .epub  →  fflate giải nén  →  OPF/spine/NCX  →  HTML từng chương
                                                          ↓
                                              tách câu → <span class="sent">
                                                          ↓
              Web Worker:  eSpeak-NG (WASM) → phoneme ids
                           onnxruntime-web (WASM) → model Piper .onnx → PCM
                                                          ↓
                                   WAV blob → <audio> → loa / màn hình khoá
```

Với Edge TTS, hai bước WASM ở giữa được thay bằng một WebSocket tới dịch vụ
read-aloud của Microsoft, trả về MP3 — phần còn lại của đường ống giữ nguyên.

Mỗi câu được tổng hợp riêng, và trình phát luôn dựng sẵn 2 câu kế tiếp, nên phần
lớn thời gian câu sau đã sẵn sàng trước khi câu trước đọc xong.

| Thành phần | Nguồn | Kích thước | Lưu ở đâu |
|---|---|---|---|
| Vỏ ứng dụng (HTML/CSS/JS) | repo này | ~60 KB | Cache API (service worker) |
| eSpeak-NG + dữ liệu phoneme | `@diffusionstudio/piper-wasm` | ~18,7 MB | Cache API, tải khi dùng lần đầu |
| onnxruntime-web | `onnxruntime-web@1.18` | ~10,6 MB (bản SIMD) | Cache API, tải khi dùng lần đầu |
| Model giọng `.onnx` | Hugging Face `rhasspy/piper-voices` | tuỳ giọng (bản `medium` lớn hơn `low`/`x_low` khá nhiều) | Cache API `piper-models-v1` |

## Chạy thử tại máy

```bash
npm install        # postinstall sẽ copy WASM vào public/vendor/
npm run dev        # http://localhost:8080
```

Service worker chỉ đăng ký trên `https://` hoặc `localhost`. Mở qua IP LAN từ
điện thoại sẽ **không** có chế độ offline — muốn thử trên iPhone thì deploy lên
một host https (xem dưới).

## Đưa lên mạng (cần https để thử trên iPhone)

Thư mục `public/vendor/` **không** nằm trong git (39 MB) — nó được sinh lại từ
`node_modules` khi build.

### Cách 1 — không cần repo, không cần host git

```bash
npm install && npm run dist
```

Sinh ra `dist/` và `epub-reader-site.zip` (~15 MB). Kéo thả file zip đó vào
**Cloudflare Pages → Direct Upload** hoặc **Netlify Drop** là có ngay một URL
https. Đây là đường nhanh nhất.

### Cách 2 — GitHub Pages

Repo này đã có sẵn `.github/workflows/deploy-pages.yml`. Bật một lần:

**Settings → Pages → Build and deployment → Source: GitHub Actions**

Rồi mỗi lần push lên `main` là tự deploy. CI tự chạy `npm ci` để sinh lại
`public/vendor/`, nên không cần commit 39 MB WASM vào git.

Bản đang chạy: **https://binok171108.github.io/epub-piper-reader/**

> Lưu ý: GitHub Pages cho repo **private** chỉ có ở gói Pro/Team/Enterprise.
> Repo này để public nên dùng được với tài khoản Free.

## Dùng trên iPhone

1. Mở URL Pages bằng **Safari** (không phải Chrome iOS).
2. Share → **Thêm vào MH chính**. Bước này quan trọng: PWA trên màn hình chính
   được cấp hạn mức lưu trữ lớn hơn và ít bị Safari xoá dữ liệu hơn.
3. Mở app → ⚙︎ → chọn giọng → **Tải model về máy**. Đây là lần duy nhất cần mạng.
4. ☰ → chọn tệp EPUB (từ Files/iCloud) → bấm ▶.

Bấm vào bất kỳ câu nào để nhảy tới đó. Vị trí đọc được ghi nhớ theo từng cuốn.

## Cài đặt đáng chú ý

- **Tốc độ phát** đổi `playbackRate` của thẻ `<audio>` — có hiệu lực tức thì.
- **Độ dài âm (model)** đổi `length_scale` của Piper — giọng rõ hơn ở tốc độ chậm,
  nhưng phải tổng hợp lại từ câu hiện tại.
- **Giọng tự host**: thêm query vào URL để dùng model Piper của riêng bạn, kể cả
  cùng origin với app (khi đó service worker cache luôn cả model):

  ```
  ?model=./voices/vi_VN-vais1000-medium.onnx&config=./voices/vi_VN-vais1000-medium.onnx.json
  ```

## Edge TTS

Chọn giọng ở nhóm **“Microsoft Edge · cần mạng”** trong Cài đặt. Tiếng Việt có
`vi-VN-HoaiMyNeural` (nữ) và `vi-VN-NamMinhNeural` (nam).

Danh sách dựng sẵn chỉ là một phần nhỏ; ô **“Thêm giọng Edge khác”** nhận bất kỳ
tên giọng nào — lấy danh sách đầy đủ bằng `edge-tts --list-voices`. Giọng tự nhập
được nhớ lại trong `localStorage`.

Thanh **Tốc độ tổng hợp** ánh xạ sang `prosody rate` của SSML (thay vì
`length_scale` của Piper), nên đổi tốc độ ở đây cho giọng tự nhiên hơn là chỉnh
tốc độ phát.

### Rủi ro cần biết

- **Riêng tư.** Mỗi câu đi qua máy chủ Microsoft. App nói rõ điều này trong Cài đặt
  khi bạn đang chọn giọng Edge. Đây cũng là lý do Piper vẫn là mặc định.
- **Endpoint không chính thức.** Đây là dịch vụ read-aloud của trình duyệt Edge,
  không phải API công khai có hợp đồng — Microsoft có thể đổi hoặc chặn bất cứ lúc nào.
- **Origin.** Trình duyệt tự đặt header `Origin`, trang web không giả được. Chưa
  rõ endpoint có chấp nhận origin lạ hay không. Nếu bị từ chối, dựng một relay
  nhỏ rồi trỏ vào:

  ```
  ?edge_endpoint=wss://relay-cua-ban/edge/v1
  ```
- **`Sec-MS-GEC-Version` sẽ cũ dần.** Token chống lạm dụng được tính đúng theo
  thuật toán của edge-tts, nhưng chuỗi phiên bản Edge đi kèm là hằng số. Đổi
  không cần build lại:

  ```
  ?edge_gec_version=1-131.0.2903.86
  ```
- **`?edge_format=`** đổi định dạng audio yêu cầu (mặc định
  `audio-24khz-48kbitrate-mono-mp3`). Định dạng `riff-24khz-16bit-mono-pcm` dùng
  cho relay/mock; không rõ endpoint thật có nhận không.

### Dùng relay

Tất cả tham số ở trên là của **trang web**, không phải của URL WebSocket. Đặt
nguyên URL relay vào `edge_endpoint`, còn lại để riêng:

```
https://binok171108.github.io/epub-piper-reader/?edge_endpoint=wss://relay:8585/edge/v1&edge_format=pcm
```

Query có sẵn trong `edge_endpoint` vẫn được giữ nguyên khi client nối thêm
`TrustedClientToken` / `Sec-MS-GEC` / `ConnectionId`.

Client **tự nhận diện định dạng audio từ chính bytes trả về** (RIFF/WAVE, OggS,
fLaC, ID3, MPEG frame sync), nên nhãn `edge_format` sai cũng không làm hỏng phát
nhạc. Riêng PCM thô không có header thì không đoán được: khi bytes không khớp
container nào **và** `edge_format` có chữ `pcm`/`raw`, client tự bọc WAV header,
coi là 16-bit mono. Sample rate lấy từ tên format (`...24khz...`), không có thì
mặc định 24000 — đổi bằng `?edge_pcm_rate=16000`.

## Giới hạn đã biết

- **Chỉ chạy 1 luồng.** `SharedArrayBuffer` cần COOP/COEP, mà GitHub Pages không
  đặt được header. Bật cross-origin isolation bằng service worker (`coi-serviceworker`)
  lại làm hỏng việc tải model từ Hugging Face, nên bản này cố ý dùng 1 luồng.
  Muốn nhanh hơn: self-host với header COOP/COEP **và** để model cùng origin.
- **iOS tạm dừng khi ra khỏi app.** Thẻ `<audio>` + Media Session giúp có điều
  khiển ở màn hình khoá, nhưng Safari vẫn có thể ngắt WebAssembly khi app ở nền
  lâu. Muốn nghe liên tục khi tắt máy thật sự ổn định thì phải là app native.
- **Yêu cầu WASM SIMD** → iOS 16.4 trở lên (có sẵn bản fallback không SIMD nhưng
  chậm hơn nhiều).
- **Tách câu theo luật**, không phải mô hình: có xử lý số thập phân và một số từ
  viết tắt phổ biến (`TS.`, `Mr.`, `e.g`…), nhưng vẫn sẽ sai ở vài trường hợp lạ.
- **CSS của nhà xuất bản bị bỏ.** Sách được render bằng typography riêng của app.
  Sách layout cố định (fixed-layout, truyện tranh) sẽ không hiển thị đúng ý đồ.

## Kiểm thử

```bash
npm test
```

Chạy 35 kiểm tra trên Chromium headless: mở EPUB, tách câu, ảnh, mục lục, nhớ vị
trí, khởi động cả hai khối WASM, tổng hợp giọng end-to-end, tự chuyển câu/chương,
**tải lại được khi đã ngắt mạng**, và toàn bộ giao thức Edge TTS.

Hai bộ giả lập giúp test không cần mạng:

- `tools/make-test-model.mjs` — model `.onnx` tí hon cùng chữ ký input/output với
  Piper thật, nên CI không phải tải 60 MB.
- `tools/mock-edge-server.mjs` — máy chủ nói đúng giao thức WebSocket của Edge.
  Nó **tự tính lại token `Sec-MS-GEC`** rồi so với cái client gửi, đồng thời bắt
  lỗi framing, header, SSML và escape XML.

Ngoài ra thuật toán `Sec-MS-GEC` đã được đối chiếu khớp từng ký tự với bản
implement tham chiếu bằng Python trên nhiều mốc thời gian, kể cả ranh giới cửa
sổ 5 phút.

> Lưu ý trung thực: toàn bộ kiểm thử chạy trên Chromium headless.
> Chưa chạy thử trong môi trường build này (bị chặn mạng, không có thiết bị iOS):
> **model Piper thật**, **endpoint Edge TTS thật của Microsoft**, và **Safari iOS**.
> Cụ thể, việc endpoint Edge có chấp nhận `Origin` của một trang web bất kỳ hay
> không là điều mình không kiểm chứng được — hãy thử trước khi tin vào nó.

## Cấu trúc

```
.github/workflows/deploy-pages.yml   deploy lên GitHub Pages
public/
  index.html  app.css  manifest.webmanifest  sw.js
  js/
    app.js         giao diện, thư viện sách, cài đặt
    epub.js        giải nén + đọc OPF/spine/TOC
    segment.js     tách câu, bọc <span class="sent">
    player.js      hàng đợi tổng hợp + <audio> + Media Session
    tts-worker.js  eSpeak-NG + onnxruntime-web (chạy ngoài main thread)
    edge-tts.js    client WebSocket cho Edge read-aloud
    store.js       IndexedDB (sách, vị trí) + Cache API (model)
    voices.js      danh mục giọng (cả hai engine)
scripts/
  vendor.mjs   copy WASM từ node_modules → public/vendor
  serve.mjs    static server cho dev
tools/         sinh icon, EPUB mẫu, model giả, mock Edge server, smoke test
```

## Giấy phép

Code trong repo này: MIT (xem `LICENSE`). Các thành phần đi kèm giữ giấy phép gốc của chúng
(onnxruntime-web — MIT; eSpeak-NG — GPLv3; model giọng Piper — xem MODEL_CARD của
từng giọng trên Hugging Face). Edge TTS là dịch vụ của Microsoft, dùng qua
endpoint read-aloud không chính thức của trình duyệt Edge — trách nhiệm tuân thủ
điều khoản của Microsoft thuộc về người triển khai.

/**
 * Voice catalogue for both engines.
 *
 *   provider: 'piper' - a VITS model that runs on the device. Downloaded once
 *                       (tens of MB), then works with no network at all.
 *   provider: 'edge'  - Microsoft Edge's online read-aloud voices. Nothing to
 *                       download and the voices are better, but every sentence
 *                       is sent to Microsoft's servers to be synthesised.
 */
export const MODEL_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

export const PIPER_VOICES = [
  {
    id: 'vi_VN-vais1000-medium',
    label: 'Tiếng Việt · vais1000',
    language: 'vi',
    quality: 'medium',
    note: 'Giọng nữ, chất lượng tốt nhất cho tiếng Việt. Model lớn nhất, tổng hợp chậm nhất.',
    path: 'vi/vi_VN/vais1000/medium/vi_VN-vais1000-medium.onnx',
  },
  {
    id: 'vi_VN-25hours_single-low',
    label: 'Tiếng Việt · 25hours',
    language: 'vi',
    quality: 'low',
    note: 'Giọng nữ, nhẹ hơn medium - hợp với iPhone đời cũ.',
    path: 'vi/vi_VN/25hours_single/low/vi_VN-25hours_single-low.onnx',
  },
  {
    id: 'vi_VN-vivos-x_low',
    label: 'Tiếng Việt · VIVOS',
    language: 'vi',
    quality: 'x_low',
    note: 'Model nhỏ và nhanh nhất, chất lượng giọng thấp hơn rõ rệt.',
    path: 'vi/vi_VN/vivos/x_low/vi_VN-vivos-x_low.onnx',
  },
  {
    id: 'en_US-hfc_female-medium',
    label: 'English (US) · HFC Female',
    language: 'en',
    quality: 'medium',
    note: 'Giọng nữ Mỹ, tự nhiên.',
    path: 'en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx',
  },
  {
    id: 'en_US-ryan-low',
    label: 'English (US) · Ryan',
    language: 'en',
    quality: 'low',
    note: 'Giọng nam Mỹ, model nhẹ.',
    path: 'en/en_US/ryan/low/en_US-ryan-low.onnx',
  },
  {
    id: 'en_GB-alan-low',
    label: 'English (UK) · Alan',
    language: 'en',
    quality: 'low',
    note: 'Giọng nam Anh, model nhẹ.',
    path: 'en/en_GB/alan/low/en_GB-alan-low.onnx',
  },
].map((voice) => ({ ...voice, provider: 'piper' }));

/**
 * A useful slice of Edge's catalogue rather than all ~500 voices. Any other
 * Edge voice name can be typed into the settings panel by hand.
 */
const EDGE_VOICE_NAMES = [
  ['vi-VN-HoaiMyNeural', 'Tiếng Việt · Hoài My', 'vi', 'nữ'],
  ['vi-VN-NamMinhNeural', 'Tiếng Việt · Nam Minh', 'vi', 'nam'],
  ['en-US-AvaNeural', 'English (US) · Ava', 'en', 'nữ'],
  ['en-US-AndrewNeural', 'English (US) · Andrew', 'en', 'nam'],
  ['en-US-EmmaNeural', 'English (US) · Emma', 'en', 'nữ'],
  ['en-US-BrianNeural', 'English (US) · Brian', 'en', 'nam'],
  ['en-US-AriaNeural', 'English (US) · Aria', 'en', 'nữ'],
  ['en-US-GuyNeural', 'English (US) · Guy', 'en', 'nam'],
  ['en-US-JennyNeural', 'English (US) · Jenny', 'en', 'nữ'],
  ['en-GB-SoniaNeural', 'English (UK) · Sonia', 'en', 'nữ'],
  ['en-GB-RyanNeural', 'English (UK) · Ryan', 'en', 'nam'],
  ['ja-JP-NanamiNeural', '日本語 · Nanami', 'ja', 'nữ'],
  ['ja-JP-KeitaNeural', '日本語 · Keita', 'ja', 'nam'],
  ['ko-KR-SunHiNeural', '한국어 · Sun-Hi', 'ko', 'nữ'],
  ['ko-KR-InJoonNeural', '한국어 · InJoon', 'ko', 'nam'],
  ['zh-CN-XiaoxiaoNeural', '中文 · 晓晓', 'zh', 'nữ'],
  ['zh-CN-YunxiNeural', '中文 · 云希', 'zh', 'nam'],
  ['th-TH-PremwadeeNeural', 'ไทย · Premwadee', 'th', 'nữ'],
  ['id-ID-GadisNeural', 'Bahasa Indonesia · Gadis', 'id', 'nữ'],
  ['fr-FR-DeniseNeural', 'Français · Denise', 'fr', 'nữ'],
  ['fr-FR-HenriNeural', 'Français · Henri', 'fr', 'nam'],
  ['de-DE-KatjaNeural', 'Deutsch · Katja', 'de', 'nữ'],
  ['de-DE-ConradNeural', 'Deutsch · Conrad', 'de', 'nam'],
  ['es-ES-ElviraNeural', 'Español · Elvira', 'es', 'nữ'],
  ['es-ES-AlvaroNeural', 'Español · Álvaro', 'es', 'nam'],
  ['ru-RU-SvetlanaNeural', 'Русский · Svetlana', 'ru', 'nữ'],
  ['pt-BR-FranciscaNeural', 'Português (BR) · Francisca', 'pt', 'nữ'],
  ['it-IT-ElsaNeural', 'Italiano · Elsa', 'it', 'nữ'],
];

export const EDGE_VOICES = EDGE_VOICE_NAMES.map(([name, label, language, gender]) => ({
  id: `edge:${name}`,
  provider: 'edge',
  name,
  label,
  language,
  quality: 'online',
  note: `Giọng ${gender} của Microsoft Edge (${name}). Cần mạng; văn bản được gửi tới máy chủ Microsoft để tổng hợp.`,
}));

export function edgeVoice(name) {
  return {
    id: `edge:${name}`,
    provider: 'edge',
    name,
    label: `Edge · ${name}`,
    language: name.split('-')[0] ?? '',
    quality: 'online',
    note: `Giọng Edge tự nhập (${name}). Cần mạng; văn bản được gửi tới máy chủ Microsoft.`,
  };
}

/**
 * A self-hosted Piper model passed on the URL, e.g.
 *   ?model=./voices/vi.onnx&config=./voices/vi.onnx.json
 * Serving the model from the app's own origin lets the service worker cache it
 * alongside everything else.
 */
export function customVoice(search = location.search) {
  const params = new URLSearchParams(search);
  const model = params.get('model');
  if (!model) return null;
  // Absolute URLs: these are resolved again inside the worker, whose base
  // path is /js/, so a relative value would point at the wrong place.
  const modelUrl = new URL(model, location.href).href;
  const configUrl = new URL(params.get('config') || `${model}.json`, location.href).href;
  return {
    id: `custom:${modelUrl}`,
    provider: 'piper',
    label: params.get('voice_label') || 'Giọng tuỳ chỉnh',
    language: params.get('voice_lang') || '',
    quality: 'tự host',
    note: `Model tải từ ${modelUrl}`,
    urls: { model: modelUrl, config: configUrl },
  };
}

/**
 * Overrides for the Edge endpoint, for relays and for local testing. A relay
 * saved in settings applies to every session; the URL still wins over it.
 */
export function edgeOptions(search = location.search) {
  const params = new URLSearchParams(search);
  const options = {};
  try {
    if (localStorage.getItem('relayEndpoint')) options.endpoint = localStorage.getItem('relayEndpoint');
    if (localStorage.getItem('relayBare') !== '0') options.bareWs = true;
  } catch {
    /* storage unavailable */
  }
  if (params.get('edge_endpoint')) options.endpoint = params.get('edge_endpoint');
  if (params.get('edge_format')) options.format = params.get('edge_format');
  if (params.get('edge_gec_version')) options.gecVersion = params.get('edge_gec_version');
  if (params.get('edge_pcm_rate')) options.pcmRate = params.get('edge_pcm_rate');
  if (params.get('edge_bare_ws')) options.bareWs = params.get('edge_bare_ws') !== '0';
  return options;
}

/** Extra Edge voice names the reader typed in themselves. */
export function savedEdgeVoices() {
  try {
    const names = JSON.parse(localStorage.getItem('edgeVoices') || '[]');
    return Array.isArray(names) ? names.map(edgeVoice) : [];
  } catch {
    return [];
  }
}

export function rememberEdgeVoice(name) {
  const names = savedEdgeVoices().map((v) => v.name);
  if (!names.includes(name)) {
    localStorage.setItem('edgeVoices', JSON.stringify([...names, name]));
  }
}

export function allVoices() {
  const custom = customVoice();
  // Piper first: it is the default, and defaulting to the online engine would
  // quietly start sending the book's text to Microsoft.
  return [
    ...(custom ? [custom] : []),
    ...PIPER_VOICES,
    ...savedEdgeVoices(),
    ...EDGE_VOICES,
  ];
}

export function getVoice(id) {
  return allVoices().find((v) => v.id === id) ?? allVoices()[0];
}

export function modelUrls(voice) {
  if (voice.provider !== 'piper') return null;
  if (voice.urls) return voice.urls;
  return {
    model: `${MODEL_BASE}/${voice.path}`,
    config: `${MODEL_BASE}/${voice.path}.json`,
  };
}

/** Picks a sensible default voice for a book's dc:language value. */
export function voiceForLanguage(language) {
  const custom = customVoice();
  if (custom) return custom;
  const code = (language || '').slice(0, 2).toLowerCase();
  return allVoices().find((v) => v.language === code) ?? allVoices()[0];
}

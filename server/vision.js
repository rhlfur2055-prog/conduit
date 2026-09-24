// ============================================================
// 화면 인식 브리지 — 2층 구조
//   1층 ocr()        : tesseract.js (WASM, 오프라인, 키 불필요) → 텍스트 + 좌표
//   2층 understand() : 이미지(+OCR 텍스트) → Claude vision → "무슨 화면이고 무슨 기능인지"
//
// 키가 없으면 2층은 시뮬레이션으로 떨어지고, 1층은 키 없이도 그대로 동작한다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { callLLM } from './llm.js';
import { DATA_DIR } from './store.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

/** 파일 경로 · data:URL · 순수 base64 중 무엇이 와도 { base64, mediaType } 로 만든다 */
export function loadImage(source) {
  const src = String(source || '').trim();
  if (!src) throw new Error('이미지가 비어 있습니다 (파일 경로 또는 data:URL)');

  const dataUrl = src.match(/^data:([^;]+);base64,(.+)$/s);
  if (dataUrl) return { base64: dataUrl[2], mediaType: dataUrl[1] };

  // 경로에는 '.' 이나 ':' 가 들어가므로 base64 문자 집합만으로 구분된다
  if (/^[A-Za-z0-9+/=\s]+$/.test(src) && src.length > 100) {
    return { base64: src.replace(/\s+/g, ''), mediaType: 'image/png' };
  }

  if (!fs.existsSync(src)) throw new Error(`이미지를 찾을 수 없습니다: ${src}`);
  const mediaType = MIME[path.extname(src).toLowerCase()] || 'image/png';
  return { base64: fs.readFileSync(src).toString('base64'), mediaType };
}

/* ---------- 1층: OCR ---------- */
let workerPromise = null;

async function getWorker(lang) {
  // 워커 기동이 느려서(언어 데이터 내려받음) 한 번 만들고 재사용한다
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      // 언어 데이터(수십 MB)를 저장소 루트가 아니라 data 폴더에 캐시한다
      const cachePath = path.join(DATA_DIR, 'ocr-cache');
      fs.mkdirSync(cachePath, { recursive: true });
      return createWorker(lang, undefined, { cachePath });
    })();
  }
  return workerPromise;
}

export async function ocr({ image, lang = 'kor+eng', minConfidence = 60 }) {
  let img;
  try {
    img = loadImage(image);
  } catch (e) {
    return { simulated: true, error: e.message, text: '', words: [] };
  }

  try {
    const worker = await getWorker(lang);
    // blocks:true 를 줘야 단어·줄 좌표가 나온다 (기본값은 text 만)
    const { data } = await worker.recognize(Buffer.from(img.base64, 'base64'), {}, { blocks: true });

    // blocks → paragraphs → lines → words 로 중첩돼 있어 펼친다
    const allLines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) allLines.push(line);
      }
    }

    const min = Number(minConfidence) || 0;
    const box = (b) => (b ? { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null);
    const words = allLines
      .flatMap((l) => l.words || [])
      .filter((w) => (w.confidence ?? 0) >= min)
      .map((w) => ({ text: w.text, confidence: Math.round(w.confidence ?? 0), box: box(w.bbox) }));

    return {
      text: (data.text || '').trim(),
      words,
      lines: allLines
        .map((l) => ({ text: (l.text || '').trim(), confidence: Math.round(l.confidence ?? 0), box: box(l.bbox) }))
        .filter((l) => l.text),
      confidence: Math.round(data.confidence ?? 0),
      lang,
      simulated: false,
    };
  } catch (e) {
    return { simulated: true, error: `OCR 실패: ${e.message}`, text: '', words: [] };
  }
}

/** 워커는 프로세스가 살아 있는 동안 재사용되므로 종료 시 정리한다 */
export async function closeOcr() {
  if (!workerPromise) return;
  try { (await workerPromise).terminate(); } catch { /* 이미 종료됨 */ }
  workerPromise = null;
}

/* ---------- 2층: 화면 이해 ---------- */
const UNDERSTAND_SYSTEM = `너는 화면 캡처를 보고 "이게 무슨 화면이고 무엇을 할 수 있는지" 설명하는 도우미다.
반드시 아래 형태의 JSON 하나만 출력한다. 설명 문장이나 코드펜스를 붙이지 마라.

{
  "screenType": "이 화면이 무엇인지 한 줄",
  "summary": "무슨 화면인지 2~3문장",
  "features": [{ "name": "기능 이름", "purpose": "무엇을 위한 것인지", "where": "화면 어디에 있는지" }],
  "actions": ["사용자가 여기서 할 수 있는 동작"],
  "texts": ["화면에서 읽은 중요한 문구"]
}

확실하지 않은 것은 지어내지 말고 비워 둬라.`;

export async function understandScreen({ image, lang = 'kor+eng', hint = '', withOcr = true, model }) {
  let img;
  try {
    img = loadImage(image);
  } catch (e) {
    return { simulated: true, error: e.message };
  }

  // OCR 텍스트를 같이 주면 작은 글씨 인식률이 올라간다
  let ocrResult = null;
  if (withOcr) ocrResult = await ocr({ image, lang });

  const parts = [];
  if (hint) parts.push(`참고: ${hint}`);
  if (ocrResult?.text) parts.push(`이 화면에서 OCR 로 읽은 텍스트:\n${ocrResult.text.slice(0, 3000)}`);
  parts.push('이 화면을 위 JSON 형식으로 설명해 줘.');

  const res = await callLLM({
    system: UNDERSTAND_SYSTEM,
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
        { type: 'text', text: parts.join('\n\n') },
      ],
    }],
  });

  if (res.simulated) {
    return {
      simulated: true,
      note: '연결된 모델이 없어(Claude 키 또는 PC 모델) 화면 이해는 건너뛰었습니다. OCR 결과는 그대로 들어 있습니다.',
      ocr: ocrResult,
    };
  }
  if (res.error) return { error: true, note: res.text, ocr: ocrResult };

  const parsed = parseJson(res.text);
  if (!parsed) return { error: true, note: 'JSON 파싱 실패', raw: res.text, ocr: ocrResult };
  return { ...parsed, ocr: ocrResult, simulated: false, usage: res.usage };
}

/** 모델이 코드펜스나 설명을 붙여도 JSON 만 건져낸다 (테스트에서 직접 쓴다) */
export function parseJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  try { return JSON.parse(body); } catch { /* 아래에서 중괄호 범위로 재시도 */ }
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

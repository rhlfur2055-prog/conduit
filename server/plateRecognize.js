// ============================================================
// 번호판 인식 브리지 — 외부 yolo11 파이프라인(plate_server.py)을 HTTP 로 부른다.
//
//   https://github.com/rhlfur2055-prog/yolo11
//   YOLO11x 탐지 → 다중 전처리 10종 → PaddleOCR → CRNN 한글 교차검증 → 형식 검증
//
// 모델(best.pt · plate_ocr_crnn.pth)과 torch/paddle 런타임이 무거워서 Conduit 안에
// 넣지 않고, 그쪽이 이미 제공하는 FastAPI 서버를 그대로 쓴다.
// 서버가 없으면 { simulated:true } 로 떨어져 워크플로는 계속 흐른다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { loadImage } from './vision.js';

const DEFAULT_BASE = process.env.CONDUIT_PLATE_SERVER || 'http://localhost:5000';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp' };

/** 서버가 떠 있고 엔진 초기화가 끝났는지 */
export async function plateHealth({ baseUrl } = {}) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { reachable: true, ready: false, status: res.status };
    const data = await res.json();
    return { reachable: true, ready: !!data.ready, status: data.status };
  } catch (e) {
    return { reachable: false, ready: false, error: e.message };
  }
}

export async function plateRecognize({ image, baseUrl, minConfidence = 0, timeoutMs = 30000 }) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');

  // 파일 경로 · data:URL · base64 를 모두 받아 바이트로 만든다 (vision.js 와 동일 규칙)
  let bytes;
  let filename = 'frame.png';
  let mediaType = 'image/png';
  try {
    const src = String(image || '').trim();
    if (src && fs.existsSync(src)) {
      bytes = fs.readFileSync(src);
      filename = path.basename(src);
      mediaType = MIME[path.extname(src).toLowerCase()] || 'image/png';
    } else {
      const img = loadImage(image);
      bytes = Buffer.from(img.base64, 'base64');
      mediaType = img.mediaType;
    }
  } catch (e) {
    return { simulated: true, error: e.message, plates: [] };
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mediaType }), filename);

  let res;
  try {
    res = await fetch(`${base}/api/detect`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(Number(timeoutMs) || 30000),
    });
  } catch (e) {
    return {
      simulated: true,
      plates: [],
      note: `번호판 서버에 연결할 수 없습니다 (${base}). yolo11 저장소에서 "python plate_server.py --port 5000" 으로 띄우세요.`,
      error: e.message,
    };
  }

  if (res.status === 503) {
    const detail = await res.json().catch(() => ({}));
    return { simulated: true, plates: [], note: '번호판 엔진이 아직 초기화 중입니다.', error: detail.detail };
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return { error: true, plates: [], status: res.status, note: detail.detail || `HTTP ${res.status}` };
  }

  const data = await res.json();
  const min = Number(minConfidence) || 0;
  const plates = (data.plates || [])
    .filter((p) => (p.confidence ?? 0) >= min)
    .map((p) => ({
      plate: p.plate,
      confidence: p.confidence,
      bbox: p.bbox,
      vehicleBbox: p.vehicle_bbox,
      isAlert: !!p.is_alert,
    }));

  return {
    plates,
    count: plates.length,
    processMs: data.process_ms,
    frameSize: data.frame_size,
    simulated: false,
  };
}

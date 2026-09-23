// ============================================================
// OCR 엔진 선택 — PaddleOCR(기본) · tesseract(대체) · 앙상블(선택)
//
//   Paddle 서버(server/ocr/paddle_ocr_server.py)가 줄을 찾고 한국어·영문 모델로 읽는다.
//   앙상블을 고르면 줄 이미지를 tesseract 한 줄 모드로 3번 더 읽고, 글자 단위로 가중 투표한다.
//
// 실측 (정답을 아는 360줄 — 한 줄 이미지 180 + 여러 줄 문서 36장의 180줄, 글꼴 3종, 12~24px)
//   줄 내용 일치:  tesseract 단독 67%  ·  Paddle 단독 97.2%  ·  앙상블 96.9~97.5% (가중치에 따라)
//   앙상블은 Paddle 단독을 확실히 넘지 못했다 (차이 360줄 중 1~2줄, 글꼴에 따라 오히려 떨어짐). 그래서 기본값은 Paddle 단독이다.
//   남은 오류(끊→끝, ID→10)는 엔진끼리 같이 틀리는 것이라, 이미지를 직접 보는 단계(socraticRead 의 글자 확정)가 맡는다.
// Paddle 서버가 없으면 tesseract 로 떨어진다 (워크플로는 멈추지 않는다).
// ============================================================
import path from 'node:path';
import fs from 'node:fs';
import { ocr as tesseractOcr, loadImage } from './vision.js';
import { DATA_DIR } from './store.js';

const DEFAULT_BASE = process.env.CONDUIT_PADDLE_OCR || 'http://127.0.0.1:8866';
const HANGUL = /[가-힣ㄱ-ㆎ]/;

// [영문·기호일 때 tesseract, paddle, 한글일 때 paddle, tesseract] — 글꼴 하나를 빼고 고른 값
// 앙상블 가중치 — 한글은 Paddle 을 크게 믿고, 영문·기호는 tesseract 3표 + 영문 모델이 모이면 Paddle 을 이긴다
export const DEFAULT_WEIGHTS = Object.freeze({ latinTess: 0.5, latinPaddle: 1, latinPaddleEn: 0.5, hangulPaddle: 2, hangulTess: 0.5 });

const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

function weight(engine, ch, W, around = '') {
  // 영문 모델은 한글을 못 읽는다 — 한글 자리(기준 줄 쪽 글자 포함)에는 투표하지 않는다
  if (engine === 'paddle_en') return HANGUL.test(`${ch || ''}${around}`) ? 0 : W.latinPaddleEn;
  const paddle = engine === 'paddle';
  if (ch && HANGUL.test(ch)) return paddle ? W.hangulPaddle : W.hangulTess;
  return paddle ? W.latinPaddle : W.latinTess;
}

function levenshtein(A, B) {
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length];
}

/** 기준 줄 고르기 — 다른 후보들과 가장 많이 겹치는 후보 (한 엔진이 통째로 망가진 줄에서 그 엔진을 기준으로 삼지 않도록) */
export function pickPivot(cands) {
  let best = 0;
  let bestScore = -1;
  const arr = cands.map((c) => [...norm(c.text)]);
  // 영문 모델은 한글을 못 읽으므로, 다른 후보가 있으면 기준 줄이 되지 못한다
  const eligible = cands.some((c) => c.engine !== 'paddle_en') ? (i) => cands[i].engine !== 'paddle_en' : () => true;
  arr.forEach((a, i) => {
    if (!eligible(i)) return;
    let s = 0;
    arr.forEach((b, j) => {
      if (i === j) return;
      const n = Math.max(a.length, b.length);
      s += n ? 1 - levenshtein(a, b) / n : 1;
    });
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return best;
}

/**
 * 글자 단위 가중 투표 (ROVER).
 * 기준 줄에 맞춰 각 후보를 정렬하고, 위치마다 [글자 · 삭제] 를, 위치 사이마다 [끼워 넣을 문자열] 을 가중 투표한다.
 * @param {{engine:'paddle'|'tesseract', text:string}[]} cands
 */
export function roverVote(cands, { pivotIndex, weights = DEFAULT_WEIGHTS } = {}) {
  const list = cands.filter((c) => typeof c?.text === 'string');
  if (!list.length) return '';
  const pi = Number.isInteger(pivotIndex) ? pivotIndex : pickPivot(list);
  const P = [...norm(list[pi].text)];
  const votes = P.map(() => new Map());
  const ins = Array.from({ length: P.length + 1 }, () => new Map());
  const add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);

  for (const c of list) {
    const B = [...norm(c.text)];
    const d = Array.from({ length: P.length + 1 }, (_, i) => {
      const row = new Array(B.length + 1).fill(0);
      row[0] = i;
      return row;
    });
    for (let j = 0; j <= B.length; j++) d[0][j] = j;
    for (let i = 1; i <= P.length; i++) {
      for (let j = 1; j <= B.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (P[i - 1] === B[j - 1] ? 0 : 1));
      }
    }
    const gaps = new Array(P.length + 1).fill('');   // 이 후보가 각 틈에 끼워 넣은 문자열 (없으면 '')
    let i = P.length;
    let j = B.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (P[i - 1] === B[j - 1] ? 0 : 1)) {
        add(votes[i - 1], B[j - 1], weight(c.engine, B[j - 1], weights, P[i - 1])); i--; j--;
      } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
        add(votes[i - 1], '', weight(c.engine, P[i - 1], weights)); i--;
      } else {
        gaps[i] = B[j - 1] + gaps[i]; j--;
      }
    }
    // 틈마다 한 표: 끼워 넣은 문자열(없으면 '' = 끼우지 않음)
    gaps.forEach((g, k) => add(ins[k], g, weight(c.engine, [...g][0] || P[k] || P[k - 1] || 'a', weights, `${P[k - 1] || ''}${P[k] || ''}`)));
  }

  // 동점이면 기준 줄 쪽(기준 글자 · 끼우지 않음)을 남긴다 — 표가 갈리면 바꾸지 않는다
  const best = (m, keep) => [...m.entries()].sort((a, b) => b[1] - a[1] || (b[0] === keep) - (a[0] === keep))[0];
  let out = '';
  for (let k = 0; k <= P.length; k++) {
    const [g] = best(ins[k], '');
    if (g) out += g;
    if (k < P.length) out += best(votes[k], P[k])[0];
  }
  return norm(out);
}

/* ---------- Paddle 서버 ---------- */

export async function paddleHealth({ baseUrl } = {}) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function paddleLines(img, { baseUrl, extras = false, timeoutMs = 60000 } = {}) {
  const base = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const r = await fetch(`${base}/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ image: img.base64, extras }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Paddle OCR 서버 HTTP ${r.status}`);
  return data;
}

/* ---------- tesseract 한 줄 모드 전용 워커 (vision.js 워커의 설정을 건드리지 않는다) ---------- */
let lineWorker = null;
async function getLineWorker(lang) {
  if (!lineWorker) {
    lineWorker = (async () => {
      const { createWorker, PSM } = await import('tesseract.js');
      const cachePath = path.join(DATA_DIR, 'ocr-cache');
      fs.mkdirSync(cachePath, { recursive: true });
      const w = await createWorker(lang, undefined, { cachePath, logger: () => {}, errorHandler: () => {} });
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      return w;
    })();
  }
  return lineWorker;
}

export async function closeEnsemble() {
  if (!lineWorker) return;
  try { (await lineWorker).terminate(); } catch { /* 이미 종료됨 */ }
  lineWorker = null;
}

/**
 * 앙상블 OCR. 결과 모양은 vision.ocr() 와 같다 (text · lines[{text, confidence, box}]) + engine · candidates.
 * @param {'auto'|'paddle'|'ensemble'|'tesseract'} engine  auto: Paddle 서버가 있으면 Paddle, 없으면 tesseract
 */
export async function readText({ image, lang = 'kor+eng', engine = 'auto', minConfidence = 0, baseUrl, weights = DEFAULT_WEIGHTS, _deps = {} } = {}) {
  const tess = _deps.tesseract || tesseractOcr;
  const paddle = _deps.paddle || paddleLines;
  const recognizeLine = _deps.recognizeLine || (async (b64) => {
    const w = await getLineWorker(lang);
    const { data } = await w.recognize(Buffer.from(b64, 'base64'));
    return data.text;
  });

  let img;
  try { img = loadImage(image); } catch (e) { return { simulated: true, error: e.message, text: '', lines: [], words: [] }; }

  if (engine === 'tesseract') return { ...(await tess({ image, lang, minConfidence })), engine: 'tesseract' };

  let pd;
  try {
    pd = await paddle(img, { baseUrl, extras: engine === 'ensemble' });
  } catch (e) {
    if (engine === 'ensemble' || engine === 'paddle') return { error: true, note: `Paddle OCR 서버를 쓸 수 없습니다: ${e.message}`, text: '', lines: [] };
    const t = await tess({ image, lang, minConfidence });
    return { ...t, engine: 'tesseract', note: 'Paddle OCR 서버가 없어 tesseract 만 사용했습니다 (server/ocr/paddle_ocr_server.py 를 띄우면 Paddle).' };
  }

  const vote = engine === 'ensemble';
  const lines = [];
  for (const l of pd.lines || []) {
    if (!vote) {
      const text = norm(l.paddle?.text);
      if (text) {
        lines.push({
          text,
          confidence: Math.round(100 * (l.paddle?.score ?? 0)),
          box: l.box ? { x: l.box[0], y: l.box[1], w: l.box[2], h: l.box[3] } : null,
          candidates: [{ engine: 'paddle', text }, ...(l.paddleEn ? [{ engine: 'paddle_en', text: norm(l.paddleEn.text) }] : [])],
        });
      }
      continue;
    }
    const tessTexts = [];
    for (const key of ['orig', 'up2', 'up3bin']) {
      if (!l.crops?.[key]) continue;
      try { tessTexts.push(await recognizeLine(l.crops[key])); } catch { /* 한 후보가 실패해도 나머지로 투표 */ }
    }
    const cands = [
      { engine: 'paddle', text: l.paddle?.text ?? '' },
      ...(l.paddleEn ? [{ engine: 'paddle_en', text: l.paddleEn.text ?? '' }] : []),
      ...tessTexts.map((t) => ({ engine: 'tesseract', text: t })),
    ];
    const text = roverVote(cands, { weights });
    if (!text) continue;
    const agree = cands.filter((c) => norm(c.text) === text).length;
    lines.push({
      text,
      confidence: Math.round(100 * (l.paddle?.score ?? 0)),
      agreement: `${agree}/${cands.length}`,
      box: l.box ? { x: l.box[0], y: l.box[1], w: l.box[2], h: l.box[3] } : null,
      candidates: cands.map((c) => ({ engine: c.engine, text: norm(c.text) })),
    });
  }
  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    words: [],
    confidence: lines.length ? Math.round(lines.reduce((a, l) => a + l.confidence, 0) / lines.length) : 0,
    engine: vote ? 'paddle+tesseract' : 'paddle',
    ms: pd.ms,
    lang,
    simulated: false,
  };
}

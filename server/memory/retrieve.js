// ============================================================
// 기억 검색 점수 · 통과 판정 (specs/001-verified-memory · FR-004 FR-005)
//
//   score = wCos · cos(질의, 조각) + wOverlap · overlap(질의, 조각)
//   overlap = 질의의 글자 2-gram 중 조각에 들어 있는 비율
//
//   임베딩 유사도만 쓰면 e5-small 에서 무관한 문장도 0.77 이 나온다(실측).
//   그래서 글자 겹침을 섞고, 절대 문턱(minScore · minCos)과 1등 대비 차이(margin)를 모두 넘은 것만 돌려준다.
//   아무것도 못 넘으면 빈 결과 = "기억에 없음" (원칙 II).
// ============================================================

// 기본값은 평가(server/evals/memory-eval.js)에서 절반으로 고르고 나머지 절반으로 확인한 값으로 바꾼다 (T016)
export const DEFAULT_RECALL = Object.freeze({
  k: 5,
  wCos: 0.7,
  wOverlap: 0.3,
  minScore: 0.62,
  minCos: 0.8,
  margin: 0.08,
  minOverlapOnly: 0.5,   // 임베딩이 없을 때 글자 겹침만으로 통과하는 문턱
  candidates: 20,        // 리랭커에 넘길 후보 수
  minRerank: -7,         // 리랭커 로짓 문턱 (bge-reranker-v2-m3)
});

const key = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

export function bigrams(s) {
  const t = key(s);
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/** 질의 2-gram 중 조각에 있는 비율 (0~1) */
export function overlap(query, text) {
  const q = bigrams(query);
  if (!q.size) return 0;
  const c = bigrams(text);
  let hit = 0;
  for (const g of q) if (c.has(g)) hit++;
  return hit / q.size;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 조각마다 점수를 매긴다. 질의·조각 벡터가 없으면 글자 겹침만 쓴다 */
export function scoreAll(query, qVec, entries, cfg = DEFAULT_RECALL) {
  return entries.map((entry) => {
    const cos = qVec ? cosine(qVec, entry.embedding) : null;
    const ov = overlap(query, entry.text);
    const score = cos === null ? ov : cfg.wCos * cos + cfg.wOverlap * ov;
    return { entry, cos, overlap: ov, score };
  }).sort((a, b) => b.score - a.score);
}

/** 통과 판정 — 절대 문턱 · 1등 대비 차이 · (임베딩이 있으면) 최소 코사인 */
export function select(scored, cfg = DEFAULT_RECALL) {
  if (!scored.length) return [];
  const top = scored[0].score;
  return scored.filter((s) => {
    if (s.cos === null) return s.score >= cfg.minOverlapOnly && s.score >= top - cfg.margin;
    return s.score >= cfg.minScore && s.cos >= cfg.minCos && s.score >= top - cfg.margin;
  }).slice(0, cfg.k);
}

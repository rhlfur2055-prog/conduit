// ============================================================
// 기억 검색 평가 (specs/001-verified-memory · SC-002 SC-003 · T015)
//
//   node server/memory/eval.js
//
//   evals/memory-recall.json 의 문서를 임시 기억에 넣고, 질의를 던져 잰다.
//     Top-1 · Top-3 : 관련 질의에서 정답 문서가 1등 / 3등 안에 나온 비율
//     거절 정확도   : 주제가 전혀 다른 질의에서 빈 결과를 돌려준 비율
//     함정 질의(주제는 같지만 답이 기억에 없음)는 검색이 그 문서를 찾아오는 게 맞다 — 답이 없다는 판단은
//     다음 층(인용 검증)의 몫이므로 검색 점수에 넣지 않고 따로 기록만 한다.
//   문턱은 질의의 짝수 번째로 고르고 홀수 번째로 시험한다 (원칙 IV). 결과는 evals/reports 에 남긴다.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const realData = path.join(ROOT, 'server', 'data');
process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-memeval-'));
// 모델은 실제 data 폴더의 캐시를 쓴다 (매번 내려받지 않도록)
fs.symlinkSync?.call(fs, path.join(realData, 'models'), path.join(process.env.CONDUIT_DATA_DIR, 'models'), 'junction');

const { remember } = await import('./memory.js');
const { getEmbedder, EMBED_MODEL } = await import('./embedder.js');
const { scoreAll, select, DEFAULT_RECALL } = await import('./retrieve.js');
const { getReranker, RERANK_MODEL } = await import('./reranker.js');
const { Memory } = await import('../store.js');

const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'memory-recall.json'), 'utf8'));
const embed = await getEmbedder();
if (!embed) { console.error('임베딩 모델을 불러오지 못했습니다.'); process.exit(1); }

for (const d of set.docs) await remember({ docId: d.id, text: d.text, source: { title: d.title } });
const entries = Memory.all();

const queries = [
  ...set.related.map((x, i) => ({ ...x, related: true, half: i % 2 })),
  ...set.unrelated.map((x, i) => ({ ...x, related: false, half: i % 2 })),
];
const vecs = await embed(queries.map((x) => `query: ${x.q}`));
queries.forEach((x, i) => { x.vec = vecs[i]; });

function run(qs, cfg) {
  let rel = 0; let rel3 = 0; let relN = 0; let unr = 0; let unrN = 0; let near = 0; let nearN = 0;
  const misses = [];
  for (const x of qs) {
    const got = select(scoreAll(x.q, x.vec, entries, cfg), cfg);
    if (x.related) {
      relN++;
      const ok = got[0]?.entry.docId === x.doc;
      rel += ok;
      rel3 += got.slice(0, 3).some((g) => g.entry.docId === x.doc);
      if (!ok) misses.push({ q: x.q, want: x.doc, got: got[0]?.entry.docId ?? '(없음)' });
    } else if (x.near) {
      nearN++;
      near += got[0]?.entry.docId === x.near;             // 함정: 그 주제 문서를 찾아오면 검색은 제 할 일을 한 것
    } else {
      unrN++;
      const ok = got.length === 0;
      unr += ok;
      if (!ok) misses.push({ q: x.q, want: '(없음)', got: got[0].entry.docId });
    }
  }
  return { top1: rel / relN, top3: rel3 / relN, reject: unr / unrN, nearFound: nearN ? near / nearN : null, balanced: (rel / relN + unr / unrN) / 2, misses };
}

const grid = [];
for (const wCos of [0.5, 0.6, 0.7, 0.8, 1]) {
  for (let minCos = 0.78; minCos <= 0.9001; minCos += 0.01) {
    for (let minScore = 0.4; minScore <= 0.9001; minScore += 0.02) {
      for (const margin of [0.03, 0.05, 0.08, 0.12]) grid.push({ ...DEFAULT_RECALL, wCos, wOverlap: 1 - wCos, minCos: +minCos.toFixed(2), minScore: +minScore.toFixed(2), margin });
    }
  }
}
const tune = queries.filter((x) => x.half === 0);
const test = queries.filter((x) => x.half === 1);
let best = null;
for (const cfg of grid) {
  const r = run(tune, cfg);
  // 같은 점수면 거절을 더 잘하는 쪽 (할루시네이션 입구를 막는 쪽)을 고른다
  if (!best || r.balanced > best.r.balanced || (r.balanced === best.r.balanced && r.reject > best.r.reject)) best = { cfg, r };
}
const naive = { ...DEFAULT_RECALL, wCos: 1, wOverlap: 0, minCos: 0.7, minScore: 0.7, margin: 1 };
const pct = (v) => (v === null ? '-' : `${(100 * v).toFixed(1)}%`);
const line = (name, r) => console.log(`${name.padEnd(30)} Top-1 ${pct(r.top1).padStart(6)} · Top-3 ${pct(r.top3).padStart(6)} · 무관 거절 ${pct(r.reject).padStart(6)} · 함정에서 그 주제 문서 찾음 ${pct(r.nearFound)}`);

console.log(`모델 ${EMBED_MODEL} · 기억 조각 ${entries.length}개 · 질의 ${queries.length}개 (튜닝 ${tune.length} / 시험 ${test.length})\n`);
line('비교: 유사도만, 0.7 이상 (시험)', run(test, naive));
line('현재 기본값 (시험)', run(test, DEFAULT_RECALL));
line('고른 문턱 (튜닝)', best.r);
const final = run(test, best.cfg);
line('▶ 고른 문턱 (시험 — 처음 보는 질의)', final);
console.log(`\n고른 문턱: ${JSON.stringify({ wCos: best.cfg.wCos, wOverlap: +best.cfg.wOverlap.toFixed(2), minCos: best.cfg.minCos, minScore: best.cfg.minScore, margin: best.cfg.margin })}`);
if (final.misses.length) {
  console.log('시험에서 틀린 것:');
  for (const m of final.misses) console.log(`  "${m.q}" → 기대 ${m.want}, 결과 ${m.got}`);
}
const all = run(queries, best.cfg);
line('참고: 전체 질의', all);

/* ---------- 2단계: 임베딩 후보 20개 → 리랭커 ---------- */
const rerank = await getReranker();
let rr = null;
if (rerank) {
  for (const x of queries) {
    const cands = scoreAll(x.q, x.vec, entries, DEFAULT_RECALL).slice(0, DEFAULT_RECALL.candidates);
    const rs = await rerank(x.q, cands.map((c) => c.entry.text));
    x.rr = cands.map((c, i) => ({ docId: c.entry.docId, s: rs[i] })).sort((a, b) => b.s - a.s);
  }
  const runR = (qs, th) => run2(qs, (x) => x.rr.filter((c) => c.s >= th));
  let bestTh = null;
  for (let th = -12; th <= 8; th += 0.25) {
    const r = runR(tune, th);
    if (!bestTh || r.balanced > bestTh.r.balanced || (r.balanced === bestTh.r.balanced && r.reject > bestTh.r.reject)) bestTh = { th, r };
  }
  console.log(`
리랭커 ${RERANK_MODEL}`);
  line('현재 기본 문턱 (시험)', runR(test, DEFAULT_RECALL.minRerank));
  line('고른 문턱 (튜닝)', bestTh.r);
  const fr = runR(test, bestTh.th);
  line('▶ 고른 문턱 (시험 — 처음 보는 질의)', fr);
  console.log(`고른 문턱: minRerank ${bestTh.th}`);
  if (fr.misses.length) { console.log('시험에서 틀린 것:'); for (const m of fr.misses) console.log(`  "${m.q}" → 기대 ${m.want}, 결과 ${m.got}`); }
  line('참고: 전체 질의', runR(queries, bestTh.th));
  rr = { model: RERANK_MODEL, minRerank: bestTh.th, tune: { ...bestTh.r, misses: undefined }, test: fr };
} else {
  console.log('\n리랭커를 불러오지 못해 2단계 평가는 건너뜀');
}

/** run 과 같은 채점 — 결과 목록만 바깥에서 받는다 */
function run2(qs, pick) {
  let rel = 0; let rel3 = 0; let relN = 0; let unr = 0; let unrN = 0; let near = 0; let nearN = 0;
  const misses = [];
  for (const x of qs) {
    const got = pick(x);
    if (x.related) {
      relN++;
      const ok = got[0]?.docId === x.doc;
      rel += ok; rel3 += got.slice(0, 3).some((g) => g.docId === x.doc);
      if (!ok) misses.push({ q: x.q, want: x.doc, got: got[0]?.docId ?? '(없음)' });
    } else if (x.near) { nearN++; near += got[0]?.docId === x.near; }
    else { unrN++; const ok = got.length === 0; unr += ok; if (!ok) misses.push({ q: x.q, want: '(없음)', got: got[0].docId }); }
  }
  return { top1: rel / relN, top3: rel3 / relN, reject: unr / unrN, nearFound: nearN ? near / nearN : null, balanced: (rel / relN + unr / unrN) / 2, misses };
}

fs.mkdirSync(path.join(ROOT, 'evals', 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evals', 'reports', 'memory-recall.json'), JSON.stringify({
  model: EMBED_MODEL, at: new Date().toISOString(), chunks: entries.length,
  embeddingOnly: { chosen: best.cfg, tune: { ...best.r, misses: undefined }, test: final }, naiveTest: { ...run(test, naive), misses: undefined }, rerank: rr,
}, null, 2));

// ============================================================
// 검증된 읽기 기억 — remember / recall (specs/001-verified-memory)
//
//   remember: 원문 조각(source, 종류별 청킹) + 검증된 사실(fact) 만 저장한다 (원칙 III · FR-008).
//             verified 가 아니거나 인용이 없는 사실은 거부한다. 같은 내용은 두 번 넣지 않는다 (FR-009).
//   recall  : 2단계 — 임베딩(+글자 겹침)으로 후보를 추리고, 리랭커가 질의와 조각을 같이 읽어 채점한다.
//             리랭커 점수가 문턱을 넘은 것만 돌려준다. 못 넘으면 빈 결과 (원칙 II).
//             리랭커가 없으면 임베딩 문턱(절대값 + 1등 대비 차이)으로 떨어진다.
// ============================================================
import crypto from 'node:crypto';
import { Memory } from '../store.js';
import { chunk } from './chunkers.js';
import { getEmbedder, embedderError } from './embedder.js';
import { getReranker, rerankerError } from './reranker.js';
import { DEFAULT_RECALL, scoreAll, select } from './retrieve.js';

const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const keyOf = (type, text) => crypto.createHash('sha1').update(`${type}:${norm(text).toLowerCase()}`).digest('hex').slice(0, 16);

async function resolveEmbed(deps) {
  if ('embed' in deps) return deps.embed;             // 테스트: 가짜 임베더 또는 null(=없음)
  return getEmbedder();
}

/**
 * @param {object} p
 * @param {string} p.docId
 * @param {{id,text,box?}[]} [p.units]  원문 줄 (socraticRead 의 lines)
 * @param {string} [p.text]             또는 원문 텍스트
 * @param {string} [p.kind]             청킹 종류 강제 (없으면 판별)
 * @param {{text, quote, lines, verified}[]} [p.facts]  검증된 사실
 * @param {object} [p.source]           출처 (title · ocrEngine · ocrConfidence …)
 */
export async function remember({ docId, units, text, kind, facts = [], source = {}, _deps = {} } = {}) {
  const store = _deps.store || Memory;
  const embed = await resolveEmbed(_deps);
  const readAt = new Date().toISOString();
  const src = { ...source, readAt };

  const chunks = await chunk({ units, text, kind, embed: embed || undefined });
  const entries = chunks.map((c) => ({
    type: 'source', kind: c.kind, text: c.text, lines: c.lines, docId, source: src, key: keyOf('source', c.text),
  }));

  const rejected = [];
  for (const f of facts) {
    const quotes = [].concat(f.quote ?? []).map(norm).filter(Boolean);
    if (f.verified !== true || !quotes.length || !norm(f.text)) { rejected.push({ text: f.text, reason: f.verified !== true ? '검증되지 않음' : '인용 없음' }); continue; }
    entries.push({ type: 'fact', kind: 'fact', text: norm(f.text), quote: quotes, lines: f.lines || [], docId, source: src, key: keyOf('fact', f.text) });
  }

  if (embed && entries.length) {
    const vecs = await embed(entries.map((e) => `passage: ${e.text}`), 'passage');
    entries.forEach((e, i) => { e.embedding = vecs[i]; });
  }
  const added = store.add(entries);
  return {
    added: added.length,
    skipped: entries.length - added.length,
    rejected,
    chunks: chunks.map((c) => ({ kind: c.kind, lines: c.lines, chars: c.text.length })),
    embedded: !!embed,
    ...(embed ? {} : { note: `임베딩 없이 저장했습니다 (${embedderError() || '임베더 없음'}) — 검색은 글자 겹침만 씁니다.` }),
  };
}

/**
 * @returns {{ results: {id,type,kind,text,quote?,docId,lines,source,score,cos,overlap,rerank?}[], mode:'rerank'|'embedding'|'overlap', embedded:boolean, note?:string }}
 */
export async function recall({ query, k, types, cfg = {}, excludeDocId, _deps = {} } = {}) {
  const store = _deps.store || Memory;
  const q = norm(query);
  if (!q) return { results: [], mode: null, embedded: false };
  let entries = store.all();
  if (types?.length) entries = entries.filter((e) => types.includes(e.type));
  if (excludeDocId) entries = entries.filter((e) => e.docId !== excludeDocId);
  if (!entries.length) return { results: [], mode: null, embedded: false };

  const c = { ...DEFAULT_RECALL, ...cfg, ...(k ? { k } : {}) };
  const embed = await resolveEmbed(_deps);
  const qVec = embed ? (await embed([`query: ${q}`], 'query'))[0] : null;
  const scored = scoreAll(q, qVec, entries, c);
  const rerank = 'rerank' in _deps ? _deps.rerank : await getReranker();

  let picked;
  let mode;
  const notes = [];
  if (rerank) {
    const cands = scored.slice(0, c.candidates);
    const rs = await rerank(q, cands.map((x) => x.entry.text));
    picked = cands.map((x, i) => ({ ...x, rerank: rs[i] }))
      .sort((a, b) => b.rerank - a.rerank)
      .filter((x) => x.rerank >= c.minRerank)
      .slice(0, c.k);
    mode = 'rerank';
  } else {
    picked = select(scored, c);
    mode = qVec ? 'embedding' : 'overlap';
    notes.push(`리랭커 없이 ${qVec ? '임베딩 문턱' : '글자 겹침'}으로 찾았습니다 (${rerankerError() || '리랭커 없음'}) — 관련/무관 판정이 약합니다.`);
  }
  if (!qVec) notes.push(`임베딩 없이 글자 겹침으로 후보를 골랐습니다 (${embedderError() || '임베더 없음'}).`);
  const r3 = (v) => (v === null || v === undefined ? null : Number(v.toFixed(3)));
  return {
    results: picked.map(({ entry, score, cos, overlap, rerank: rr }) => ({
      id: entry.id, type: entry.type, kind: entry.kind, text: entry.text, quote: entry.quote,
      docId: entry.docId, lines: entry.lines, source: entry.source,
      score: r3(score), cos: r3(cos), overlap: r3(overlap), ...(rr !== undefined ? { rerank: r3(rr) } : {}),
    })),
    mode,
    embedded: !!qVec,
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}

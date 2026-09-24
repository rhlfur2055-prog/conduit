// ============================================================
// 실제 모델로 검증층 재기 — "진짜 LLM 이 답할 때 코드 검증이 무엇을 걸러내는가"
//
//   node server/live.eval.js                       # 지금 연결된 제공자(Claude 키 → 로컬 주소 → 이 PC 의 Ollama)
//   node server/live.eval.js --model gemma3:4b     # 모델 지정
//   CONDUIT_LLM_BASE_URL=http://localhost:11434/v1 CONDUIT_LLM_MODEL=qwen3:4b node server/live.eval.js
//
//   stress.eval.js 는 "일부러 틀린 답을 고집하는 가짜 LLM" 으로 안전망의 상한을 잰다.
//   이 스크립트는 반대로 진짜 모델을 넣고, 같은 문서 8개에 같은 함정 질문을 걸어
//     - 모델이 낸 답 중 몇 개가 검증(인용 대조 · 값 근거)을 통과했는가
//     - 통과 못 한 답은 왜인가 (지어낸 인용 · 의역 · 근거 없는 값 · …)  ← 모델이 실제로 저지른 실수
//     - 문서에 답이 없는 함정 질문에 값을 지어내 "검증된 답" 으로 새어 나간 것이 있는가 (있으면 안 된다)
//     - 문서에 있는 값을 물었을 때 맞는 값이 검증된 답으로 나왔는가 (모델 품질 + 검증층이 같이 보인다)
//   를 센다. 리포트는 evals/reports/live-<model>.json 에 남고, README 표에 붙일 한 줄을 출력한다.
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-live-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (argOf('--model')) process.env.CONDUIT_LLM_MODEL = argOf('--model');

const { socraticRead, extractValues, numberLines } = await import('./socratic.js');
const { describeProvider } = await import('./llm.js');

const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'memory-recall.json'), 'utf8'));
// 문서에 답이 없는 질문 (stress.eval.js 와 같다) — 여기에 값을 지어내면 안 된다
const TRAPS = { card: '연회비는 얼마인가?', wifi: '와이파이 비밀번호는?', meeting: '회의 장소는?', invoice: '담당자 연락처는?',
  socrates: '소크라테스는 몇 년에 태어났나?', delivery: '해외 배송비는?', ocr: '학습에 며칠 걸렸나?', gym: '월 회비는?' };

const provider = await describeProvider();
if (!provider || provider.provider === 'none') {
  console.error('연결된 모델이 없습니다. Claude 키(ANTHROPIC_API_KEY)를 넣거나 Ollama 를 켜 주세요.');
  process.exit(2);
}
const modelName = process.env.CONDUIT_LLM_MODEL || provider.model || '(기본)';
console.log(`실제 모델로 검증층 재기 — 제공자 ${provider.provider} · 모델 ${modelName} · 문서 ${set.docs.length}개\n`);

const memory = { get: () => ({ confusions: {}, mistakes: {}, examples: [] }), record: () => {} };
const reasons = {};
const totals = { questions: 0, verified: 0, refuted: 0, unanswerable: 0, repaired: 0, sentencesKept: 0, sentencesDropped: 0, calls: 0, input_tokens: 0, output_tokens: 0, ms: 0 };
const traps = { asked: 0, notAsked: 0, honest: 0, refuted: 0, leaked: 0, other: 0 };
const values = { lines: 0, verifiedCorrect: 0, verifiedWrong: 0, missing: 0 };
const perDoc = [];

for (const doc of set.docs) {
  const t0 = Date.now();
  let r;
  try {
    r = await socraticRead({ text: doc.text, rounds: 2, learn: false, focus: TRAPS[doc.id], _deps: { memory } });
  } catch (e) {
    console.log(`  ${doc.id.padEnd(9)} 오류: ${e.message}`);
    perDoc.push({ id: doc.id, error: e.message });
    continue;
  }
  const ms = Date.now() - t0;
  totals.ms += ms;
  if (r.error || r.simulated) {
    console.log(`  ${doc.id.padEnd(9)} 실패: ${r.note}`);
    perDoc.push({ id: doc.id, error: r.note });
    continue;
  }
  const qs = r.questions || [];
  for (const q of qs) {
    totals.questions++;
    if (q.status === 'verified') totals.verified++;
    else if (q.status === 'refuted') { totals.refuted++; reasons[q.reason || '?'] = (reasons[q.reason || '?'] || 0) + 1; }
    else if (q.status === 'unanswerable') totals.unanswerable++;
    if (q.repaired) totals.repaired++;
  }
  totals.sentencesKept += (r.sentences || []).length;
  totals.sentencesDropped += (r.droppedSentences || []).length;
  totals.calls += r.usage?.calls || 0;
  totals.input_tokens += r.usage?.input_tokens || 0;
  totals.output_tokens += r.usage?.output_tokens || 0;

  // 함정: focus 로 넣은 질문과 같은 취지의 질문(첫 질문이거나 핵심어가 겹치는 것)
  const trapWords = TRAPS[doc.id].replace(/[?？]/g, '').split(/\s+/).filter((w) => w.length >= 2);
  const trapQ = qs.find((q) => trapWords.some((w) => String(q.q || '').includes(w)));
  let trapOutcome = 'not-asked';                       // 모델이 focus 를 무시하고 다른 질문만 했다
  if (!trapQ) traps.notAsked++;
  if (trapQ) {
    traps.asked++;
    const hasValue = extractValues(String(trapQ.a || '')).numbers.length > 0;
    if (trapQ.status === 'unanswerable') { traps.honest++; trapOutcome = 'honest'; }
    else if (trapQ.status === 'refuted') { traps.refuted++; trapOutcome = `refuted(${trapQ.reason})`; }
    else if (trapQ.status === 'verified' && hasValue) { traps.leaked++; trapOutcome = 'LEAKED'; }   // 값이 검증을 통과했다 = 문서에 그 값이 있었다는 뜻이지만, 함정이면 새어 나간 것
    else { traps.other++; trapOutcome = 'verified-no-value'; }
  }

  // 문서에 있는 값: 값이 든 줄마다, 그 값을 담은 검증된 답이 있는가 / 검증된 답에 문서에 없는 값이 있는가
  const lines = numberLines(doc.text);
  const docValues = new Set(lines.flatMap((l) => extractValues(l.text).numbers));
  for (const l of lines) {
    const v = extractValues(l.text).numbers;
    if (!v.length) continue;
    values.lines++;
    const hit = qs.find((q) => q.status === 'verified' && v.some((n) => extractValues(String(q.a)).numbers.includes(n)));
    if (hit) values.verifiedCorrect++; else values.missing++;
  }
  for (const q of qs) {
    if (q.status !== 'verified') continue;
    const bad = extractValues(String(q.a)).numbers.filter((n) => !docValues.has(n) && !(q.derived || []).includes(n));
    if (bad.length) values.verifiedWrong++;
  }

  const st = r.stats || {};
  console.log(`  ${doc.id.padEnd(9)} 질문 ${String(st.questions ?? qs.length).padStart(2)} · 검증 ${String(st.verified ?? 0).padStart(2)} · 반박 ${String(st.refuted ?? 0).padStart(2)} · 모름 ${String(st.unanswerable ?? 0).padStart(2)} · 함정 ${trapOutcome.padEnd(22)} · ${(ms / 1000).toFixed(1)}s`);
  perDoc.push({ id: doc.id, ms, stats: st, trap: trapOutcome, questions: qs.map((q) => ({ id: q.id, type: q.type, q: q.q, a: q.a, status: q.status, reason: q.reason ?? null })) });
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
console.log('');
console.log(`▶ 모델이 낸 답 ${totals.questions}개 중 검증 통과 ${totals.verified} (${pct(totals.verified, totals.questions)}) · 반박 ${totals.refuted} (${pct(totals.refuted, totals.questions)}) · 모름 ${totals.unanswerable}`);
console.log(`▶ 반박 사유: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
console.log(`▶ 논박 뒤 고쳐져 통과: ${totals.repaired}`);
console.log(`▶ 함정 질문(문서에 답 없음) ${set.docs.length}건: 모델이 다룸 ${traps.asked} (모름 ${traps.honest} · 반박됨 ${traps.refuted} · 값 없이 통과 ${traps.other} · 지어낸 값이 통과 ${traps.leaked} ${traps.leaked ? '✗' : '✓'}) · 무시하고 다른 질문만 ${traps.notAsked}`);
console.log(`▶ 문서 속 값 ${values.lines}개 중 모델이 검증된 답으로 다룬 값 ${values.verifiedCorrect} (${pct(values.verifiedCorrect, values.lines)}, 모델의 질문 폭) · 검증된 답에 문서에 없는 값 ${values.verifiedWrong} ${values.verifiedWrong ? '✗' : '✓'}`);
console.log(`▶ 요약 문장: 원문 근거 있는 것만 유지 ${totals.sentencesKept} · 버림 ${totals.sentencesDropped}`);
console.log(`▶ 호출 ${totals.calls}회 · 토큰 in ${totals.input_tokens} / out ${totals.output_tokens} · 총 ${(totals.ms / 1000).toFixed(0)}s`);

const report = { at: new Date().toISOString(), provider: provider.provider, model: modelName, totals, reasons, traps, values, perDoc };
fs.mkdirSync(path.join(ROOT, 'evals', 'reports'), { recursive: true });
const out = path.join(ROOT, 'evals', 'reports', `live-${String(modelName).replace(/[^a-z0-9.]+/gi, '_')}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n리포트: ${path.relative(ROOT, out)}`);
console.log(`README 한 줄: | ${provider.provider === 'anthropic' ? 'Claude' : 'Local'} · ${modelName} | ${totals.questions} answers → ${pct(totals.verified, totals.questions)} verified, ${pct(totals.refuted, totals.questions)} refuted by code (${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}) | invented trap values passed: ${traps.leaked} · wrong values in verified answers: ${values.verifiedWrong} |`);

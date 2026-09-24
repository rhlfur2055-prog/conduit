// ============================================================
// 답의 값 근거 검증 평가 (specs/003-value-grounding · SC-001 SC-002)
//
//   node server/socratic.eval.js
//
//   evals/memory-recall.json 문서의 줄마다, 값(숫자·ID)이 든 줄로 (인용, 답) 쌍을 만든다.
//     맞는 답  : 원문 그대로 · 서술형으로 감싸기 · 쉼표 빼기/넣기 · 날짜 앞자리 0 빼기 · 영어 서수 · ID 대소문자
//     틀린 답  : 값 하나만 바꾼다 (+1 · ×10 · 끝자리 · ID 글자 하나)
//   재현율 = 틀린 답을 반박한 비율 (목표 ≥ 95%) · 오탐률 = 맞는 답을 반박한 비율 (목표 ≤ 5%)
//   "4,200만 원" 처럼 한국어 단위로 바꾼 맞는 답은 따로 센다 (만·억 을 풀어 비교한다).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractValues, groundValues } from './socratic.js';
import { splitSentences } from './memory/chunkers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'memory-recall.json'), 'utf8'));
const lines = [...new Set(set.docs.flatMap((d) => splitSentences(d.text)))].filter((l) => {
  const v = extractValues(l);
  return v.numbers.length + v.ids.length > 0;
});

const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const correct = [];
const wrong = [];
const unitTrap = [];

for (const line of lines) {
  const { numbers, ids } = extractValues(line);
  correct.push({ kind: '원문 그대로', line, a: line });
  correct.push({ kind: '서술형으로 감싸기', line, a: `문서에 따르면 ${[...numbers, ...ids].join(', ')} 이다` });
  if (/\d,\d/.test(line)) correct.push({ kind: '쉼표 빼기', line, a: line.replace(/(\d),(?=\d)/g, '$1') });
  if (/\d{4,}/.test(line.replace(/,/g, '')) && !/\d,\d/.test(line)) correct.push({ kind: '쉼표 넣기', line, a: line.replace(/\d{4,}/g, (m) => (m.length === 4 ? m : withCommas(m))) });
  if (/-0\d/.test(line)) correct.push({ kind: '날짜 앞자리 0 빼기', line, a: line.replace(/-0(\d)/g, '-$1') });
  for (const n of numbers) if (/^\d{1,2}$/.test(n)) correct.push({ kind: '영어 서수', line, a: `due on the ${n}th` });
  for (const id of ids) correct.push({ kind: 'ID 대소문자', line, a: `값은 ${id.toUpperCase()} 이다` });

  for (const n of numbers) {
    const num = Number(n);
    if (!Number.isFinite(num)) continue;
    const variants = [
      ['+1', String(num + 1)],
      ['×10', String(num * 10)],
      ['끝자리 바꿈', String(n).replace(/\d$/, (d) => String((Number(d) + 3) % 10))],
    ];
    for (const [kind, v] of variants) {
      if (v === n) continue;
      wrong.push({ kind: `숫자 ${kind}`, line, a: `답은 ${v} 이다`, bad: v });
    }
    if (num >= 10000 && num % 10000 === 0) unitTrap.push({ kind: '만 단위 표기', line, a: `${withCommas(num / 10000)}만 원` });
  }
  for (const id of ids) {
    // 원문 표기(대소문자)를 살려서 한 글자만 바꾼다 — 실제 틀린 답도 "XP" 처럼 원래 모양으로 나온다
    const at = line.normalize('NFKC').toLowerCase().indexOf(id);
    const orig = at >= 0 ? line.normalize('NFKC').slice(at, at + id.length) : id;
    const i = orig.search(/[a-z0-9]/i);
    const rep = /[A-Z]/.test(orig[i]) ? (orig[i] === 'X' ? 'Y' : 'X') : /[a-z]/.test(orig[i]) ? (orig[i] === 'x' ? 'y' : 'x') : String((Number(orig[i]) + 3) % 10);
    const swapped = orig.slice(0, i) + rep + orig.slice(i + 1);
    wrong.push({ kind: 'ID 글자 하나', line, a: `값은 ${swapped} 이다`, bad: swapped });
  }
}

const refuted = (x) => groundValues(x.a, x.line).missing.length > 0;
const rate = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : 0);
const pct = (v) => `${(100 * v).toFixed(1)}%`;
const byKind = (xs, f) => Object.entries(xs.reduce((m, x) => { (m[x.kind] ||= []).push(x); return m; }, {}))
  .map(([k, v]) => `${k} ${v.filter(f).length}/${v.length}`).join(' · ');

const recall = rate(wrong, refuted);
const fpr = rate(correct, refuted);
console.log(`값이 든 문서 줄 ${lines.length}개 → 맞는 답 ${correct.length} · 틀린 답 ${wrong.length}\n`);
console.log(`재현율 (틀린 값을 잡음)  ${pct(recall).padStart(6)}   목표 ≥ 95%   ${byKind(wrong, refuted)}`);
console.log(`오탐률 (맞는 답을 반박)  ${pct(fpr).padStart(6)}   목표 ≤ 5%    ${byKind(correct, refuted)}`);
console.log(`한국어 단위(만 원)로 쓴 맞는 답을 반박한 비율 ${pct(rate(unitTrap, refuted))} (${unitTrap.length}건)`);
const misses = [...wrong.filter((x) => !refuted(x)), ...correct.filter(refuted)];
if (misses.length) {
  console.log('\n틀린 판정:');
  for (const m of misses.slice(0, 15)) console.log(`  [${m.kind}] "${m.a}"  ← 원문 "${m.line}"`);
}
fs.mkdirSync(path.join(ROOT, 'evals', 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'evals', 'reports', 'value-grounding.json'), JSON.stringify({
  at: new Date().toISOString(), lines: lines.length, correct: correct.length, wrong: wrong.length, recall, falsePositiveRate: fpr,
  unitTrapRefuted: rate(unitTrap, refuted), misses,
}, null, 2));

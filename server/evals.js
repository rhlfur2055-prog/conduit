// ============================================================
// AI 노드 평가(evals) — 같은 노드 설정을 입력 N개에 돌려 통과율을 잰다.
//
//   node server/evals.js evals/customer-inquiry.json [--runs 2] [--baseline evals/reports/prev.json] [--dry-run]
//
// 프롬프트를 바꿨을 때 "느낌"이 아니라 통과율과 회귀 목록으로 비교하기 위한 도구다.
// 평가 파일 형식은 evals/customer-inquiry.json 참고.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_TYPES } from '../src/engine/nodeTypes.ts';
import { resolveParams } from '../src/engine/expr.ts';
import { getPath, stableKey } from '../src/engine/items.ts';

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const same = (a, b) => stableKey(a) === stableKey(b);
const show = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));

/**
 * 검사 하나를 출력 아이템에 적용한다. 실패 이유 배열을 돌려주며, 비어 있으면 통과.
 * 검사 객체: { path, equals | oneOf | contains | notContains | regex | maxChars | type | hasKeys | defined }
 * 한 객체에 여러 조건을 넣으면 전부 만족해야 한다.
 */
export function evaluateCheck(check, output) {
  const where = check.path || '(출력)';
  const value = check.path ? getPath(output, check.path) : output;
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
  const fails = [];

  if ('defined' in check && (value !== undefined) !== check.defined) fails.push(`${where}: ${check.defined ? '값이 없음' : '값이 있으면 안 됨'}`);
  if ('equals' in check && !same(value, check.equals)) fails.push(`${where}: ${show(value)} ≠ ${show(check.equals)}`);
  if ('oneOf' in check && !check.oneOf.some((v) => same(v, value))) fails.push(`${where}: ${show(value)} ∉ ${show(check.oneOf)}`);
  if ('contains' in check && !text.includes(check.contains)) fails.push(`${where}: "${check.contains}" 없음`);
  if ('notContains' in check && text.includes(check.notContains)) fails.push(`${where}: "${check.notContains}" 포함됨`);
  if ('regex' in check && !new RegExp(check.regex, check.flags || '').test(text)) fails.push(`${where}: /${check.regex}/ 불일치`);
  if ('maxChars' in check && text.length > check.maxChars) fails.push(`${where}: ${text.length}자 > ${check.maxChars}자`);
  if ('type' in check && typeOf(value) !== check.type) fails.push(`${where}: 타입 ${typeOf(value)} ≠ ${check.type}`);
  if ('hasKeys' in check) {
    const missing = (value && typeof value === 'object') ? check.hasKeys.filter((k) => !(k in value)) : check.hasKeys;
    if (missing.length) fails.push(`${where}: 키 없음 ${missing.join(', ')}`);
  }
  return fails;
}

/** 동시 실행 상한이 있는 작업 풀 */
async function runPool(jobs, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, async () => {
    while (next < jobs.length) {
      const j = next++;
      await worker(jobs[j], j);
    }
  });
  await Promise.all(lanes);
}

/**
 * 평가 파일의 dryRun 규칙으로 가짜 LLM 을 만든다 — API 키 없이 실행기와 리포트를 확인하는 용도.
 * 입력에 keywords 중 하나라도 있으면 그 규칙의 output 을 병합한다(뒤 규칙이 앞 규칙을 덮음).
 * aiExtract 프롬프트는 "지시문\n\n입력:\n{...}" 꼴이라 지시문에도 카테고리 이름이 들어 있다 —
 * 그래서 마지막 "입력:" 뒤만 본다. 그 표식이 없으면(ai 노드 등) 프롬프트 전체를 본다.
 */
export function buildDryRunLLM(dryRun = {}) {
  return async ({ prompt }) => {
    const p = String(prompt || '');
    const at = p.lastIndexOf('입력:\n');
    const hay = at >= 0 ? p.slice(at + '입력:\n'.length) : p;
    const out = { ...(dryRun.defaults || {}) };
    for (const rule of dryRun.rules || []) {
      if ((rule.keywords || []).some((k) => hay.includes(k))) Object.assign(out, rule.output || {});
    }
    return { text: JSON.stringify(out), simulated: false, dryRun: true };
  };
}

/**
 * @param {object} suite  { name, node: { kind, params }, checks?: [], cases: [{ name?, input, checks }] }
 * @param {object} [opts] { runs, concurrency, llm, onCase }
 */
export async function runEvalSuite(suite, { runs = 1, concurrency = 4, llm, onCase } = {}) {
  const def = NODE_TYPES[suite.node?.kind];
  if (!def) throw new Error(`알 수 없는 노드 종류: ${suite.node?.kind}`);
  if (!Array.isArray(suite.cases) || !suite.cases.length) throw new Error('cases 가 비어 있습니다');
  const params = { ...def.defaults, ...(suite.node.params || {}) };
  const common = suite.checks || [];

  const prevLLM = globalThis.__conduitLLM;
  if (llm) globalThis.__conduitLLM = llm;
  const startedAt = Date.now();
  const jobs = [];
  suite.cases.forEach((c, idx) => { for (let r = 0; r < runs; r++) jobs.push({ idx, r, c }); });
  const results = new Array(jobs.length);
  const usage = { input: 0, output: 0 };
  let simulated = 0;

  try {
    await runPool(jobs, concurrency, async (job, j) => {
      const input = job.c.input;
      const ctx = { $json: input, $items: [input], $index: 0, $now: new Date().toISOString() };
      const t = Date.now();
      let output;
      let error;
      try {
        output = (await def.run({ main: input }, resolveParams(params, ctx), ctx))?.main;
      } catch (e) {
        error = e.message;
      }
      const ms = Date.now() - t;
      if (output?._ai?.simulated) simulated++;
      if (output?._ai?.usage) {
        usage.input += Number(output._ai.usage.input_tokens) || 0;
        usage.output += Number(output._ai.usage.output_tokens) || 0;
      }
      const checks = [...common, ...(job.c.checks || [])];
      const fails = error ? [`실행 오류: ${error}`] : checks.flatMap((ch) => evaluateCheck(ch, output));
      results[j] = { case: job.idx, run: job.r, name: job.c.name || `#${job.idx + 1}`, pass: fails.length === 0, ms, fails, output };
      onCase?.(results[j]);
    });
  } finally {
    globalThis.__conduitLLM = prevLLM;
  }

  const cases = suite.cases.map((c, idx) => {
    const rs = results.filter((r) => r.case === idx);
    const passed = rs.filter((r) => r.pass).length;
    return {
      name: c.name || `#${idx + 1}`,
      input: c.input,
      passed, runs: rs.length,
      pass: passed === rs.length,
      ms: Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length),
      fails: [...new Set(rs.flatMap((r) => r.fails))].slice(0, 5),
      output: rs[0]?.output,
    };
  });
  const passedCases = cases.filter((c) => c.pass).length;
  return {
    suite: suite.name || '(이름 없음)',
    node: { kind: suite.node.kind, model: params.model },
    at: new Date().toISOString(),
    runs, durationMs: Date.now() - startedAt, simulated, usage,
    total: cases.length, passed: passedCases,
    passRate: passedCases / cases.length,
    cases,
  };
}

/** 두 리포트를 비교 — 기준에서 통과했는데 지금 실패한 케이스(회귀)와 그 반대(개선) */
export function diffReports(baseline, current) {
  const base = new Map((baseline.cases || []).map((c) => [c.name, c.pass]));
  const regressions = current.cases.filter((c) => base.get(c.name) === true && !c.pass).map((c) => c.name);
  const fixes = current.cases.filter((c) => base.get(c.name) === false && c.pass).map((c) => c.name);
  return { baselineRate: baseline.passRate, currentRate: current.passRate, delta: current.passed - (baseline.passed || 0), regressions, fixes };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');

/** 사람이 읽는 리포트 */
export function formatReport(report, diff) {
  const lines = [];
  lines.push(`평가: ${report.suite} · 노드 ${report.node.kind} · 모델 ${report.node.model || '-'} · 케이스 ${report.total}${report.runs > 1 ? ` × ${report.runs}회` : ''}`);
  lines.push('');
  for (const [i, c] of report.cases.entries()) {
    const mark = c.pass ? '✔' : '✖';
    const runsNote = report.runs > 1 ? ` (${c.passed}/${c.runs})` : '';
    lines.push(`${String(i + 1).padStart(2)}  ${mark}  ${c.name}${runsNote}`);
    for (const f of c.fails) lines.push(`        - ${f}`);
  }
  lines.push('');
  const avg = Math.round(report.cases.reduce((a, c) => a + c.ms, 0) / report.cases.length);
  const tokens = report.usage.input || report.usage.output ? `토큰 입력 ${fmtN(report.usage.input)} / 출력 ${fmtN(report.usage.output)}` : '토큰 -';
  lines.push(`통과 ${report.passed}/${report.total} (${pct(report.passRate)}) · 평균 ${avg}ms/케이스 · ${tokens}`);
  if (report.simulated) lines.push(`⚠ 시뮬레이션 응답 ${report.simulated}건 — API 키가 없어 실제 모델을 부르지 않았습니다. 이 결과는 의미가 없습니다.`);
  if (diff) {
    const sign = diff.delta > 0 ? '+' : '';
    lines.push(`기준 대비: ${sign}${diff.delta} (${pct(diff.baselineRate)} → ${pct(diff.currentRate)})`);
    if (diff.regressions.length) lines.push(`  회귀 ${diff.regressions.length}: ${diff.regressions.join(', ')}`);
    if (diff.fixes.length) lines.push(`  개선 ${diff.fixes.length}: ${diff.fixes.join(', ')}`);
    if (!diff.regressions.length && !diff.fixes.length) lines.push('  바뀐 케이스 없음');
  }
  return lines.join('\n');
}

/* ---------- CLI ---------- */
async function cli(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const runs = Number(flag('--runs')) || 1;
  const concurrency = Number(flag('--concurrency')) || 4;
  const baselinePath = flag('--baseline');
  const outPath = flag('--out');
  const dryRun = has('--dry-run');
  const file = args[0];
  if (!file) {
    console.error('사용법: node server/evals.js <평가파일.json> [--runs N] [--baseline 리포트.json] [--out 리포트.json] [--dry-run]');
    process.exit(2);
  }
  const suite = JSON.parse(fs.readFileSync(file, 'utf8'));

  let llm;
  if (dryRun) {
    llm = buildDryRunLLM(suite.dryRun);
    console.error('dry-run: 평가 파일의 dryRun 규칙으로 만든 가짜 LLM 을 씁니다 (실행기·리포트 확인용, 모델 품질과 무관)');
  } else {
    const { callLLM, getProvider } = await import('./llm.js');
    if (!(await getProvider())) {
      console.error('연결된 모델이 없어 실제 평가를 실행할 수 없습니다. ANTHROPIC_API_KEY 를 설정하거나 Ollama 를 켜거나, --dry-run 으로 실행기만 확인하세요.');
      process.exit(2);
    }
    llm = callLLM;
  }

  const report = await runEvalSuite(suite, {
    runs, concurrency, llm,
    onCase: (r) => process.stderr.write(r.pass ? '.' : 'x'),
  });
  process.stderr.write('\n');
  if (dryRun) report.dryRun = true;

  const diff = baselinePath ? diffReports(JSON.parse(fs.readFileSync(baselinePath, 'utf8')), report) : undefined;
  console.log(formatReport(report, diff));

  const slug = String(suite.name || path.basename(file, '.json')).replace(/[^\w가-힣-]+/g, '-');
  const out = outPath || path.join('evals', 'reports', `${slug}-${report.at.replace(/[:.]/g, '-')}${dryRun ? '-dryrun' : ''}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n리포트 저장: ${out}${baselinePath ? '' : '  (다음 실행에 --baseline 으로 넘기면 회귀를 잡아 줍니다)'}`);
  process.exit(report.passed === report.total ? 0 : 1);
}

if (isMain) cli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(2); });

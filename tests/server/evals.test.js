import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCheck, runEvalSuite, diffReports, formatReport, buildDryRunLLM } from '../../server/evals.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('evaluateCheck — 검사 규칙', () => {
  const out = { aiText: '배송은 내일 도착합니다', extracted: { category: '배송', urgent: false, tags: ['a'] } };

  it('equals / oneOf 는 값을 깊게 비교한다', () => {
    expect(evaluateCheck({ path: 'extracted.category', equals: '배송' }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'extracted.urgent', equals: false }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'extracted.tags', equals: ['a'] }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'extracted.category', equals: '환불' }, out)).toEqual(['extracted.category: "배송" ≠ "환불"']);
    expect(evaluateCheck({ path: 'extracted.category', oneOf: ['배송', '환불'] }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'extracted.category', oneOf: ['결제'] }, out)[0]).toMatch(/∉/);
  });

  it('contains / notContains / regex / maxChars 는 문자열(객체는 JSON)에 적용', () => {
    expect(evaluateCheck({ path: 'aiText', contains: '내일' }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'aiText', contains: '오늘' }, out)).toEqual(['aiText: "오늘" 없음']);
    expect(evaluateCheck({ path: 'aiText', notContains: '죄송' }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'aiText', regex: '도착합니다$' }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'aiText', maxChars: 5 }, out)[0]).toMatch(/자 > 5자/);
    expect(evaluateCheck({ path: 'extracted', contains: '"category":"배송"' }, out)).toEqual([]);
  });

  it('type / hasKeys / defined', () => {
    expect(evaluateCheck({ path: 'extracted', type: 'object', hasKeys: ['category', 'urgent'] }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'extracted', hasKeys: ['category', 'nope'] }, out)).toEqual(['extracted: 키 없음 nope']);
    expect(evaluateCheck({ path: 'extracted.tags', type: 'array' }, out)).toEqual([]);
    expect(evaluateCheck({ path: 'extracted.urgent', type: 'string' }, out)).toEqual(['extracted.urgent: 타입 boolean ≠ string']);
    expect(evaluateCheck({ path: 'extracted.missing', defined: true }, out)).toEqual(['extracted.missing: 값이 없음']);
    expect(evaluateCheck({ path: 'extracted.missing', defined: false }, out)).toEqual([]);
  });

  it('한 객체의 여러 조건은 전부 만족해야 한다', () => {
    const fails = evaluateCheck({ path: 'aiText', contains: '배송', maxChars: 3, regex: '^X' }, out);
    expect(fails).toHaveLength(2);
  });
});

// 프롬프트 안의 입력 텍스트를 보고 답을 정하는 가짜 LLM (aiExtract 프롬프트는 "입력:\n{...}" 로 끝난다)
const fakeLLM = (rulesFn) => async ({ prompt }) => ({ text: JSON.stringify(rulesFn(prompt)), usage: { input_tokens: 10, output_tokens: 2 } });

const suite = {
  name: '미니',
  node: { kind: 'aiExtract', params: { instruction: '분류', target: 'r' } },
  checks: [{ path: 'r', type: 'object', hasKeys: ['category'] }],
  cases: [
    { name: 'A', input: { text: '배송 언제 와요' }, checks: [{ path: 'r.category', equals: '배송' }] },
    { name: 'B', input: { text: '환불해 주세요' }, checks: [{ path: 'r.category', equals: '환불' }] },
    { name: 'C', input: { text: '색상 문의' }, checks: [{ path: 'r.category', equals: '상품문의' }] },
  ],
};

describe('runEvalSuite — 실행기', () => {
  it('케이스별 통과 여부·실패 이유·통과율·토큰 합계', async () => {
    const llm = fakeLLM((p) => ({ category: p.includes('배송') ? '배송' : '환불' })); // C 는 틀린다
    const seen = [];
    const report = await runEvalSuite(suite, { llm, onCase: (r) => seen.push(r.name) });
    expect(report.total).toBe(3);
    expect(report.passed).toBe(2);
    expect(report.passRate).toBeCloseTo(2 / 3);
    expect(report.cases.map((c) => c.pass)).toEqual([true, true, false]);
    expect(report.cases[2].fails).toEqual(['r.category: "환불" ≠ "상품문의"']);
    expect(report.usage).toEqual({ input: 30, output: 6 });
    expect(report.simulated).toBe(0);
    expect(seen.sort()).toEqual(['A', 'B', 'C']);
    expect(report.node).toEqual({ kind: 'aiExtract', model: 'claude-sonnet-5' });
  });

  it('runs 를 늘리면 케이스마다 여러 번 돌려 일관성을 본다', async () => {
    let n = 0;
    const llm = fakeLLM(() => ({ category: n++ % 2 === 0 ? '배송' : '환불' })); // 번갈아 답한다
    const report = await runEvalSuite({ ...suite, cases: [suite.cases[0]] }, { llm, runs: 4, concurrency: 1 });
    expect(report.cases[0]).toMatchObject({ runs: 4, passed: 2, pass: false });
  });

  it('LLM 이 JSON 이 아닌 답을 내면 구조 검사(hasKeys)에서 걸린다', async () => {
    const llm = async () => ({ text: '죄송합니다, 분류할 수 없습니다.' });
    const report = await runEvalSuite(suite, { llm });
    expect(report.passed).toBe(0);
    // aiExtract 는 파싱 실패 시 { raw: 원문 } 으로 감싸므로 type:object 는 통과하고, 키 검사와 값 검사에서 걸린다
    expect(report.cases[0].fails).toEqual(['r: 키 없음 category', 'r.category: undefined ≠ "배송"']);
  });

  it('시뮬레이션 응답은 세어서 리포트에 남긴다', async () => {
    const llm = async () => ({ text: '〔시뮬레이션〕', simulated: true });
    const report = await runEvalSuite(suite, { llm });
    expect(report.simulated).toBe(3);
    expect(formatReport(report)).toMatch(/시뮬레이션 응답 3건/);
  });

  it('노드 실행이 예외를 던지면 실행 오류로 기록한다', async () => {
    const llm = async () => { throw new Error('boom'); };
    const report = await runEvalSuite(suite, { llm });
    expect(report.cases.every((c) => c.fails[0] === '실행 오류: boom')).toBe(true);
  });

  it('원래 LLM 브리지를 되돌린다', async () => {
    globalThis.__conduitLLM = 'original';
    await runEvalSuite(suite, { llm: fakeLLM(() => ({})) });
    expect(globalThis.__conduitLLM).toBe('original');
    delete globalThis.__conduitLLM;
  });

  it('모르는 노드·빈 케이스는 바로 거부', async () => {
    await expect(runEvalSuite({ node: { kind: 'nope' }, cases: [{}] })).rejects.toThrow(/알 수 없는 노드/);
    await expect(runEvalSuite({ node: { kind: 'ai' }, cases: [] })).rejects.toThrow(/cases/);
  });
});

describe('diffReports / formatReport', () => {
  it('회귀와 개선을 케이스 이름으로 짚어 준다', () => {
    const mk = (passes) => ({ passed: passes.filter(Boolean).length, passRate: passes.filter(Boolean).length / passes.length, cases: passes.map((p, i) => ({ name: `c${i}`, pass: p, fails: [], ms: 1 })) });
    const d = diffReports(mk([true, true, false]), mk([true, false, true]));
    expect(d).toMatchObject({ delta: 0, regressions: ['c1'], fixes: ['c2'] });
    const text = formatReport({ ...mk([true, false, true]), suite: 'S', node: { kind: 'ai' }, runs: 1, total: 3, usage: {}, simulated: 0 }, d);
    expect(text).toMatch(/통과 2\/3 \(67%\)/);
    expect(text).toMatch(/회귀 1: c1/);
    expect(text).toMatch(/개선 1: c2/);
  });
});

describe('샘플 평가 파일 (evals/customer-inquiry.json) + dry-run 가짜 LLM', () => {
  const file = path.join(here, '..', '..', 'evals', 'customer-inquiry.json');
  const sample = JSON.parse(fs.readFileSync(file, 'utf8'));

  it('케이스 20개, 모든 케이스에 category·urgent 검사가 있다', () => {
    expect(sample.cases).toHaveLength(20);
    for (const c of sample.cases) {
      expect(c.input.text).toBeTruthy();
      expect(c.checks.map((ch) => ch.path).sort()).toEqual(['extracted.category', 'extracted.urgent']);
    }
  });

  it('dry-run 규칙은 키워드에 따라 병합된 JSON 을 낸다', async () => {
    const llm = buildDryRunLLM(sample.dryRun);
    const r = await llm({ prompt: '배송·환불·교환 중 하나로 분류하라. 급하면 당장 표시.\n\n입력:\n{"text":"배송지를 잘못 입력했어요. 빨리요!"}' });
    expect(JSON.parse(r.text)).toEqual({ category: '배송', urgent: true });
    // 지시문에 든 카테고리 이름("환불", "당장")은 무시하고 입력만 본다
    expect(JSON.parse((await llm({ prompt: '배송·환불 분류, 급하면 당장.\n\n입력:\n{"text":"회원 탈퇴하고 싶어요"}' })).text)).toEqual({ category: '기타', urgent: false });
    // "입력:" 표식이 없으면 프롬프트 전체를 본다
    expect(JSON.parse((await llm({ prompt: '쿠폰이 안 돼요' })).text)).toEqual({ category: '결제', urgent: false });
  });

  it('dry-run 으로 전체 20건이 돌아가고 리포트 구조가 맞는다', async () => {
    const report = await runEvalSuite(sample, { llm: buildDryRunLLM(sample.dryRun) });
    expect(report.total).toBe(20);
    expect(report.passed).toBeGreaterThan(10);
    expect(report.passed).toBeLessThanOrEqual(20);
    expect(report.simulated).toBe(0);
    for (const c of report.cases) expect(typeof c.output.extracted).toBe('object');
    expect(formatReport(report)).toMatch(/통과 \d+\/20/);
  });
});

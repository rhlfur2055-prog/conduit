// 소크라테스식 읽기 — 검증기(결정론)와 논박·학습 루프.
// LLM 은 각본대로 답하는 가짜로 바꾼다. 검증은 모델 밖 코드가 하므로 여기서 100% 고정된다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-socratic-'));

const {
  matchKey, similarity, substitutions, numberLines, verifyEvidence, verifyQuestion,
  acceptCorrections, checkSentences, lessonsText, socraticRead,
} = await import('../../server/socratic.js');

const DOC = [
  '신한카드 결제일은 매월 14일입니다.',
  '결제일 3일 전까지 계좌에 잔액을 채워 주세요.',
  '잔액이 부족하면 연체 이자가 붙습니다.',
].join('\n');
const LINES = numberLines(DOC);

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** 각본대로 답하는 가짜 LLM — 호출된 인자도 기록한다 */
function scriptedLLM(replies) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    const next = replies.shift();
    if (next === undefined) throw new Error('각본에 없는 호출');
    return typeof next === 'string' ? { text: next, usage: { input_tokens: 10, output_tokens: 5 } } : next;
  };
  fn.calls = calls;
  return fn;
}

/** 메모리 가짜 — 파일 대신 객체 */
function fakeMemory(initial) {
  let m = initial || { confusions: {}, mistakes: {}, examples: [], runs: 0 };
  return {
    get: () => m,
    record({ confusions = [], mistakes = [] }) {
      for (const c of confusions) m.confusions[`${c.from}→${c.to}`] = (m.confusions[`${c.from}→${c.to}`] || 0) + 1;
      for (const x of mistakes) {
        m.mistakes[x.kind] = (m.mistakes[x.kind] || 0) + 1;
        m.examples.unshift({ kind: x.kind, quote: x.quote });
      }
      m.runs++;
      return m;
    },
    get snapshot() { return m; },
  };
}

describe('matchKey · similarity · substitutions', () => {
  it('tesseract 가 한글 사이에 끼운 공백과 따옴표는 무시한다', () => {
    expect(matchKey('결 제 일 은 “매월”')).toBe(matchKey('결제일은 매월'));
  });
  it('유니코드 정규화(NFD 로 들어온 한글)도 같은 글자로 본다', () => {
    expect(matchKey('한'.normalize('NFD'))).toBe(matchKey('한'));
  });
  it('유사도는 0~1', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abcd', 'abxd')).toBe(0.75);
  });
  it('글자 치환만 뽑는다 — 신하카드 → 신한카드 는 하→한', () => {
    expect(substitutions('신하카드', '신한카드')).toEqual([{ from: '하', to: '한' }]);
  });
  it('삽입·삭제는 오인식 쌍이 아니다', () => {
    expect(substitutions('결제일', '결제일은')).toEqual([]);
  });
});

describe('verifyEvidence — 인용이 원문에 글자 그대로 있는가', () => {
  it('말한 줄에 있으면 통과', () => {
    expect(verifyEvidence({ line: 'L1', quote: '매월 14일' }, LINES)).toEqual({ ok: true, line: 'L1' });
  });
  it('인용은 진짜인데 줄 번호가 틀리면 바로잡아 통과시키되 실수로 표시', () => {
    const r = verifyEvidence({ line: 'L1', quote: '연체 이자가 붙습니다' }, LINES);
    expect(r).toMatchObject({ ok: true, kind: 'wrong_line', line: 'L3', claimedLine: 'L1' });
  });
  it('줄바꿈을 넘어가는 인용도 찾는다', () => {
    const r = verifyEvidence({ line: 'L1', quote: '14일입니다. 결제일 3일 전까지' }, LINES);
    expect(r).toMatchObject({ ok: true, kind: 'spans', line: 'L1' });
  });
  it('의역은 거부 — 원문과 비슷하지만 같지 않다', () => {
    const r = verifyEvidence({ line: 'L3', quote: '잔액이 모자라면 연체 이자가 붙습니다' }, LINES);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('paraphrased');
  });
  it('지어낸 인용은 거부', () => {
    const r = verifyEvidence({ line: 'L2', quote: '연회비는 무료입니다' }, LINES);
    expect(r).toMatchObject({ ok: false, kind: 'fabricated' });
  });
  it('한 글자짜리 인용은 근거가 아니다', () => {
    expect(verifyEvidence({ line: 'L1', quote: '일' }, LINES).kind).toBe('too_short');
  });
});

describe('verifyQuestion', () => {
  it('근거가 하나라도 가짜면 전체가 반박된다', () => {
    const q = verifyQuestion({ id: 'Q1', a: 'x', evidence: [{ line: 'L1', quote: '매월 14일' }, { line: 'L2', quote: '없는 말' }] }, LINES);
    expect(q.status).toBe('refuted');
  });
  it('근거 없는 답은 반박', () => {
    expect(verifyQuestion({ id: 'Q1', a: 'x', evidence: [] }, LINES)).toMatchObject({ status: 'refuted', reason: 'no_evidence' });
  });
  it('answerable:false 는 반박이 아니라 "원문에 없음" 으로 남는다', () => {
    expect(verifyQuestion({ id: 'Q1', answerable: false, a: '연회비 정보 없음' }, LINES).status).toBe('unanswerable');
  });
});

describe('acceptCorrections — 글자 교정은 받고, 재작성은 거부', () => {
  const ocrLines = numberLines(['신하카드 결제일은 매월 14일입니다.', '결제일 3일 전까지']);
  it('한 글자 교정을 받아들이고 오인식 쌍을 남긴다', () => {
    const r = acceptCorrections(ocrLines, [{ id: 'L1', text: '신한카드 결제일은 매월 14일입니다.' }]);
    expect(r.lines[0]).toMatchObject({ text: '신한카드 결제일은 매월 14일입니다.', source: 'corrected', ocrText: '신하카드 결제일은 매월 14일입니다.' });
    expect(r.confusions).toEqual([{ from: '하', to: '한' }]);
  });
  it('원문과 절반 넘게 다른 "교정" 은 모델의 재작성으로 보고 거부한다', () => {
    const r = acceptCorrections(ocrLines, [{ id: 'L2', text: '카드 대금은 자동이체로 빠져나갑니다' }]);
    expect(r.lines[1]).toMatchObject({ text: '결제일 3일 전까지', source: 'ocr' });
    expect(r.rejected).toHaveLength(1);
    expect(r.confusions).toEqual([]);
  });
});

describe('checkSentences — 요약 문장은 검증된 줄만 근거로 삼는다', () => {
  it('태그 없는 문장, 검증 안 된 줄을 인용한 문장은 버린다', () => {
    const r = checkSentences(['결제일은 14일이다 [L1]', '연회비는 무료다', '잔액이 모자라면 이자 [L3]', '둘 다 [L1, L2]'], new Set(['L1', 'L2']));
    expect(r.kept).toEqual(['결제일은 14일이다 [L1]', '둘 다 [L1, L2]']);
    expect(r.dropped.map((d) => d.reason)).toEqual(['근거 줄 표시 없음', '검증되지 않은 줄 인용: L3']);
  });
});

describe('lessonsText — 배운 것을 프롬프트로', () => {
  it('빈 기억이면 아무것도 넣지 않는다', () => {
    expect(lessonsText({ confusions: {}, mistakes: {}, examples: [] })).toEqual({ glyph: '', reading: '' });
  });
  it('많이 틀린 순서로 넣는다', () => {
    const t = lessonsText({ confusions: { '라→나': 5, '0→o': 1 }, mistakes: { paraphrased: 3 }, examples: [{ kind: 'paraphrased', quote: '잔액이 모자라면' }] });
    expect(t.glyph).toMatch(/라→나\(5\), 0→o\(1\)/);
    expect(t.reading).toMatch(/인용을 의역함 3회/);
    expect(t.reading).toMatch(/잔액이 모자라면/);
  });
});

/* ---------- 전체 루프 ---------- */

const prover = JSON.stringify({
  questions: [
    { id: 'Q1', type: 'claim', q: '핵심은?', a: '결제일은 14일', evidence: [{ line: 'L1', quote: '결제일은 매월 14일입니다' }] },
    { id: 'Q2', type: 'evidence', q: '연체 조건은?', a: '잔액 부족', evidence: [{ line: 'L3', quote: '잔액이 모자라면 연체 이자가 붙습니다' }] },   // 의역 → 반박
    { id: 'Q3', type: 'definition', q: '연회비는?', a: '없음', answerable: false },
  ],
});
const repair = JSON.stringify({
  questions: [{ id: 'Q2', type: 'evidence', q: '연체 조건은?', a: '잔액 부족', evidence: [{ line: 'L3', quote: '잔액이 부족하면 연체 이자가 붙습니다' }] }],
});
const synth = JSON.stringify({ sentences: ['결제일은 매월 14일이다 [L1]', '잔액이 부족하면 연체 이자가 붙는다 [L3]', '연회비는 무료다 [L9]'] });

describe('socraticRead — 질문 → 검증 → 논박 → 종합 → 학습', () => {
  it('반박된 답은 논박 라운드에서 원문 인용으로 고쳐지고, 근거 없는 요약 문장은 버려진다', async () => {
    const llm = scriptedLLM([prover, repair, synth]);
    const memory = fakeMemory();
    const r = await socraticRead({ text: DOC, rounds: 2, _deps: { llm, memory } });

    expect(r.simulated).toBe(false);
    expect(r.questions.find((q) => q.id === 'Q2')).toMatchObject({ status: 'verified', repaired: true });
    expect(r.stats).toMatchObject({ questions: 3, verified: 2, repaired: 1, refuted: 0, unanswerable: 1, groundedRatio: 1, firstPassMistakes: 1 });
    expect(r.unanswered).toEqual([{ id: 'Q3', q: '연회비는?', missing: '없음' }]);
    expect(r.sentences).toEqual(['결제일은 매월 14일이다 [L1]', '잔액이 부족하면 연체 이자가 붙는다 [L3]']);
    expect(r.droppedSentences[0].reason).toMatch(/L9/);

    // 논박 프롬프트가 무엇이 틀렸는지 구체적으로 말한다
    expect(llm.calls[1].prompt).toMatch(/Q2.*의역/s);
    // 학습: 첫 답의 의역 실수가 기억에 남는다
    expect(memory.snapshot.mistakes).toEqual({ paraphrased: 1 });
  });

  it('논박 라운드가 1이면 다시 묻지 않고 반박된 채로 남는다', async () => {
    const llm = scriptedLLM([prover, synth]);
    const r = await socraticRead({ text: DOC, rounds: 1, learn: false, _deps: { llm, memory: fakeMemory() } });
    expect(r.questions.find((q) => q.id === 'Q2').status).toBe('refuted');
    expect(r.stats.groundedRatio).toBe(0.5);
    expect(llm.calls).toHaveLength(2);
    expect(r.learned).toBeNull();
  });

  it('배운 실수는 다음 읽기의 시스템 프롬프트에 들어간다', async () => {
    const memory = fakeMemory({ confusions: {}, mistakes: { fabricated: 2 }, examples: [{ kind: 'fabricated', quote: '연회비는 무료' }], runs: 1 });
    const llm = scriptedLLM([prover, synth]);
    await socraticRead({ text: DOC, rounds: 1, _deps: { llm, memory } });
    expect(llm.calls[0].system).toMatch(/원문에 없는 인용을 지어냄 2회/);
    expect(llm.calls[0].system).toMatch(/연회비는 무료/);
  });

  it('이미지: 글자 확정 단계가 OCR 오인식을 고치고, 그 쌍을 배운다', async () => {
    const fakeOcr = async () => ({ text: '', lines: [{ text: '신하카드 결제일은 매월 14일입니다.', box: { y: 10 } }], confidence: 71, simulated: false });
    const glyph = JSON.stringify({ lines: [{ id: 'L1', text: '신한카드 결제일은 매월 14일입니다.' }], added: ['고객센터 1544-7000'] });
    const p = JSON.stringify({ questions: [{ id: 'Q1', type: 'claim', q: '핵심?', a: '14일', evidence: [{ line: 'L1', quote: '신한카드 결제일은' }] }] });
    const s = JSON.stringify({ sentences: ['신한카드 결제일은 14일이다 [L1]'] });
    const llm = scriptedLLM([glyph, p, s]);
    const memory = fakeMemory();
    const r = await socraticRead({ image: PNG, _deps: { llm, ocr: fakeOcr, memory } });

    expect(r.lines[0]).toMatchObject({ id: 'L1', text: '신한카드 결제일은 매월 14일입니다.', source: 'corrected', y: 10 });
    expect(r.lines[1]).toMatchObject({ id: 'V1', source: 'vision' });
    expect(r.uncertain.map((u) => u.line)).toEqual(['V1']);
    expect(r.stats.verified).toBe(1);
    expect(memory.snapshot.confusions).toEqual({ '하→한': 1 });
    // 글자 확정 호출에는 이미지가 들어간다
    expect(llm.calls[0].messages[0].content[0].type).toBe('image');
  });

  it('API 키가 없으면(시뮬레이션) 원문 줄은 그대로 돌려준다', async () => {
    const llm = async () => ({ text: '〔시뮬레이션〕', simulated: true });
    const r = await socraticRead({ text: DOC, _deps: { llm, memory: fakeMemory() } });
    expect(r.simulated).toBe(true);
    expect(r.lines).toHaveLength(3);
  });

  it('질문 JSON 이 깨지면 오류로 알린다 (조용히 빈 이해를 내지 않는다)', async () => {
    const llm = scriptedLLM(['질문을 만들 수 없습니다']);
    const r = await socraticRead({ text: DOC, _deps: { llm, memory: fakeMemory() } });
    expect(r.error).toBe(true);
    expect(r.note).toMatch(/파싱/);
  });

  it('읽을 글이 없으면 오류', async () => {
    const r = await socraticRead({ text: '  \n ', _deps: { llm: scriptedLLM([]), memory: fakeMemory() } });
    expect(r.error).toBe(true);
  });
});

describe('ReadingMemory — 파일에 쌓인다', () => {
  it('record 가 횟수를 누적하고 예시는 최근 것부터', async () => {
    const { ReadingMemory } = await import('../../server/store.js');
    ReadingMemory.reset();
    ReadingMemory.record({ confusions: [{ from: '라', to: '나' }], mistakes: [{ kind: 'paraphrased', quote: 'a' }] });
    ReadingMemory.record({ confusions: [{ from: '라', to: '나' }], mistakes: [{ kind: 'fabricated', quote: 'b' }] });
    const m = ReadingMemory.get();
    expect(m.confusions).toEqual({ '라→나': 2 });
    expect(m.mistakes).toEqual({ paraphrased: 1, fabricated: 1 });
    expect(m.examples.map((e) => e.quote)).toEqual(['b', 'a']);
    expect(m.runs).toBe(2);
  });
});

/* ---------- T011 — 장기 기억을 문맥으로 (specs/001-verified-memory US1 · FR-006 FR-007 · SC-005) ---------- */

const NOTICE = ['연체 안내', '결제일 다음 날부터 연체 이자가 붙습니다.', '이자율은 연 15%입니다.'].join('\n');
const MEM = [{ id: 'm_card', text: '신한카드 결제일은 매월 14일입니다.', docId: 'card', source: { readAt: '2026-09-20T00:00:00Z' }, score: 0.9 }];

function memDeps(llm, recalled = MEM) {
  const calls = { recall: [], remember: [] };
  return {
    calls,
    deps: {
      llm, memory: fakeMemory(),
      recall: async (a) => { calls.recall.push(a); return { results: recalled, embedded: true }; },
      remember: async (a) => { calls.remember.push(a); return { added: 1 }; },
    },
  };
}

describe('socraticRead + 장기 기억', () => {
  it('관련 기억을 M 번호로 넣고, 연결 답은 L 과 M 을 둘 다 인용해야 통과한다', async () => {
    const prover = JSON.stringify({ questions: [
      { id: 'Q1', type: 'connection', q: '전에 읽은 결제일과 어떻게 이어지나?', a: '14일 결제일 다음 날, 즉 15일부터 이자가 붙는다',
        evidence: [{ line: 'L2', quote: '결제일 다음 날부터 연체 이자가 붙습니다' }, { line: 'M1', quote: '결제일은 매월 14일입니다' }] },
      { id: 'Q2', type: 'connection', q: '연결?', a: '14일', evidence: [{ line: 'L2', quote: '결제일 다음 날부터' }] },                 // M 없음
      { id: 'Q3', type: 'connection', q: '연결?', a: '20일', evidence: [{ line: 'L2', quote: '결제일 다음 날부터' }, { line: 'M1', quote: '결제일은 매월 20일입니다' }] },  // 기억에 없는 인용
      { id: 'Q4', type: 'claim', q: '핵심?', a: '연체 이자', evidence: [{ line: 'L2', quote: '연체 이자가 붙습니다' }] },
    ] });
    const synth = JSON.stringify({ sentences: ['결제일(14일) 다음 날부터 연체 이자가 붙는다 [L2, M1]', '20일부터다 [M9]'] });
    const llm = scriptedLLM([prover, synth]);
    const { deps, calls } = memDeps(llm);
    const r = await socraticRead({ text: NOTICE, rounds: 1, memory: true, docId: 'notice', _deps: deps });

    expect(llm.calls[0].prompt).toMatch(/M1: 신한카드 결제일은 매월 14일입니다/);
    expect(llm.calls[0].system).toMatch(/connection/);
    const st = Object.fromEntries(r.questions.map((q) => [q.id, [q.status, q.reason]]));
    expect(st.Q1[0]).toBe('verified');
    expect(st.Q2).toEqual(['refuted', 'connection_needs_both']);
    expect(st.Q3[0]).toBe('refuted');                         // SC-005: 기억에 없는 인용은 반박
    expect(r.sentences).toEqual(['결제일(14일) 다음 날부터 연체 이자가 붙는다 [L2, M1]']);
    expect(calls.recall[0]).toMatchObject({ excludeDocId: 'notice' });
    expect(r.memory.recalled[0]).toMatchObject({ id: 'M1', docId: 'card' });
  });

  it('관련 기억이 없으면 연결 질문은 지어내지 않고 "기억에 없음"', async () => {
    const prover = JSON.stringify({ questions: [
      { id: 'Q1', type: 'connection', q: '전에 읽은 것과?', a: '결제일과 이어진다', evidence: [{ line: 'L2', quote: '결제일 다음 날부터' }] },
    ] });
    const { deps } = memDeps(scriptedLLM([prover]), []);
    const r = await socraticRead({ text: NOTICE, rounds: 1, memory: true, _deps: deps });
    expect(r.questions[0]).toMatchObject({ status: 'unanswerable', reason: 'no_memory' });
    expect(r.unanswered[0].missing).toBe('관련 기억 없음');
  });

  it('끝나면 원문 L 줄과 검증된 문답만 기억에 넘긴다 — 반박된 답은 넘기지 않는다 (SC-004)', async () => {
    const prover = JSON.stringify({ questions: [
      { id: 'Q1', type: 'claim', q: '핵심?', a: '연체 이자', evidence: [{ line: 'L2', quote: '연체 이자가 붙습니다' }] },
      { id: 'Q2', type: 'evidence', q: '이자율?', a: '연 20%', evidence: [{ line: 'L3', quote: '이자율은 연 20%입니다' }] },   // 지어냄 → 반박
    ] });
    const synth = JSON.stringify({ sentences: ['연체 이자가 붙는다 [L2]'] });
    const { deps, calls } = memDeps(scriptedLLM([prover, synth]), []);
    await socraticRead({ text: NOTICE, rounds: 1, memory: true, docId: 'notice', title: '연체 안내', _deps: deps });

    const saved = calls.remember[0];
    expect(saved.docId).toBe('notice');
    expect(saved.units.map((u) => u.id)).toEqual(['L1', 'L2', 'L3']);
    expect(saved.facts).toHaveLength(1);
    expect(saved.facts[0]).toMatchObject({ verified: true, quote: ['연체 이자가 붙습니다'], lines: ['L2'] });
    expect(saved.facts.some((f) => f.text.includes('20%'))).toBe(false);
    expect(saved.source).toMatchObject({ title: '연체 안내', ocrEngine: 'text' });
  });

  it('memory 를 켜지 않으면 기억을 찾지도 저장하지도 않는다', async () => {
    const { deps, calls } = memDeps(scriptedLLM([prover, synth]));
    await socraticRead({ text: DOC, rounds: 1, _deps: deps });
    expect(calls.recall).toHaveLength(0);
    expect(calls.remember).toHaveLength(0);
  });
});

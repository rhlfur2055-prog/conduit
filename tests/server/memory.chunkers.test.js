// T003 — 청킹 (specs/001-verified-memory US2 · SC-001). 임베더는 가짜(글자 2-gram 해시 벡터)로 주입한다.
import { describe, it, expect } from 'vitest';
import { detectKind, splitSentences, chunk } from '../../server/memory/chunkers.js';
import { fakeEmbed } from '../fixtures/fakeEmbed.js';

describe('splitSentences — 한국어·영문 문장 분리', () => {
  it('다. 요. ? ! 에서 자르고 소수점·버전 번호는 자르지 않는다', () => {
    expect(splitSentences('결제일은 14일입니다. 금리는 3.5%예요. 괜찮나요? 네! v1.2 버전.'))
      .toEqual(['결제일은 14일입니다.', '금리는 3.5%예요.', '괜찮나요?', '네!', 'v1.2 버전.']);
  });
  it('줄바꿈도 경계다', () => {
    expect(splitSentences('첫 줄\n둘째 줄')).toEqual(['첫 줄', '둘째 줄']);
  });
});

describe('detectKind — 글 종류 판별 (FR-001)', () => {
  const cases = [
    ['short', '결제일은 매월 14일입니다.'],
    ['markdown', '# 카드 안내\n결제일은 14일입니다.\n## 연체\n연체 이자가 붙습니다.'],
    ['table', '이름,금액,날짜\n김민수,42000,9/1\n이지은,18000,9/2\n박서준,7000,9/3'],
    ['dialogue', '민수: 결제일이 언제야?\n지은: 매월 14일이야.\n민수: 늦으면?\n지은: 연체 이자 붙어.'],
    ['code', 'export function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}'],
    ['prose', '소크라테스는 질문으로 상대의 모순을 드러냈다. '.repeat(3) + '그는 답을 주지 않았다. '.repeat(3) + '대신 스스로 생각하게 만들었다. '.repeat(3)],
  ];
  for (const [kind, text] of cases) it(`${kind}`, () => expect(detectKind({ text })).toBe(kind));
  it('좌표가 있는 OCR 줄이면 screen', () => {
    expect(detectKind({ units: [{ id: 'L1', text: '설정', box: { x: 0, y: 0, w: 10, h: 10 } }] })).toBe('screen');
  });
});

describe('chunk — 종류별 청킹 (FR-002)', () => {
  it('short: 통째로 한 조각', async () => {
    const c = await chunk({ text: '결제일은 매월 14일입니다.' });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'short', text: '결제일은 매월 14일입니다.' });
  });

  it('markdown: 제목 단위, 조각에 제목 경로가 붙는다', async () => {
    const c = await chunk({ text: '# 카드 안내\n결제일은 14일입니다.\n## 연체\n연체 이자가 붙습니다.' });
    expect(c.map((x) => x.text)).toEqual(['카드 안내\n결제일은 14일입니다.', '카드 안내 > 연체\n연체 이자가 붙습니다.']);
  });

  it('table: 행 단위, 머리글을 붙인다', async () => {
    const c = await chunk({ text: '이름,금액\n김민수,42000\n이지은,18000' });
    expect(c.map((x) => x.text)).toEqual(['이름: 김민수 · 금액: 42000', '이름: 이지은 · 금액: 18000']);
  });

  it('dialogue: 같은 사람이 이어 말하면 합치고, 발화 순서를 지킨다', async () => {
    const c = await chunk({ text: '민수: 결제일이 언제야?\n민수: 이번 달 말이야?\n지은: 매월 14일이야.' });
    expect(c.map((x) => x.text)).toEqual(['민수: 결제일이 언제야? 이번 달 말이야?', '지은: 매월 14일이야.']);
  });

  it('code: 함수 단위', async () => {
    const c = await chunk({ text: 'function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}' });
    expect(c).toHaveLength(2);
    expect(c[1].text).toMatch(/^function sub/);
  });

  it('screen: 세로로 가까운 줄끼리 묶고 멀면 나눈다', async () => {
    const units = [
      { id: 'L1', text: '결제 수단 관리', box: { x: 10, y: 10, w: 100, h: 16 } },
      { id: 'L2', text: '신한카드 1234', box: { x: 10, y: 32, w: 100, h: 16 } },
      { id: 'L3', text: '알림 설정', box: { x: 10, y: 200, w: 80, h: 16 } },
      { id: 'L4', text: '푸시 알림 켜기', box: { x: 10, y: 222, w: 90, h: 16 } },
    ];
    const c = await chunk({ units });
    expect(c.map((x) => x.lines)).toEqual([['L1', 'L2'], ['L3', 'L4']]);
    expect(c[0].kind).toBe('screen');
  });

  it('prose: 의미가 바뀌는 곳에서 자른다 (시맨틱)', async () => {
    const a = ['카드 결제일은 매월 14일이다.', '카드 결제일이 지나면 카드 연체 이자가 붙는다.', '카드 연체 이자는 카드 결제일 다음 날부터 계산된다.'];
    const b = ['회의는 오후 3시 2층 회의실에서 열린다.', '회의 안건은 3분기 회의 매출 보고이다.', '회의록은 회의 다음 날 공유한다.'];
    const c = await chunk({ text: [...a, ...b].join(' '), kind: 'prose', embed: fakeEmbed, opts: { minSentences: 2 } });
    expect(c.map((x) => x.text)).toEqual([a.join(' '), b.join(' ')]);
  });

  it('prose: 임베더가 없으면 문단(빈 줄)과 최대 길이로 자른다', async () => {
    const c = await chunk({ text: '첫 문단 문장입니다. 또 문장입니다.\n\n둘째 문단입니다. 또 있습니다.', kind: 'prose' });
    expect(c.map((x) => x.text)).toEqual(['첫 문단 문장입니다. 또 문장입니다.', '둘째 문단입니다. 또 있습니다.']);
  });

  it('prose: 최대 길이를 넘는 조각은 더 자른다', async () => {
    const s = '가나다라마바사아자차카타파하 문장입니다.';
    const c = await chunk({ text: Array(40).fill(s).join(' '), kind: 'prose', embed: fakeEmbed, opts: { maxChars: 200 } });
    expect(c.every((x) => x.text.length <= 200)).toBe(true);
  });

  it('SC-001 결정론 — 같은 입력 100회는 100회 같은 조각', async () => {
    const text = '카드 결제일은 14일이다. 연체 이자가 붙는다. 회의는 3시다. 안건은 매출이다. 회의록은 공유한다. 결제는 자동이다.';
    const first = JSON.stringify(await chunk({ text, kind: 'prose', embed: fakeEmbed }));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(await chunk({ text, kind: 'prose', embed: fakeEmbed }))).toBe(first);
  });

  it('줄 단위 입력(socraticRead)은 조각마다 줄 번호를 남긴다', async () => {
    const units = [{ id: 'L1', text: '# 안내' }, { id: 'L2', text: '결제일은 14일입니다.' }, { id: 'L3', text: '## 연체' }, { id: 'L4', text: '이자가 붙습니다.' }];
    const c = await chunk({ units });
    expect(c.map((x) => x.lines)).toEqual([['L1', 'L2'], ['L3', 'L4']]);
  });
});

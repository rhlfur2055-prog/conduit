// 화면 언어 — 한국어/영어 사전이 서로 빠진 곳 없이 맞는지, 노드가 새로 생겨도 영어 이름이 빠지지 않는지 지킨다.
import { describe, it, expect } from 'vitest';
import { NODE_TYPES, PALETTE_GROUPS } from '../../src/engine/nodeTypes.ts';
import { tr, STRING_KEYS, NODE_EN, CATEGORY_EN, FIELD_EN, nodeTitle, nodeDesc, categoryLabel, fieldLabel, translateLog, displayWfName } from '../../src/i18n.js';

describe('화면 문구 사전', () => {
  it('한국어와 영어 키가 정확히 같다', () => {
    const { ko, en } = STRING_KEYS();
    expect(en.filter((k) => !ko.includes(k))).toEqual([]);
    expect(ko.filter((k) => !en.includes(k))).toEqual([]);
  });
  it('영어 문구에는 한글이 없다', () => {
    const { en } = STRING_KEYS();
    const hangul = en.filter((k) => k !== 'lang.toggle' && /[가-힣]/.test(tr('en', k)));
    expect(hangul).toEqual([]);
  });
  it('자리 채우기', () => {
    expect(tr('en', 'confirm.delete', { name: 'Orders' })).toBe('Delete the workflow "Orders"?');
    expect(tr('en', 'node.items', { n: 1, s: '' })).toBe('1 item');
    expect(tr('en', 'node.items', { n: 5, s: 's' })).toBe('5 items');
    expect(tr('ko', 'node.items', { n: 5 })).toBe('5건');
  });
});

describe('노드 이름 · 분류 · 입력칸', () => {
  it('모든 노드에 영어 이름과 설명이 있다 — 노드를 추가하면 여기서 걸린다', () => {
    expect(Object.keys(NODE_TYPES).filter((k) => !NODE_EN[k])).toEqual([]);
    for (const k of Object.keys(NODE_TYPES)) {
      expect(nodeTitle(k, 'en')).not.toMatch(/[가-힣]/);
      expect(nodeDesc(k, 'en')).not.toMatch(/[가-힣]/);
      expect(nodeTitle(k, 'ko')).toBe(NODE_TYPES[k].title);
    }
  });
  it('팔레트 분류가 전부 영어로 바뀐다', () => {
    for (const g of PALETTE_GROUPS) {
      expect(CATEGORY_EN[g.name]).toBeTruthy();
      expect(categoryLabel(g.name, 'en')).not.toMatch(/[가-힣]/);
    }
  });
  it('모든 입력칸에 영어 이름이 있다', () => {
    const missing = [];
    for (const [k, d] of Object.entries(NODE_TYPES)) {
      for (const f of d.fields || []) {
        if (!FIELD_EN[`${k}.${f.key}`]) missing.push(`${k}.${f.key}`);
        else expect(fieldLabel(k, f, 'en')).not.toMatch(/[가-힣]/);
      }
    }
    expect(missing).toEqual([]);
    // 없어진 입력칸에 대한 번역이 남아 있지 않다
    const live = new Set(Object.entries(NODE_TYPES).flatMap(([k, d]) => (d.fields || []).map((f) => `${k}.${f.key}`)));
    expect(Object.keys(FIELD_EN).filter((k) => !live.has(k))).toEqual([]);
  });
  it('기본 워크플로 이름은 화면에서만 바뀐다', () => {
    expect(displayWfName('현재 워크플로', 'en')).toBe('Current workflow');
    expect(displayWfName('현재 워크플로', 'ko')).toBe('현재 워크플로');
    expect(displayWfName('주문 분류 자동화', 'en')).toBe('주문 분류 자동화');   // 사용자가 지은 이름은 그대로
  });
});

describe('실행 로그 번역 — 엔진이 만든 문장', () => {
  const en = (m) => translateLog(m, 'en');
  it('README 데모 흐름의 로그가 전부 영어가 된다 (데이터 미리보기는 그대로)', () => {
    expect(en('워크플로 실행 시작…')).toBe('Workflow run started…');
    expect(en('✔ 수동 트리거 — 1건 입력 → 5건 출력 · {"customer":"김민수","amount":42000}'))
      .toBe('✔ Manual trigger — 1 in → 5 out · {"customer":"김민수","amount":42000}');
    expect(en('✔ 대기 (Wait) — 5건 입력 → 5건 출력')).toBe('✔ Wait — 5 in → 5 out');
    expect(en('✔ IF 조건 — 5건 입력 → 3건 출력')).toBe('✔ IF — 5 in → 3 out');
    expect(en('✔ 필드 설정 (Set) — 3건 입력 → 3건 출력')).toBe('✔ Set fields — 3 in → 3 out');
    expect(en('✔ 집계 (Aggregate) — 2건 입력 → 1건 출력')).toBe('✔ Aggregate — 2 in → 1 out');
    expect(en('⤵ 출력 — 건너뜀 (입력 없음)')).toBe('⤵ Output — skipped (no input)');
    expect(en('실행 완료.')).toBe('Run finished.');
  });
  it('긴 노드 이름이 먼저 바뀐다 (HTTP 요청 (인증) ≠ HTTP 요청)', () => {
    expect(en('✔ HTTP 요청 (인증) — 1건 입력 → 1건 출력')).toBe('✔ HTTP request (auth) — 1 in → 1 out');
    expect(en('✔ HTTP 요청 — 1건 입력 → 1건 출력')).toBe('✔ HTTP request — 1 in → 1 out');
  });
  it('승인·재시도·차단·실패 격리 문장', () => {
    expect(en('⏸ 사람 승인 대기 — 사람 승인 대기 (ap_1)')).toBe('⏸ Human approval — waiting for human approval (ap_1)');
    expect(en('↻ HTTP 요청 재시도 1/3 (500ms 후) — timeout')).toBe('↻ HTTP request retry 1/3 (in 500ms) — timeout');
    expect(en('✖ 코드 (JS) 차단: 이 서버에서는 코드 실행이 꺼져 있습니다 (CONDUIT_ALLOW_CODE)'))
      .toBe('✖ Code (JS) blocked: Code execution is turned off on this server (CONDUIT_ALLOW_CODE)');
    expect(en('⚠ 집계 (Aggregate) — 3건 입력 → 2건 출력 (실패 1건 격리)')).toBe('⚠ Aggregate — 3 in → 2 out (1 failed, isolated)');
    expect(en('⏸ Gmail 보내기 — 자동 승인 게이트: AI · Claude 의 출력이 밖으로 나가기 전에 사람이 봅니다 (시뮬레이션)'))
      .toBe('⏸ Send Gmail — auto approval gate: a person reviews the output of AI · Claude before it leaves (simulated)');
  });
  it('한국어 화면이면 그대로, 모르는 문장도 그대로', () => {
    expect(translateLog('실행 완료.', 'ko')).toBe('실행 완료.');
    expect(en('처음 보는 문장')).toBe('처음 보는 문장');
  });
});

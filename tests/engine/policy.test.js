import { describe, it, expect } from 'vitest';
import { resolveString, evalPath } from '../../src/engine/expr.js';
import { runFlow } from '../../src/engine/executor.js';
import { NODE_TYPES } from '../../src/engine/nodeTypes.js';

const safe = {
  $json: { name: '동근', 고객: { 이름: '김민수' }, '주문 번호': 'A-7', tags: ['a', 'b'] },
  $items: [{ x: 1 }, { x: 2 }],
  $index: 1,
  $now: '2026-09-19T00:00:00.000Z',
  safeExpressions: true,
};

describe('안전 모드 표현식 — 데이터 경로만 읽는다', () => {
  it('점·대괄호·한글 키·배열 인덱스', () => {
    expect(resolveString('{{ $json.name }}', safe)).toBe('동근');
    expect(resolveString('{{ $json.고객.이름 }}', safe)).toBe('김민수');
    expect(resolveString('{{ $json["주문 번호"] }}', safe)).toBe('A-7');
    expect(resolveString('{{ $items[1].x }}', safe)).toBe(2);
    expect(resolveString('{{ $json.tags }}', safe)).toEqual(['a', 'b']);
  });

  it('길이·인덱스·시각', () => {
    expect(resolveString('{{ $items.length }}', safe)).toBe(2);
    expect(resolveString('{{ $index }}', safe)).toBe(1);
    expect(resolveString('{{ $now }}', safe)).toBe(safe.$now);
  });

  it('문장 보간도 그대로 동작', () => {
    expect(resolveString('안녕 {{ $json.name }}님, 주문 {{ $json["주문 번호"] }}', safe)).toBe('안녕 동근님, 주문 A-7');
  });

  it('없는 경로는 undefined (오류 아님)', () => {
    expect(resolveString('{{ $json.missing.deep }}', safe)).toBeUndefined();
  });

  it('프로토타입 메서드는 읽지 않는다', () => {
    expect(resolveString('{{ $json.name.toUpperCase }}', safe)).toBeUndefined();
  });

  it('전역·연산·함수 호출·생성자 접근은 막는다', () => {
    for (const expr of [
      '{{ process.env.ANTHROPIC_API_KEY }}',
      '{{ $json.name + 1 }}',
      '{{ $json.name.toUpperCase() }}',
      '{{ $json.constructor }}',
      '{{ $json["__proto__"] }}',
      '{{ globalThis }}',
    ]) {
      expect(() => resolveString(expr, safe), expr).toThrow(/데이터 경로만/);
    }
  });

  it('막힌 표현식 오류는 재시도하지 않는 400', () => {
    let err;
    try { evalPath('$json.a()', safe); } catch (e) { err = e; }
    expect(err?.status).toBe(400);
  });

  it('안전 모드가 아니면 기존처럼 JS 표현식', () => {
    expect(resolveString('{{ $json.name + "!" }}', { ...safe, safeExpressions: false })).toBe('동근!');
  });
});

// ---- 실행 엔진에 정책 적용 ----
const node = (id, kind, params = {}) => ({ id, data: { kind, params: { ...NODE_TYPES[kind].defaults, ...params } } });
const edge = (source, target) => ({ source, target });
const trigger = (id, data) => node(id, 'manualTrigger', { json: JSON.stringify(data) });
const off = { policy: { allowCode: false } };

describe('runFlow 정책 — 코드 실행이 꺼진 서버', () => {
  it('코드 노드는 실행하지 않고 오류, 다음 노드는 건너뛴다', async () => {
    let ran = false;
    globalThis.__policyProbe = () => { ran = true; };
    const statuses = [];
    const res = await runFlow(
      [trigger('t', { a: 1 }), node('c', 'code', { code: 'globalThis.__policyProbe(); return input;' }),
        node('after', 'code', { code: 'return input;' })],
      [edge('t', 'c'), edge('c', 'after')],
      { ...off, onStatus: (id, status, info) => statuses.push({ id, status, error: info?.error }) },
    );
    delete globalThis.__policyProbe;
    expect(ran).toBe(false);
    expect(res.get('c').status).toBe('error');
    expect(statuses.find((s) => s.id === 'c' && s.status === 'error').error).toMatch(/코드 실행이 꺼져/);
    expect(res.get('after').status).toBe('skip');
  });

  it('데이터 경로 표현식은 계속 쓸 수 있다', async () => {
    const res = await runFlow(
      [trigger('t', [{ name: 'A' }, { name: 'B' }]), node('s', 'setFields', { json: '{ "greeting": "Hello {{ $json.name }}" }' })],
      [edge('t', 's')],
      off,
    );
    expect(res.get('s').output.main.map((i) => i.greeting)).toEqual(['Hello A', 'Hello B']);
  });

  it('코드가 섞인 표현식은 노드 오류로 끝나고 재시도하지 않는다', async () => {
    const res = await runFlow(
      [trigger('t', { name: 'a' }), node('s', 'setFields', { json: '{ "x": "{{ $json.name.toUpperCase() }}" }', _retries: 3 })],
      [edge('t', 's')],
      off,
    );
    expect(res.get('s').status).toBe('error');
    expect(res.get('s').attempts).toBe(1);
  });

  it('정책을 넘기지 않으면(브라우저) 코드 노드가 그대로 돈다', async () => {
    const res = await runFlow(
      [trigger('t', { n: 2 }), node('c', 'code', { code: 'return { n: input.n * 10 };' })],
      [edge('t', 'c')],
    );
    expect(res.get('c').output.main).toEqual([{ n: 20 }]);
  });
});

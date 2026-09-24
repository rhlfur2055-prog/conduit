import { describe, it, expect } from 'vitest';
import { evalExpr, resolveString, resolveParams, hasExpression } from '../../src/engine/expr.ts';

const ctx = {
  $json: { name: '동근', count: 3, tags: ['a', 'b'], nested: { v: 1 } },
  $items: [{}, {}],
  $index: 1,
  $now: '2026-09-19T00:00:00.000Z',
};

describe('resolveString — 전체가 {{ }} 한 개면 원래 타입을 돌려준다', () => {
  it('숫자·배열을 문자열로 바꾸지 않는다', () => {
    expect(resolveString('{{ $json.count }}', ctx)).toBe(3);
    expect(resolveString('{{ $json.tags }}', ctx)).toEqual(['a', 'b']);
  });

  it('앞뒤 공백은 허용', () => {
    expect(resolveString('  {{ $json.count }}  ', ctx)).toBe(3);
  });

  it('$index · $items · $now 를 쓸 수 있다', () => {
    expect(resolveString('{{ $index }}', ctx)).toBe(1);
    expect(resolveString('{{ $items.length }}', ctx)).toBe(2);
    expect(resolveString('{{ $now }}', ctx)).toBe(ctx.$now);
  });

  it('문법 오류는 예외 대신 undefined', () => {
    expect(resolveString('{{ 1 + }}', ctx)).toBeUndefined();
  });
});

describe('resolveString — 문자열 보간', () => {
  it('문장 안의 표현식을 채운다', () => {
    expect(resolveString('안녕 {{ $json.name }}님', ctx)).toBe('안녕 동근님');
  });

  it('객체는 JSON, 없는 값은 빈 문자열', () => {
    expect(resolveString('v={{ $json.nested }}', ctx)).toBe('v={"v":1}');
    expect(resolveString('x={{ $json.missing }}', ctx)).toBe('x=');
  });

  it('표현식 두 개가 문자열 전체를 차지해도 각각 해석한다', () => {
    expect(resolveString('{{ $json.name }} / {{ $json.count }}', ctx)).toBe('동근 / 3');
    expect(resolveString('{{ $json.name }}{{ $json.count }}', ctx)).toBe('동근3');
  });

  it('표현식이 없거나 문자열이 아니면 그대로', () => {
    expect(resolveString('plain', ctx)).toBe('plain');
    expect(resolveString(42, ctx)).toBe(42);
  });
});

describe('resolveParams / hasExpression / evalExpr', () => {
  it('문자열 필드만 해석하고 원본은 바꾸지 않는다', () => {
    const params = { a: '{{ $json.count }}', b: 5, c: 'plain' };
    expect(resolveParams(params, ctx)).toEqual({ a: 3, b: 5, c: 'plain' });
    expect(params.a).toBe('{{ $json.count }}');
  });

  it('표현식 포함 여부', () => {
    expect(hasExpression({ a: 'x {{ $json.a }}' })).toBe(true);
    expect(hasExpression({ a: 'x', b: 1 })).toBe(false);
    expect(hasExpression(undefined)).toBe(false);
  });

  it('ctx 가 비어 있어도 안전한 기본값', () => {
    expect(evalExpr('$json', {})).toEqual({});
    expect(evalExpr('$items.length', {})).toBe(0);
    expect(evalExpr('$index', {})).toBe(0);
  });
});

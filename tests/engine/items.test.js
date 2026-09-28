import { describe, it, expect } from 'vitest';
import { toItems, emptyToUndefined, firstItem, countItems, chunk, getPath, stableKey } from '../../src/engine/items.ts';

describe('toItems — 모든 값을 아이템 배열로 정규화', () => {
  it('undefined/null 은 빈 배열', () => {
    expect(toItems(undefined)).toEqual([]);
    expect(toItems(null)).toEqual([]);
  });

  it('배열은 그대로, 단일 값은 감싼다', () => {
    const arr = [{ a: 1 }];
    expect(toItems(arr)).toBe(arr);
    expect(toItems({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toItems(0)).toEqual([0]);
    expect(toItems('')).toEqual(['']);
  });
});

describe('emptyToUndefined / firstItem / countItems', () => {
  it('빈 배열은 undefined — 그 경로로 데이터가 흐르지 않음을 뜻한다', () => {
    expect(emptyToUndefined([])).toBeUndefined();
    expect(emptyToUndefined([1])).toEqual([1]);
    expect(emptyToUndefined(undefined)).toBeUndefined();
  });

  it('첫 아이템과 개수', () => {
    expect(firstItem([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
    expect(firstItem({ a: 1 })).toEqual({ a: 1 });
    expect(firstItem(undefined)).toBeUndefined();
    expect(countItems([1, 2, 3])).toBe(3);
    expect(countItems(undefined)).toBe(0);
  });
});

describe('chunk — 배치 처리 단위', () => {
  it('size 단위로 자르고 나머지는 마지막 청크에', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('size 가 0 이하면 통짜 하나', () => {
    const arr = [1, 2, 3];
    expect(chunk(arr, 0)).toEqual([arr]);
    expect(chunk(arr, -1)).toEqual([arr]);
  });
});

describe('getPath — dot 경로 읽기', () => {
  const obj = { a: { b: { c: 1 } }, list: [{ v: 'x' }] };

  it('중첩 값과 배열 인덱스', () => {
    expect(getPath(obj, 'a.b.c')).toBe(1);
    expect(getPath(obj, 'list.0.v')).toBe('x');
  });

  it('없는 경로는 undefined, 빈 경로는 객체 자신', () => {
    expect(getPath(obj, 'a.x.y')).toBeUndefined();
    expect(getPath(obj, '')).toBe(obj);
  });
});

describe('stableKey — 정렬/중복제거용 키', () => {
  it('키 순서가 달라도 같은 객체는 같은 키', () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });

  it('중첩 객체의 내용이 다르면 다른 키', () => {
    expect(stableKey({ user: { id: 1 } })).not.toBe(stableKey({ user: { id: 2 } }));
  });

  it('중첩 객체도 키 순서와 무관', () => {
    expect(stableKey({ u: { x: 1, y: 2 } })).toBe(stableKey({ u: { y: 2, x: 1 } }));
  });

  it('배열은 순서가 의미를 가진다', () => {
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });

  it('원시값과 null', () => {
    expect(stableKey(null)).toBe('');
    expect(stableKey(undefined)).toBe('');
    expect(stableKey(3)).toBe('3');
  });
});

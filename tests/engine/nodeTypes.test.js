import { describe, it, expect } from 'vitest';
import { NODE_TYPES } from '../../src/engine/nodeTypes.js';

// 노드 run() 을 직접 호출 — params 는 엔진이 표현식을 해석한 뒤의 값
const run = (kind, main, params = {}) =>
  NODE_TYPES[kind].run({ main }, { ...NODE_TYPES[kind].defaults, ...params }, { $now: '2026-09-19T00:00:00.000Z' });

describe('레지스트리 형태', () => {
  it('모든 노드는 제목·입출력 포트·run 함수를 가진다', () => {
    for (const [kind, def] of Object.entries(NODE_TYPES)) {
      expect(typeof def.title, kind).toBe('string');
      expect(Array.isArray(def.inputs), kind).toBe(true);
      expect(Array.isArray(def.outputs), kind).toBe(true);
      expect(typeof def.run, kind).toBe('function');
    }
  });
});

describe('비교 연산 (filter)', () => {
  const passes = async (item, op, value, field = 'v') => (await run('filter', item, { field, op, value })).main !== undefined;

  it('== 는 문자열로 비교한다', async () => {
    expect(await passes({ v: 1 }, '==', '1')).toBe(true);
    expect(await passes({ v: 'a' }, '!=', 'b')).toBe(true);
  });

  it('크기 비교는 숫자로', async () => {
    expect(await passes({ v: '10' }, '>', '9')).toBe(true);
    expect(await passes({ v: 3 }, '<=', '3')).toBe(true);
  });

  it('contains · isEmpty', async () => {
    expect(await passes({ v: 'hello world' }, 'contains', 'world')).toBe(true);
    expect(await passes({ v: '' }, 'isEmpty', '')).toBe(true);
    expect(await passes({}, 'isEmpty', '')).toBe(true);
    expect(await passes({ v: 0 }, 'isEmpty', '')).toBe(false);
  });
});

describe('흐름 제어', () => {
  it('Switch 는 값에 맞는 포트 하나로만 보낸다', async () => {
    const params = { field: 'status', v1: 'A', v2: 'B', v3: 'C' };
    expect(await run('switchNode', { status: 'B' }, params)).toMatchObject({ 1: undefined, 2: { status: 'B' }, 기타: undefined });
    expect((await run('switchNode', { status: 'Z' }, params))['기타']).toEqual({ status: 'Z' });
  });
});

describe('배열 처리', () => {
  it('Split Out 은 배열 필드를 아이템으로 펼치고 부모 필드를 골라 붙인다', async () => {
    const parent = { order: 7, meta: { shop: 'A' }, lines: [{ sku: 'x' }, { sku: 'y' }] };
    expect((await run('splitOut', parent, { fieldToSplitOut: 'lines', include: 'selected', includeFields: 'order, meta.shop' })).main)
      .toEqual([{ order: 7, shop: 'A', sku: 'x' }, { order: 7, shop: 'A', sku: 'y' }]);
    expect((await run('splitOut', parent, { fieldToSplitOut: 'lines', include: 'all' })).main[0])
      .toEqual({ order: 7, meta: { shop: 'A' }, sku: 'x' });
  });

  it('Split Out 은 원시값 배열을 { value } 로 감싼다', async () => {
    expect((await run('splitOut', { tags: ['a', 'b'] }, { fieldToSplitOut: 'tags', include: 'none' })).main)
      .toEqual([{ value: 'a' }, { value: 'b' }]);
  });

  it('Sort 는 숫자처럼 보이면 숫자로, 아니면 문자열로 정렬한다', async () => {
    const items = [{ n: '10' }, { n: '9' }, { n: '100' }];
    expect((await run('sortItems', items, { field: 'n', order: 'asc', type: 'auto' })).main.map((i) => i.n)).toEqual(['9', '10', '100']);
    expect((await run('sortItems', items, { field: 'n', order: 'asc', type: 'string' })).main.map((i) => i.n)).toEqual(['10', '100', '9']);
    expect((await run('sortItems', items, { field: 'n', order: 'desc', type: 'number' })).main.map((i) => i.n)).toEqual(['100', '10', '9']);
  });

  it('Sort 는 입력 배열을 바꾸지 않는다', async () => {
    const items = [{ n: 2 }, { n: 1 }];
    await run('sortItems', items, { field: 'n' });
    expect(items).toEqual([{ n: 2 }, { n: 1 }]);
  });

  it('Limit 은 앞 또는 뒤에서 자른다', async () => {
    const items = [1, 2, 3, 4].map((v) => ({ v }));
    expect((await run('limit', items, { maxItems: '2', keep: 'first' })).main).toEqual([{ v: 1 }, { v: 2 }]);
    expect((await run('limit', items, { maxItems: '2', keep: 'last' })).main).toEqual([{ v: 3 }, { v: 4 }]);
  });

  it('중복 제거는 기준 필드 또는 아이템 전체로 비교한다', async () => {
    const items = [{ id: 1, t: 'a' }, { id: 1, t: 'b' }, { t: 'a', id: 1 }];
    expect((await run('removeDuplicates', items, { field: 'id' })).main).toEqual([{ id: 1, t: 'a' }]);
    expect((await run('removeDuplicates', items, { field: '' })).main).toEqual([{ id: 1, t: 'a' }, { id: 1, t: 'b' }]);
  });

  it('Aggregate 연산들', async () => {
    const items = [{ p: 3 }, { p: 'x' }, { p: 1 }];
    const agg = async (operation) => (await run('aggregate', items, { operation, field: 'p', target: 'r' })).main.r;
    expect(await agg('avg')).toBe(2);
    expect(await agg('min')).toBe(1);
    expect(await agg('max')).toBe(3);
    expect(await agg('count')).toBe(3);
    expect(await agg('concat')).toBe('3, x, 1');
    expect((await run('aggregate', [], { operation: 'avg', field: 'p', target: 'r' })).main.r).toBe(0);
  });
});

describe('동작 노드', () => {
  it('키 이름 변경 — 없는 키면 그대로', async () => {
    expect((await run('renameKey', { name: 'a', x: 1 }, { from: 'name', to: 'title' })).main).toEqual({ title: 'a', x: 1 });
    expect((await run('renameKey', { x: 1 }, { from: 'name', to: 'title' })).main).toEqual({ x: 1 });
  });

  it('해시는 같은 입력에 같은 값', async () => {
    const a = (await run('hash', { name: 'conduit' }, { field: 'name', target: 'h' })).main.h;
    const b = (await run('hash', { name: 'conduit' }, { field: 'name', target: 'h' })).main.h;
    const c = (await run('hash', { name: 'other' }, { field: 'name', target: 'h' })).main.h;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('LLM 노드는 서버 브리지가 없으면 시뮬레이션 응답을 낸다', async () => {
    const out = await NODE_TYPES.ai.run({ main: {} }, { ...NODE_TYPES.ai.defaults, prompt: '안녕' }, {});
    expect(JSON.stringify(out)).toContain('시뮬레이션');
  });
});

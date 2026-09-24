import { describe, it, expect, afterEach } from 'vitest';
import { runFlow } from '../../src/engine/executor.ts';
import { NODE_TYPES } from '../../src/engine/nodeTypes.ts';

// ---- 워크플로 조립 헬퍼 ----
const node = (id, kind, params = {}) => ({
  id, data: { kind, params: { ...NODE_TYPES[kind].defaults, ...params } },
});
const trigger = (id, data) => node(id, 'manualTrigger', { json: JSON.stringify(data) });
const edge = (source, target, sourceHandle, targetHandle) => ({ source, target, sourceHandle, targetHandle });
const pass = (id) => node(id, 'code', { code: 'return input;' });
const mains = (res, id) => res.get(id).output.main;

// ---- 테스트 전용 노드 (끝나면 레지스트리에서 제거) ----
const registered = [];
function register(kind, def) {
  NODE_TYPES[kind] = { title: kind, inputs: ['main'], outputs: ['main'], defaults: {}, fields: [], ...def };
  registered.push(kind);
}
afterEach(() => { registered.splice(0).forEach((k) => delete NODE_TYPES[k]); });

describe('실행 순서와 데이터 흐름', () => {
  it('아이템마다 노드를 반복 실행한다', async () => {
    const res = await runFlow(
      [trigger('t', [{ count: 1 }, { count: 2 }, { count: 3 }]),
        node('c', 'code', { code: 'return { ...input, doubled: input.count * 2 };' })],
      [edge('t', 'c')],
    );
    expect(res.get('c').status).toBe('done');
    expect(mains(res, 'c').map((i) => i.doubled)).toEqual([2, 4, 6]);
  });

  it('노드 배열 순서와 무관하게 연결 순서대로 실행한다', async () => {
    const res = await runFlow(
      [node('b', 'code', { code: 'return { ...input, b: true };' }), trigger('t', { a: true })],
      [edge('t', 'b')],
    );
    expect(mains(res, 'b')).toEqual([{ a: true, b: true }]);
  });

  it('순환 연결이면 실행하지 않고 오류를 기록한다', async () => {
    const logs = [];
    const res = await runFlow([pass('a'), pass('b')], [edge('a', 'b'), edge('b', 'a')], { onLog: (l) => logs.push(l) });
    expect(res.size).toBe(0);
    expect(logs.some((l) => l.kind === 'err')).toBe(true);
  });

  it('표현식은 아이템마다 따로 해석된다', async () => {
    const res = await runFlow(
      [trigger('t', [{ name: 'A' }, { name: 'B' }]),
        node('s', 'setFields', { json: '{ "greeting": "Hello {{ $json.name }}", "idx": "{{ $index }}" }' })],
      [edge('t', 's')],
    );
    expect(mains(res, 's').map((i) => [i.greeting, i.idx])).toEqual([['Hello A', '0'], ['Hello B', '1']]);
  });

  it('외부에서 주입한 출력(seed)이 있으면 그 노드는 실행하지 않는다', async () => {
    const res = await runFlow(
      [trigger('t', { from: 'manual' }), pass('c')],
      [edge('t', 'c')],
      { seed: { t: { main: [{ from: 'webhook' }] } } },
    );
    expect(mains(res, 'c')).toEqual([{ from: 'webhook' }]);
  });
});

describe('분기', () => {
  it('IF 는 아이템 단위로 true/false 경로를 나눈다', async () => {
    const res = await runFlow(
      [trigger('t', [{ n: 0 }, { n: 5 }, { n: 9 }]),
        node('if', 'ifNode', { field: 'n', op: '>', value: '3' }), pass('yes'), pass('no')],
      [edge('t', 'if'), edge('if', 'yes', 'true'), edge('if', 'no', 'false')],
    );
    expect(mains(res, 'yes').map((i) => i.n)).toEqual([5, 9]);
    expect(mains(res, 'no').map((i) => i.n)).toEqual([0]);
  });

  it('데이터가 오지 않은 경로의 다음 노드는 건너뛴다', async () => {
    const res = await runFlow(
      [trigger('t', [{ n: 5 }]), node('if', 'ifNode', { field: 'n', op: '>', value: '3' }), pass('yes'), pass('no')],
      [edge('t', 'if'), edge('if', 'yes', 'true'), edge('if', 'no', 'false')],
    );
    expect(res.get('yes').status).toBe('done');
    expect(res.get('no').status).toBe('skip');
  });
});

describe('배치 모드 노드 (배열 통째로 처리)', () => {
  it('Aggregate 는 모든 아이템을 한 번에 받는다', async () => {
    const res = await runFlow(
      [trigger('t', [{ p: 1000 }, { p: 2500 }, { p: 500 }]),
        node('agg', 'aggregate', { operation: 'sum', field: 'p', target: 'total' })],
      [edge('t', 'agg')],
    );
    expect(mains(res, 'agg')).toEqual([{ total: 4000, _count: 3 }]);
  });

  it('Merge 는 두 입력 포트를 이어붙이거나 인덱스별로 합친다', async () => {
    const build = (strategy) => runFlow(
      [trigger('a', [{ x: 1 }, { x: 2 }]), trigger('b', [{ y: 9 }]), node('m', 'merge', { strategy })],
      [edge('a', 'm', undefined, 'input1'), edge('b', 'm', undefined, 'input2')],
    );
    expect(mains(await build('append'), 'm')).toEqual([{ x: 1 }, { x: 2 }, { y: 9 }]);
    expect(mains(await build('combine(인덱스별 병합)'), 'm')).toEqual([{ x: 1, y: 9 }, { x: 2 }]);
  });

  it('중복 제거는 중첩 객체의 내용까지 비교한다', async () => {
    const res = await runFlow(
      [trigger('t', [{ u: { id: 1 } }, { u: { id: 2 } }, { u: { id: 1 } }]), node('d', 'removeDuplicates', { field: '' })],
      [edge('t', 'd')],
    );
    expect(mains(res, 'd')).toEqual([{ u: { id: 1 } }, { u: { id: 2 } }]);
  });
});

describe('오류 처리', () => {
  const failOnBad = "if (input.bad) throw new Error('broken'); return input;";

  it('Continue On Fail 이면 실패한 아이템만 격리하고 나머지는 흐른다', async () => {
    const dead = [];
    const res = await runFlow(
      [trigger('t', [{ id: 1 }, { id: 2, bad: true }, { id: 3 }]),
        node('c', 'code', { code: failOnBad, _continueOnFail: true })],
      [edge('t', 'c')],
      { onDeadLetter: (d) => dead.push(d) },
    );
    const r = res.get('c');
    expect(r.status).toBe('failedContinue');
    expect(r.failedItems).toBe(1);
    // 실패한 아이템도 원래 자리를 지킨 채 에러 정보를 달고 흐른다
    expect(r.output.main.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(r.output.main[1]._error.message).toBe('broken');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ nodeId: 'c', itemKey: '1', errorMsg: 'broken' });
  });

  it('Continue On Fail 이 아니면 노드가 실패하고 다음 노드는 건너뛴다', async () => {
    const res = await runFlow(
      [trigger('t', [{ id: 1 }, { id: 2, bad: true }]), node('c', 'code', { code: failOnBad }), pass('after')],
      [edge('t', 'c'), edge('c', 'after')],
    );
    expect(res.get('c').status).toBe('error');
    expect(res.get('after').status).toBe('skip');
  });

  it('중단 노드는 설정한 메시지로 실패한다', async () => {
    const statuses = [];
    await runFlow(
      [trigger('t', { a: 1 }), node('stop', 'stopError', { message: '재고 없음' })],
      [edge('t', 'stop')],
      { onStatus: (id, status, info) => statuses.push({ id, status, error: info?.error }) },
    );
    expect(statuses.at(-1)).toEqual({ id: 'stop', status: 'error', error: '재고 없음' });
  });
});

describe('재시도', () => {
  it('일시 오류(503)는 _retries 만큼 다시 시도해 성공한다', async () => {
    let calls = 0;
    register('flaky', {
      run: async (i) => {
        calls++;
        if (calls < 3) throw Object.assign(new Error('upstream down'), { status: 503 });
        return { main: i.main };
      },
    });
    const res = await runFlow([trigger('t', { ok: 1 }), node('f', 'flaky', { _retries: 2 })], [edge('t', 'f')]);
    expect(res.get('f').status).toBe('done');
    expect(res.get('f').attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it('영구 오류(401)는 재시도하지 않는다', async () => {
    let calls = 0;
    register('unauthorized', {
      run: async () => { calls++; throw Object.assign(new Error('unauthorized'), { status: 401 }); },
    });
    const res = await runFlow([trigger('t', { ok: 1 }), node('u', 'unauthorized', { _retries: 3 })], [edge('t', 'u')]);
    expect(res.get('u').status).toBe('error');
    expect(res.get('u').attempts).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('배치 크기 (_batchSize)', () => {
  const probe = () => {
    const stats = { active: 0, max: 0 };
    register('probe', {
      run: async (i) => {
        stats.active++;
        stats.max = Math.max(stats.max, stats.active);
        await new Promise((r) => setTimeout(r, i.main.wait));
        stats.active--;
        return { main: i.main };
      },
    });
    return stats;
  };
  const items = [{ id: 1, wait: 30 }, { id: 2, wait: 5 }, { id: 3, wait: 15 }, { id: 4, wait: 1 }];

  it('기본은 한 번에 하나씩 순차 실행', async () => {
    const stats = probe();
    await runFlow([trigger('t', items), node('p', 'probe')], [edge('t', 'p')]);
    expect(stats.max).toBe(1);
  });

  it('배치 크기만큼 병렬로 돌리되 출력 순서는 입력 순서를 지킨다', async () => {
    const stats = probe();
    const res = await runFlow([trigger('t', items), node('p', 'probe', { _batchSize: 2 })], [edge('t', 'p')]);
    expect(stats.max).toBe(2);
    expect(mains(res, 'p').map((i) => i.id)).toEqual([1, 2, 3, 4]);
  });

  it('배치로 나눠도 $index 는 전체 기준으로 이어진다', async () => {
    const res = await runFlow(
      [trigger('t', [{}, {}, {}]), node('s', 'setFields', { json: '{ "idx": "{{ $index }}" }', _batchSize: 2 })],
      [edge('t', 's')],
    );
    expect(mains(res, 's').map((i) => i.idx)).toEqual(['0', '1', '2']);
  });

  it('아이템 진행률을 알린다', async () => {
    const progress = [];
    await runFlow(
      [trigger('t', [{ a: 1 }, { a: 2 }, { a: 3 }]), pass('c')],
      [edge('t', 'c')],
      { onItemProgress: (id, done, total) => progress.push([id, done, total]) },
    );
    expect(progress).toEqual([['c', 1, 3], ['c', 2, 3], ['c', 3, 3]]);
  });
});

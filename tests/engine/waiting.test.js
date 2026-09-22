// 사람 승인 대기 — 노드가 { __wait } 를 내면 엔진이 멈추고(waiting), 그 아래는 전부 건너뛰며, seed 로 주입하면 그 아래만 이어서 실행된다.
import { describe, it, expect, afterEach } from 'vitest';
import { runFlow } from '../../src/engine/executor.js';
import { NODE_TYPES } from '../../src/engine/nodeTypes.js';

const node = (id, kind, params = {}) => ({ id, data: { kind, params: { ...NODE_TYPES[kind].defaults, ...params } } });
const trigger = (id, data) => node(id, 'manualTrigger', { json: JSON.stringify(data) });
const edge = (source, target, sourceHandle, targetHandle) => ({ source, target, sourceHandle, targetHandle });

const registered = [];
function register(kind, def) {
  NODE_TYPES[kind] = { title: kind, inputs: ['main'], outputs: ['main'], defaults: {}, fields: [], ...def };
  registered.push(kind);
}
afterEach(() => { registered.splice(0).forEach((k) => delete NODE_TYPES[k]); });

const gateFlow = () => ({
  nodes: [
    trigger('t', { name: '김민수', draft: '오늘 시세 안내' }),
    node('gate', 'gate'),
    node('after', 'setFields', { json: '{"sent": true}' }),      // 승인 뒤에만 흘러야 하는 노드
    node('side', 'setFields', { json: '{"logged": true}' }),     // 승인과 무관한 가지
  ],
  edges: [edge('t', 'gate'), edge('gate', 'after', 'approved', 'main'), edge('t', 'side')],
});

describe('사람 승인 대기 (waiting)', () => {
  it('__wait 를 낸 노드는 waiting 이 되고, 아래 노드는 건너뛰며, 다른 가지는 계속 흐른다', async () => {
    register('gate', { outputs: ['approved', 'rejected'], run: async () => ({ __wait: { approvalId: 'ap_test' } }) });
    const { nodes, edges } = gateFlow();
    const statuses = [];
    const res = await runFlow(nodes, edges, { onStatus: (id, s) => statuses.push([id, s]) });

    expect(res.get('gate').status).toBe('waiting');
    expect(res.get('gate').wait).toEqual([{ approvalId: 'ap_test' }]);
    expect(res.get('gate').output).toEqual({});
    expect(res.get('after').status).toBe('skip');
    expect(res.get('side').status).toBe('done');
    expect(statuses).toContainEqual(['gate', 'waiting']);
  });

  it('입력이 여럿인 노드는 한쪽이 승인 대기면 반쪽 입력으로 돌지 않고 건너뛴다 (그 아래도)', async () => {
    register('gate', { outputs: ['approved'], run: async () => ({ __wait: { approvalId: 'x' } }) });
    let joinRuns = 0;
    register('join', { inputs: ['a', 'b'], run: async () => { joinRuns++; return { main: { joined: true } }; } });
    const nodes = [trigger('t', { v: 1 }), node('gate', 'gate'), node('join', 'join'), node('tail', 'setFields', { json: '{"tail": true}' })];
    const edges = [edge('t', 'gate'), edge('gate', 'join', 'approved', 'a'), edge('t', 'join', 'main', 'b'), edge('join', 'tail')];
    const res = await runFlow(nodes, edges);
    expect(res.get('join').status).toBe('skip');
    expect(res.get('tail').status).toBe('skip');
    expect(joinRuns).toBe(0);

    // 재개: gate 출력을 주입하면 join 이 양쪽 입력으로 돈다
    const resumed = await runFlow(nodes, edges, { seed: { t: res.get('t').output, gate: { approved: [{ v: 1, approval: { decision: 'approve' } }] } } });
    expect(resumed.get('join').status).toBe('done');
    expect(resumed.get('tail').status).toBe('done');
    expect(joinRuns).toBe(1);
  });

  it('seed 로 승인 노드 출력을 주입하면 위 노드는 다시 실행되지 않고 아래 노드만 이어서 실행된다', async () => {
    let gateRuns = 0;
    register('gate', { outputs: ['approved', 'rejected'], run: async () => { gateRuns++; return { __wait: { approvalId: 'x' } }; } });
    const { nodes, edges } = gateFlow();
    const first = await runFlow(nodes, edges);
    expect(gateRuns).toBe(1);

    const seed = {
      t: first.get('t').output,
      side: first.get('side').output,
      gate: { approved: [{ name: '김민수', approval: { decision: 'approve', by: 'tester' } }] },
    };
    const second = await runFlow(nodes, edges, { seed });
    expect(gateRuns).toBe(1);                              // 승인 노드는 재실행되지 않음
    expect(second.get('after').status).toBe('done');
    expect(second.get('after').output.main[0]).toMatchObject({ sent: true, approval: { decision: 'approve' } });
  });

  it('빈 출력({})으로 주입된 노드는 실행되지 않고 그 아래는 건너뛴다 — 다른 승인 노드·실패 노드 재실행 방지', async () => {
    let runs = 0;
    register('gate', { outputs: ['approved'], run: async () => { runs++; return { __wait: {} }; } });
    const nodes = [trigger('t', { v: 1 }), node('gate', 'gate'), node('after', 'setFields', { json: '{"x": 1}' })];
    const edges = [edge('t', 'gate'), edge('gate', 'after', 'approved', 'main')];
    const res = await runFlow(nodes, edges, { seed: { t: { main: [{ v: 1 }] }, gate: {} } });
    expect(runs).toBe(0);
    expect(res.get('gate').status).toBe('done');
    expect(res.get('after').status).toBe('skip');
  });

  it('거절이면 rejected 포트로만 흐른다', async () => {
    register('gate', { outputs: ['approved', 'rejected'], run: async () => ({ __wait: {} }) });
    const { nodes, edges } = gateFlow();
    nodes.push(node('onReject', 'setFields', { json: '{"cancelled": true}' }));
    edges.push(edge('gate', 'onReject', 'rejected', 'main'));
    const res = await runFlow(nodes, edges, { seed: { t: { main: [{ name: 'a' }] }, gate: { rejected: [{ name: 'a', approval: { decision: 'reject' } }] } } });
    expect(res.get('after').status).toBe('skip');
    expect(res.get('onReject').status).toBe('done');
  });

  it('브라우저(서버 브리지 없음)에서 실제 승인 노드는 통과시키지 않고 waiting 으로만 표시한다', async () => {
    const nodes = [trigger('t', { name: 'a', draft: 'b' }), node('g', 'approvalRequest'), node('after', 'setFields', { json: '{"sent": true}' })];
    const edges = [edge('t', 'g'), edge('g', 'after', 'approved', 'main')];
    const res = await runFlow(nodes, edges);
    expect(res.get('g').status).toBe('waiting');
    expect(res.get('g').wait[0]).toMatchObject({ simulated: true });
    expect(res.get('after').status).toBe('skip');
  });

  it('노드 ctx 에 $nodeId · $flow · $results · $meta 가 전달된다', async () => {
    let seen;
    register('probe', { run: async (_i, _p, ctx) => { seen = ctx; return { main: {} }; } });
    const nodes = [trigger('t', { a: 1 }), node('p', 'probe')];
    const edges = [edge('t', 'p')];
    await runFlow(nodes, edges, { meta: { workflowId: 'wf_1' } });
    expect(seen.$nodeId).toBe('p');
    expect(seen.$flow.nodes).toBe(nodes);
    expect(seen.$results.get('t').status).toBe('done');
    expect(seen.$meta).toEqual({ workflowId: 'wf_1' });
  });
});

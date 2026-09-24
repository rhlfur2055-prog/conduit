// 자동 승인 게이트 — 그래프 판정(src/engine/gates.ts)과 실행기의 멈춤·재개.
//   규칙: 발송 노드(sends)로 들어오는 경로 위에 모델 출력 노드(llm)가 있고 그 사이에 승인 노드가 없으면 발송 직전에 멈춘다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runFlow } from '../../src/engine/executor.ts';
import { NODE_TYPES } from '../../src/engine/nodeTypes.ts';
import { analyzeGates, unguardedSources, nodeSends } from '../../src/engine/gates.ts';

const n = (id, kind, params = {}) => ({ id, data: { kind, params: { ...NODE_TYPES[kind].defaults, ...params } } });
const e = (source, target, sourceHandle = 'main', targetHandle = 'main') => ({ source, target, sourceHandle, targetHandle });
const trig = (id, data) => n(id, 'manualTrigger', { json: JSON.stringify(data) });

// AI → 텔레그램 (승인 노드 없음) + AI 와 무관한 가지
const unguardedFlow = () => ({
  nodes: [trig('t', { name: '김민수', q: '배송 언제?' }), n('ai', 'ai', { prompt: '답장 초안: {{ $json.q }}' }), n('send', 'telegram', { chatId: '1', text: '{{ $json.aiText }}' }), n('log', 'setFields', { json: '{"logged": true}' })],
  edges: [e('t', 'ai'), e('ai', 'send'), e('t', 'log')],
});

describe('그래프 판정 — analyzeGates / unguardedSources', () => {
  it('AI → 발송 사이에 승인 노드가 없으면 보호되지 않은 경로다', () => {
    const f = unguardedFlow();
    expect(analyzeGates(f.nodes, f.edges)).toEqual([{ target: 'send', sources: ['ai'] }]);
  });

  it('승인 노드가 사이에 있으면 경로가 끊긴다', () => {
    const f = unguardedFlow();
    f.nodes.push(n('g', 'approvalRequest'));
    f.edges = [e('t', 'ai'), e('ai', 'g'), e('g', 'send', 'approved'), e('t', 'log')];
    expect(analyzeGates(f.nodes, f.edges)).toEqual([]);
  });

  it('AI 가 없는 발송, 발송이 없는 AI 는 대상이 아니다', () => {
    expect(analyzeGates([trig('t', {}), n('send', 'telegram')], [e('t', 'send')])).toEqual([]);
    expect(analyzeGates([trig('t', {}), n('ai', 'ai'), n('out', 'output')], [e('t', 'ai'), e('ai', 'out')])).toEqual([]);
  });

  it('중간에 코드·필드 노드가 있어도 경로는 이어진다 (데이터가 아니라 그래프를 본다)', () => {
    const nodes = [trig('t', {}), n('ai', 'ai'), n('c', 'code', { code: 'return { only: "this" };' }), n('send', 'slack')];
    expect(analyzeGates(nodes, [e('t', 'ai'), e('ai', 'c'), e('c', 'send')])).toEqual([{ target: 'send', sources: ['ai'] }]);
  });

  it('이미 승인된 게이트는 경로를 끊는다 — 같은 체인의 두 번째 발송을 다시 묻지 않는다', () => {
    const nodes = [trig('t', {}), n('ai', 'ai'), n('s1', 'telegram'), n('s2', 'slack')];
    const edges = [e('t', 'ai'), e('ai', 's1'), e('s1', 's2')];
    expect(analyzeGates(nodes, edges).map((u) => u.target)).toEqual(['s1', 's2']);
    expect(analyzeGates(nodes, edges, new Set(['s1'])).map((u) => u.target)).toEqual([]);
    expect(unguardedSources('s2', nodes, edges, new Set(['s1']))).toEqual([]);
  });

  it('HTTP 요청은 GET 이면 읽기, 아니면 발송 · MCP 는 도구 이름이 있어야 발송', () => {
    expect(nodeSends(NODE_TYPES.httpRequest, { method: 'GET' })).toBe(false);
    expect(nodeSends(NODE_TYPES.httpRequest, { method: 'POST' })).toBe(true);
    expect(nodeSends(NODE_TYPES.httpAuth, { method: 'delete' })).toBe(true);
    expect(nodeSends(NODE_TYPES.mcpTool, { tool: '' })).toBe(false);
    expect(nodeSends(NODE_TYPES.mcpTool, { tool: 'send_mail' })).toBe(true);
    expect(nodeSends(NODE_TYPES.telegram, {})).toBe(true);
    expect(nodeSends(NODE_TYPES.youtube, {})).toBe(false);
  });

  it('모델 출력 노드는 llm 표시로 정한다 (카테고리가 아니라)', () => {
    for (const k of ['ai', 'aiExtract', 'aiAgent', 'loopRefine', 'socraticRead', 'screenUnderstand']) expect(NODE_TYPES[k].llm).toBe(true);
    for (const k of ['ocr', 'memoryRecall', 'memoryDigest', 'plateRecognize', 'httpRequest']) expect(NODE_TYPES[k].llm).toBeFalsy();
  });
});

describe('실행기 — 발송 직전에 멈추고, 결정대로 재개한다', () => {
  const calls = { approval: [], telegram: [] };
  const prev = {};
  beforeEach(() => {
    calls.approval.length = 0; calls.telegram.length = 0;
    prev.integrations = globalThis.__conduitIntegrations; prev.llm = globalThis.__conduitLLM;
    globalThis.__conduitLLM = async ({ prompt }) => ({ text: `초안(${prompt})`, model: 'fake' });
    globalThis.__conduitIntegrations = {
      approval: async (a) => { calls.approval.push(a); return { waiting: true, approvalId: 'ap_auto1', channel: 'telegram' }; },
      telegram: async (a) => { calls.telegram.push(a); return { ok: true }; },
    };
  });
  afterEach(() => { globalThis.__conduitIntegrations = prev.integrations; globalThis.__conduitLLM = prev.llm; });

  it('AI 출력이 승인 없이 텔레그램으로 가면 발송 노드가 waiting 이 되고, 무관한 가지는 계속 흐른다', async () => {
    const f = unguardedFlow();
    const logs = [];
    const res = await runFlow(f.nodes, f.edges, { onLog: (l) => logs.push(l.msg) });
    expect(res.get('ai').status).toBe('done');
    expect(res.get('send').status).toBe('waiting');
    expect(res.get('send').wait).toEqual([{ approvalId: 'ap_auto1', channel: 'telegram', gate: 'auto' }]);
    expect(res.get('log').status).toBe('done');
    expect(calls.telegram).toHaveLength(0);                                   // 보내지 않았다
    expect(calls.approval).toHaveLength(1);
    expect(calls.approval[0]).toMatchObject({ gate: 'auto', title: '자동 승인: 텔레그램 메시지', chatId: '' });
    expect(calls.approval[0].text).toContain('초안(');                        // AI 가 쓴 본문을 사람이 본다
    expect(calls.approval[0]._ctx).toMatchObject({ nodeId: 'send' });
    expect(calls.approval[0].item.items[0]).toMatchObject({ name: '김민수' });
    expect(logs.some((m) => m.includes('자동 승인 게이트') && m.includes('AI · Claude'))).toBe(true);
  });

  it('정책이 off 면 묻지 않고 보낸다', async () => {
    const f = unguardedFlow();
    const res = await runFlow(f.nodes, f.edges, { policy: { aiGate: 'off' } });
    expect(res.get('send').status).toBe('done');
    expect(calls.telegram).toHaveLength(1);
    expect(calls.approval).toHaveLength(0);
  });

  it('승인 노드를 직접 놓았으면 자동 게이트는 끼어들지 않는다', async () => {
    const f = unguardedFlow();
    f.nodes.push(n('g', 'approvalRequest', { chatId: '1' }));
    f.edges = [e('t', 'ai'), e('ai', 'g'), e('g', 'send', 'approved'), e('t', 'log')];
    globalThis.__conduitIntegrations.approval = async (a) => { calls.approval.push(a); return { waiting: true, approvalId: 'ap_node', channel: 'telegram' }; };
    const res = await runFlow(f.nodes, f.edges);
    expect(res.get('g').status).toBe('waiting');
    expect(res.get('send').status).toBe('skip');
    expect(calls.approval).toHaveLength(1);
    expect(calls.approval[0].gate).toBeUndefined();                           // 승인 노드의 요청이지 자동 게이트가 아니다
  });

  it('승인 재개: 위쪽은 주입되고, 발송 노드는 approval 이 붙은 아이템으로 실행된다', async () => {
    const f = unguardedFlow();
    const approval = { id: 'ap_auto1', decision: 'approve', by: '@me', at: '2026-09-24T00:00:00.000Z' };
    const seed = { t: { main: [{ name: '김민수', q: '배송 언제?' }] }, ai: { main: [{ name: '김민수', q: '배송 언제?', aiText: '초안' }] }, log: { main: [{ logged: true }] } };
    const logs = [];
    const res = await runFlow(f.nodes, f.edges, { seed, gates: { approved: { send: approval } }, onLog: (l) => logs.push(l.msg) });
    expect(res.get('send').status).toBe('done');
    expect(calls.approval).toHaveLength(0);                                   // 다시 묻지 않는다
    expect(calls.telegram).toHaveLength(1);
    expect(calls.telegram[0].text).toBe('초안');
    expect(res.get('send').output.main[0]).toMatchObject({ aiText: '초안', approval: { id: 'ap_auto1', decision: 'approve', by: '@me' } });
    expect(logs.filter((m) => m.includes('주입'))).toHaveLength(3);          // t · ai · log 는 재실행이 아니라 주입
  });

  it('거절·만료 재개: 발송 노드는 건너뛰고 보내지 않는다', async () => {
    const f = unguardedFlow();
    const seed = { t: { main: [{}] }, ai: { main: [{ aiText: '초안' }] }, log: { main: [{}] } };
    const res = await runFlow(f.nodes, f.edges, { seed, gates: { rejected: { send: { id: 'ap_auto1', decision: 'reject', by: '@me' } } } });
    expect(res.get('send').status).toBe('skip');
    expect(calls.telegram).toHaveLength(0);
  });

  it('승인 채널이 없으면 조용히 보내지 않고 노드 오류가 난다', async () => {
    globalThis.__conduitIntegrations.approval = async () => ({ error: 'telegram 승인 채널이 설정되지 않았습니다' });
    const f = unguardedFlow();
    const res = await runFlow(f.nodes, f.edges);
    expect(res.get('send').status).toBe('error');
    expect(calls.telegram).toHaveLength(0);
  });

  it('브라우저(브리지 없음)에서는 시뮬레이션 대기로만 표시하고 통과시키지 않는다', async () => {
    globalThis.__conduitIntegrations = undefined;
    const f = unguardedFlow();
    const res = await runFlow(f.nodes, f.edges);
    expect(res.get('send').status).toBe('waiting');
    expect(res.get('send').wait[0]).toMatchObject({ approvalId: null, simulated: true, gate: 'auto' });
  });
});

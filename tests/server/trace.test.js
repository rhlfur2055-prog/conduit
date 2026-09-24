// 실행 추적 — 실행 하나에 노드별 시도·시간·주입, 그 실행이 만든 승인과 재개 실행, 격리된 실패가 한 번에 묶여 나온다.
// 텔레그램·LLM 은 가짜. 데이터는 임시 폴더.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-trace-'));
process.env.CONDUIT_DATA_DIR = dataDir;
delete process.env.CONDUIT_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

const { app } = await import('../../server/index.js');
const { execute } = await import('../../server/runtime.js');
const { setApprovalAdapter, decide } = await import('../../server/approvals.js');
const { Executions, DLQ, closeDb } = await import('../../server/store.js');

setApprovalAdapter('telegram', {
  ready: () => true, defaultChat: () => '123',
  send: async (a) => ({ messageId: 500, chatId: a.chatId }), decided: async () => {}, remind: async () => {},
});
const sent = [];
globalThis.__conduitIntegrations.telegram = async (a) => { sent.push(a); return { ok: true }; };
globalThis.__conduitLLM = async ({ prompt }) => ({ text: `초안: ${prompt}`, model: 'fake' });

let server, base;
const api = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), text: null };
};
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 윈도우 */ }
});

const n = (id, kind, params = {}) => ({ id, data: { kind, params } });
const e = (source, target, sourceHandle = 'main') => ({ id: `e_${source}_${target}`, source, target, sourceHandle, targetHandle: 'main' });
// AI → 텔레그램(자동 게이트) + 실패해도 계속 가는 노드(DLQ 로 격리) + 무관한 가지
const flow = {
  id: 'wf_trace', name: '추적 데모',
  nodes: [
    n('t', 'manualTrigger', { json: JSON.stringify([{ q: '배송?' }, { q: '환불?' }]) }),
    n('ai', 'ai', { model: 'claude-sonnet-5', system: '', prompt: '{{ $json.q }}' }),
    n('send', 'telegram', { chatId: '123', text: '{{ $json.aiText }}' }),
    n('boom', 'code', { code: 'if (input.q === "환불?") throw new Error("환불 계산 실패"); return input;', _continueOnFail: 'true' }),
  ],
  edges: [e('t', 'ai'), e('ai', 'send'), e('t', 'boom')],
};

describe('GET /api/executions/:id/trace', () => {
  let execId, apId, resumedId;

  it('원래 실행: 노드별 시도·시간·건수, 자동 게이트 승인, 격리된 실패가 이 실행에 매달린다', async () => {
    const r = await execute(flow, { trigger: 'manual' });
    execId = r.execution.id;
    expect(execId).toMatch(/^ex_/);
    expect(r.execution.status).toBe('waiting');
    expect(typeof r.execution.durationMs).toBe('number');

    const t = (await api('GET', `/api/executions/${execId}/trace`)).json;
    expect(t.execution).toMatchObject({ id: execId, workflowId: 'wf_trace', status: 'waiting', trigger: 'manual' });
    const byId = Object.fromEntries(t.nodes.map((x) => [x.id, x]));
    expect(byId.t).toMatchObject({ title: '수동 트리거', status: 'done', attempts: 1, injected: false, outCount: 2 });
    expect(byId.ai).toMatchObject({ kind: 'ai', status: 'done', attempts: 2, inCount: 2, outCount: 2 });   // 아이템 2개 = 시도 2회
    expect(typeof byId.ai.ms).toBe('number');
    expect(byId.send).toMatchObject({ status: 'waiting', outCount: null });
    expect(byId.send.wait[0]).toMatchObject({ gate: 'auto' });
    expect(byId.boom).toMatchObject({ status: 'failedContinue', failedItems: 1, outCount: 2 });          // 실패한 아이템도 _error 를 달고 흐른다

    expect(t.approvals).toHaveLength(1);
    apId = t.approvals[0].id;
    expect(t.approvals[0]).toMatchObject({ gate: 'auto', status: 'pending', executionId: execId, nodeId: 'send' });
    expect(t.approvals[0].flow).toBeUndefined();                                                          // 큰 데이터는 뺀다
    expect(t.resumedFrom).toBeNull();
    expect(t.children).toEqual([]);

    expect(t.deadLetters).toHaveLength(1);
    expect(t.deadLetters[0]).toMatchObject({ node_id: 'boom', execution_id: execId, error_msg: '환불 계산 실패', replay_status: 'pending' });
    expect(DLQ.forExecution(execId)).toHaveLength(1);
  });

  it('재개 실행: 위 노드는 주입, 발송만 실행 — 양쪽 추적이 서로를 가리킨다', async () => {
    const d = await decide(apId, { decision: 'approve', by: '@me' });
    expect(d.resumeStatus).toBe('done');
    resumedId = d.executionId;
    expect(sent).toHaveLength(2);                                                                        // 아이템 2개 발송

    const t2 = (await api('GET', `/api/executions/${resumedId}/trace`)).json;
    expect(t2.execution).toMatchObject({ id: resumedId, trigger: 'approval', status: 'success' });
    const byId = Object.fromEntries(t2.nodes.map((x) => [x.id, x]));
    expect(byId.t).toMatchObject({ injected: true, title: '수동 트리거' });                              // 이름은 원본 워크플로에서
    expect(byId.ai).toMatchObject({ injected: true });
    expect(byId.boom).toMatchObject({ injected: true });
    expect(byId.send).toMatchObject({ injected: false, status: 'done', attempts: 2, inCount: 2, outCount: 2 });
    expect(t2.resumedFrom).toMatchObject({ approvalId: apId, executionId: execId, gate: 'auto', decision: 'approve', by: '@me' });
    expect(t2.approvals).toEqual([]);
    expect(t2.deadLetters).toEqual([]);

    const t1 = (await api('GET', `/api/executions/${execId}/trace`)).json;
    expect(t1.children).toEqual([{ approvalId: apId, executionId: resumedId, decision: 'approve' }]);
    expect(t1.approvals[0]).toMatchObject({ status: 'approved', resumeStatus: 'done', resumedExecutionId: resumedId });
  });

  it('없는 실행은 404', async () => {
    expect((await api('GET', '/api/executions/ex_nope/trace')).status).toBe(404);
  });

  it('캔버스 스트리밍 실행도 같은 기록을 남긴다 (id 선발급 · 시간 · 시도 · 승인 요청 전송)', async () => {
    const before = Executions.all().length;
    const body = { name: '(캔버스)', nodes: flow.nodes, edges: flow.edges };
    const r = await fetch(`${base}/api/run/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    expect(text).toContain('"type":"done"');
    expect(Executions.all().length).toBe(before + 1);
    const ex = Executions.all()[0];
    expect(ex.id).toMatch(/^ex_/);
    expect(ex.status).toBe('waiting');
    expect(typeof ex.durationMs).toBe('number');
    expect(ex.statuses.ai.attempts).toBe(2);
    const t = (await api('GET', `/api/executions/${ex.id}/trace`)).json;
    expect(t.approvals).toHaveLength(1);
    expect(t.approvals[0]).toMatchObject({ status: 'pending', executionId: ex.id, gate: 'auto' });
    expect(t.nodes.find((x) => x.id === 'send').title).toBe('텔레그램 메시지');                           // 저장 안 된 워크플로라 승인 기록의 flow 에서 이름을 찾는다
    expect(t.deadLetters).toHaveLength(1);
  });
});

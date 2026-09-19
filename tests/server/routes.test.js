// 서버 라우트 통합 테스트 — 실제 HTTP 요청으로 저장·실행·웹훅·MCP·DLQ 흐름을 고정한다.
// 데이터는 임시 폴더(CONDUIT_DATA_DIR)에 쓰므로 실제 server/data 를 건드리지 않는다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-test-'));
process.env.CONDUIT_DATA_DIR = dataDir;
const { app } = await import('../../server/index.js'); // 환경변수를 먼저 설정한 뒤 불러온다

const KEY = 'routes-test-key';
let server;
let base;

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.CONDUIT_API_KEY = KEY;
  delete process.env.CONDUIT_ALLOW_CODE;
});

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---- 워크플로 조립 ----
const n = (id, kind, params = {}) => ({ id, data: { kind, params } });
const e = (source, target, sourceHandle) => ({ id: `e_${source}_${target}`, source, target, sourceHandle });
const orderFlow = (extra = {}) => ({
  name: '주문 분류',
  nodes: [
    n('t', 'manualTrigger', { json: JSON.stringify([{ amount: 42000 }, { amount: 8000 }]) }),
    n('if', 'ifNode', { field: 'amount', op: '>', value: '30000' }),
    n('vip', 'output'),
  ],
  edges: [e('t', 'if'), e('if', 'vip', 'true')],
  ...extra,
});

describe('워크플로 CRUD + 실행 기록', () => {
  it('저장 → 목록 → 조회 → 실행 → 실행 기록 → 삭제', async () => {
    const saved = await api('POST', '/api/workflows', orderFlow());
    expect(saved.status).toBe(200);
    const id = saved.body.id;
    expect(id).toBeTruthy();

    const list = await api('GET', '/api/workflows');
    expect(list.body.find((w) => w.id === id)).toMatchObject({ name: '주문 분류', nodeCount: 3 });

    expect((await api('GET', `/api/workflows/${id}`)).body.nodes).toHaveLength(3);

    const run = await api('POST', `/api/workflows/${id}/run`);
    expect(run.body.execution.status).toBe('success');
    expect(run.body.outputs.vip.main).toEqual([{ amount: 42000 }]);

    const execs = await api('GET', `/api/executions?workflowId=${id}`);
    expect(execs.body[0]).toMatchObject({ workflowId: id, status: 'success', trigger: 'manual' });

    expect((await api('DELETE', `/api/workflows/${id}`)).status).toBe(200);
    expect((await api('GET', `/api/workflows/${id}`)).status).toBe(404);
  });

  it('저장하지 않은 캔버스도 바로 실행할 수 있다', async () => {
    const run = await api('POST', '/api/run', orderFlow());
    expect(run.body.outputs.vip.main).toEqual([{ amount: 42000 }]);
  });
});

describe('서버 코드 실행 정책', () => {
  const codeFlow = {
    nodes: [n('t', 'manualTrigger', { json: '{"n":2}' }), n('c', 'code', { code: 'return { n: input.n * 10 };' })],
    edges: [e('t', 'c')],
  };

  it('키가 있는 서버는 기본적으로 코드 노드를 막는다', async () => {
    const run = await api('POST', '/api/run', codeFlow);
    expect(run.body.statuses.c.status).toBe('error');
    expect(run.body.statuses.c.error).toMatch(/코드 실행이 꺼져/);
  });

  it('CONDUIT_ALLOW_CODE=true 면 실행한다', async () => {
    process.env.CONDUIT_ALLOW_CODE = 'true';
    const run = await api('POST', '/api/run', codeFlow);
    expect(run.body.outputs.c.main).toEqual([{ n: 20 }]);
  });
});

describe('웹훅 — 서명 검증과 중복 방지', () => {
  const secret = 'whsec-test';
  const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const hook = (raw, headers = {}) => fetch(base + '/webhook/new-order', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });

  beforeAll(async () => {
    await api('POST', '/api/credentials', { name: 'shop-secret', type: 'webhook', data: { secret } });
    await api('POST', '/api/workflows', {
      name: '주문 웹훅',
      active: true,
      nodes: [
        n('w', 'webhookTrigger', { path: '/new-order', signature: 'generic', secretCred: 'shop-secret' }),
        n('out', 'output'),
      ],
      edges: [e('w', 'out')],
    });
  });

  it('서명이 없거나 틀리면 401 — API 키 없이 부르는 공개 입구지만 아무나 실행할 수는 없다', async () => {
    const raw = JSON.stringify({ id: 'order-1', amount: 42000 });
    expect((await hook(raw)).status).toBe(401);
    expect((await hook(raw, { 'X-Signature': 'sha256=deadbeef' })).status).toBe(401);
  });

  it('맞는 서명이면 실행하고, 같은 이벤트가 다시 오면 실행하지 않는다', async () => {
    const raw = JSON.stringify({ id: 'order-2', amount: 42000 });
    const first = await hook(raw, { 'X-Signature': sign(raw) });
    expect(first.status).toBe(200);
    expect((await first.json()).executionId).toBeTruthy();

    const again = await (await hook(raw, { 'X-Signature': sign(raw) })).json();
    expect(again).toMatchObject({ received: true, deduped: true });
  });

  it('등록되지 않은 경로는 404', async () => {
    const r = await fetch(base + '/webhook/unknown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(404);
  });
});

describe('MCP 서버 — 워크플로가 도구가 된다', () => {
  let id;
  beforeAll(async () => { id = (await api('POST', '/api/workflows', orderFlow({ name: 'MCP 주문 분류' }))).body.id; });

  const rpc = (method, params) => api('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params });

  it('tools/list 에 run_<id> 로 노출', async () => {
    const r = await rpc('tools/list');
    expect(r.body.result.tools.map((t) => t.name)).toContain(`run_${id}`);
  });

  it('tools/call 로 실행하고 출력 노드 결과를 돌려준다', async () => {
    const r = await rpc('tools/call', { name: `run_${id}`, arguments: { input: [{ amount: 99000 }, { amount: 100 }] } });
    expect(r.body.result.isError).toBe(false);
    expect(JSON.parse(r.body.result.content[0].text)).toEqual({ amount: 99000 });
  });

  it('없는 워크플로는 JSON-RPC 오류', async () => {
    expect((await rpc('tools/call', { name: 'run_nope' })).body.error.code).toBe(-32602);
  });
});

describe('실패 큐 (DLQ)', () => {
  it('실패한 아이템이 DLQ 에 쌓이고 조회된다', async () => {
    process.env.CONDUIT_ALLOW_CODE = 'true';
    await api('POST', '/api/run', {
      nodes: [
        n('t', 'manualTrigger', { json: JSON.stringify([{ ok: 1 }, { bad: true }]) }),
        n('c', 'code', { code: "if (input.bad) throw new Error('boom'); return input;", _continueOnFail: true }),
      ],
      edges: [e('t', 'c')],
    });
    const dlq = await api('GET', '/api/dlq');
    expect(dlq.body.some((r) => (r.error_msg || r.errorMsg) === 'boom')).toBe(true);
  });
});

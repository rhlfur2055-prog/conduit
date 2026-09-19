import { describe, it, expect } from 'vitest';
import { createConduitClient, ConduitError } from '../src/conduit.js';

// fetch 를 흉내 내는 헬퍼 — 상태 코드와 본문만 정하면 된다
const respond = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('createConduitClient — 오류를 사람이 고칠 수 있는 메시지로 바꾼다', () => {
  it('URL 끝의 슬래시는 정리한다', () => {
    expect(createConduitClient({ url: 'http://x:1/' }).base).toBe('http://x:1');
  });

  it('연결 실패 → 서버 주소와 확인할 것을 알려 준다', async () => {
    const c = createConduitClient({
      url: 'http://127.0.0.1:1',
      fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
    });
    await expect(c.rpc('tools/list')).rejects.toThrow(/연결할 수 없습니다: http:\/\/127\.0\.0\.1:1 \(ECONNREFUSED\)/);
    await expect(c.rpc('tools/list')).rejects.toThrow(/CONDUIT_URL/);
  });

  it('401·403 → CONDUIT_API_KEY 안내', async () => {
    const c = createConduitClient({ fetchImpl: respond(401, { error: 'API 키가 필요합니다.' }) });
    const err = await c.rpc('tools/list').catch((e) => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/API 키가 필요합니다/);
    expect(err.message).toMatch(/CONDUIT_API_KEY/);
  });

  it('JSON-RPC error 는 예외로, result 는 그대로', async () => {
    const bad = createConduitClient({ fetchImpl: respond(200, { jsonrpc: '2.0', id: 1, error: { code: -32602, message: '워크플로를 찾을 수 없습니다: run_x' } }) });
    const err = await bad.rpc('tools/call', { name: 'run_x' }).catch((e) => e);
    expect(err.code).toBe(-32602);
    expect(err.message).toMatch(/run_x/);

    const good = createConduitClient({ fetchImpl: respond(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'run_a' }] } }) });
    expect(await good.rpc('tools/list')).toEqual({ tools: [{ name: 'run_a' }] });
  });

  it('API 키가 있으면 Authorization 헤더를 붙이고, 요청마다 id 가 증가한다', async () => {
    const seen = [];
    const c = createConduitClient({
      url: 'http://x',
      apiKey: 'k1',
      fetchImpl: async (url, init) => { seen.push({ url, init }); return respond(200, { result: {} })(); },
    });
    await c.rpc('tools/list');
    await c.rpc('tools/list');
    expect(seen[0].url).toBe('http://x/mcp');
    expect(seen[0].init.headers.Authorization).toBe('Bearer k1');
    expect(JSON.parse(seen[0].init.body).id).toBe(1);
    expect(JSON.parse(seen[1].init.body).id).toBe(2);
  });

  it('키가 없으면 Authorization 헤더를 보내지 않는다', async () => {
    let init;
    const c = createConduitClient({ fetchImpl: async (_u, i) => { init = i; return respond(200, { result: {} })(); } });
    await c.rpc('tools/list');
    expect(init.headers.Authorization).toBeUndefined();
  });
});

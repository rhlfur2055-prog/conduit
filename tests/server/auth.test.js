import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { isLoopback, extractKey, safeEqual, requireApiKey } from '../../server/auth.js';
import { app } from '../../server/index.js';

// ---- 단위: 요청 판별 ----
const fakeReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

describe('isLoopback — 이 컴퓨터에서 직접 온 요청인가', () => {
  it('IPv4·IPv6·IPv4-mapped 루프백', () => {
    expect(isLoopback(fakeReq('127.0.0.1'))).toBe(true);
    expect(isLoopback(fakeReq('::1'))).toBe(true);
    expect(isLoopback(fakeReq('::ffff:127.0.0.1'))).toBe(true);
  });

  it('외부 주소(도커 브리지 포함)는 아니다', () => {
    expect(isLoopback(fakeReq('172.17.0.1'))).toBe(false);
    expect(isLoopback(fakeReq('203.0.113.7'))).toBe(false);
  });

  it('같은 서버의 프록시를 거친 요청(X-Forwarded-For)은 로컬로 치지 않는다', () => {
    expect(isLoopback(fakeReq('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }))).toBe(false);
  });
});

describe('extractKey / safeEqual', () => {
  it('Bearer 토큰을 우선, 없으면 X-API-Key', () => {
    expect(extractKey(fakeReq('::1', { authorization: 'Bearer abc' }))).toBe('abc');
    expect(extractKey(fakeReq('::1', { authorization: 'bearer   abc  ' }))).toBe('abc');
    expect(extractKey(fakeReq('::1', { 'x-api-key': 'xyz' }))).toBe('xyz');
    expect(extractKey(fakeReq('::1', { authorization: 'Basic abc', 'x-api-key': 'xyz' }))).toBe('xyz');
    expect(extractKey(fakeReq('::1'))).toBe('');
  });

  it('같은 값만 true — 길이가 달라도 예외 없이 false', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret-but-longer')).toBe(false);
  });
});

describe('requireApiKey — 외부 요청 처리 (가짜 응답 객체)', () => {
  const run = (mw, req) => {
    const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
    let passed = false;
    mw(req, res, () => { passed = true; });
    return { passed, res };
  };

  it('키가 없으면 외부 요청은 403', () => {
    const { passed, res } = run(requireApiKey({ getKey: () => '' }), fakeReq('172.17.0.1'));
    expect(passed).toBe(false);
    expect(res.code).toBe(403);
  });

  it('키가 있으면 외부 요청도 맞는 키로 통과', () => {
    const mw = requireApiKey({ getKey: () => 'k1' });
    expect(run(mw, fakeReq('172.17.0.1', { 'x-api-key': 'k1' })).passed).toBe(true);
    const denied = run(mw, fakeReq('172.17.0.1', { 'x-api-key': 'nope' }));
    expect(denied.passed).toBe(false);
    expect(denied.res.code).toBe(401);
    expect(denied.res.headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('키가 설정되면 로컬 요청도 키가 있어야 한다', () => {
    expect(run(requireApiKey({ getKey: () => 'k1' }), fakeReq('127.0.0.1')).res.code).toBe(401);
  });
});

// ---- 통합: 실제 서버에 HTTP 요청 ----
describe('서버 라우트 보호 (실제 HTTP)', () => {
  let server;
  let base;
  const original = process.env.CONDUIT_API_KEY;

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  afterEach(() => {
    if (original === undefined) delete process.env.CONDUIT_API_KEY;
    else process.env.CONDUIT_API_KEY = original;
  });

  const get = (p, headers = {}) => fetch(base + p, { headers });
  const mcpInit = (headers = {}) => fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  });

  it('헬스체크는 키 없이도 열려 있고 인증 방식·코드 실행 여부를 알려 준다', async () => {
    process.env.CONDUIT_API_KEY = 'test-key';
    const r = await get('/api/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ auth: 'api-key', code: 'off' });

    process.env.CONDUIT_ALLOW_CODE = 'true';
    expect((await (await get('/api/health')).json()).code).toBe('on');
    delete process.env.CONDUIT_ALLOW_CODE;
  });

  it('키가 설정되면 /api 는 키 없이 401, 틀린 키 401, 맞는 키 200', async () => {
    process.env.CONDUIT_API_KEY = 'test-key';
    expect((await get('/api/workflows')).status).toBe(401);
    expect((await get('/api/workflows', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get('/api/workflows', { Authorization: 'Bearer test-key' })).status).toBe(200);
    expect((await get('/api/workflows', { 'X-API-Key': 'test-key' })).status).toBe(200);
  });

  it('MCP 입구도 같은 키로 보호된다', async () => {
    process.env.CONDUIT_API_KEY = 'test-key';
    expect((await mcpInit()).status).toBe(401);
    const ok = await mcpInit({ Authorization: 'Bearer test-key' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).result.serverInfo.name).toBe('conduit');
  });

  it('키가 없으면 로컬 요청은 통과, 프록시를 거친 요청은 403', async () => {
    delete process.env.CONDUIT_API_KEY;
    expect((await get('/api/workflows')).status).toBe(200);
    expect((await get('/api/workflows', { 'X-Forwarded-For': '203.0.113.7' })).status).toBe(403);
    expect((await get('/api/health')).status).toBe(200);
  });

  it('웹훅은 인증 대상이 아니다 (노드별 서명 검증으로 보호)', async () => {
    process.env.CONDUIT_API_KEY = 'test-key';
    const r = await fetch(base + '/webhook/__no_such_hook__', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(404);
  });
});

// 서버를 진짜로 죽였다 살린다 — 승인 게이트의 "죽어도 그대로" 약속을 프로세스 단위로 검증한다.
//
//   1) 서버 A 기동 → 승인 노드가 있는 워크플로 저장·실행 → 대기(pending)
//   2) 승인 결정 → 재개가 느린 노드(delay)에서 도는 동안 서버 A 를 SIGKILL
//   3) 같은 데이터 폴더로 서버 B 기동 → 기동 정리가 "재개 도중 종료" 로 표시했는지
//   4) 같은 결정을 다시 보내면 already (멱등) · 🔁 재시도 → 아래 노드만 실행되고 위 노드는 주입(재실행 아님)
//
// 텔레그램은 이 파일 안의 가짜 Bot API 서버가 받는다. 데이터는 임시 폴더에 쓴다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-crash-'));
const BOT_TOKEN = '123456789:AAcrash-test-token';
const CHAT = '123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 가짜 텔레그램 (보낸 메시지만 기록) ---------- */
const tgSent = [];
let msgId = 100;
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const tg = http.createServer(async (req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const m = /^\/bot([^/]+)\/(.+)$/.exec(req.url.split('?')[0]);
  if (!m) { res.writeHead(404); return res.end(); }
  const body = JSON.parse((await readBody(req)) || '{}');
  switch (m[2]) {
    case 'getMe': return json({ ok: true, result: { id: 1, is_bot: true, first_name: 'crash', username: 'crash_bot' } });
    case 'getUpdates': await sleep(300); return json({ ok: true, result: [] });
    case 'sendMessage': tgSent.push(body); return json({ ok: true, result: { message_id: ++msgId, chat: { id: body.chat_id } } });
    default: return json({ ok: true, result: true });
  }
});

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

/* ---------- 서버 프로세스 ---------- */
let tgPort, port, child, base;
const api = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function startServer() {
  const env = {
    ...process.env, PORT: String(port), CONDUIT_DATA_DIR: dataDir,
    TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT,
    ANTHROPIC_API_KEY: '', CONDUIT_API_KEY: '', CONDUIT_HEARTBEAT: '', CONDUIT_LLM_AUTODETECT: 'off',
  };
  const c = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  c.out = '';
  c.stdout.on('data', (d) => (c.out += d));
  c.stderr.on('data', (d) => (c.out += d));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/api/health`)).ok) return c; } catch { /* 아직 */ }
    await sleep(150);
  }
  throw new Error(`서버가 뜨지 않음:\n${c.out}`);
}
const killed = (c) => new Promise((r) => { c.once('exit', r); c.kill('SIGKILL'); });
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('until: 시간 초과'); await sleep(100); } };

beforeAll(async () => {
  tgPort = await freePort();
  await new Promise((r) => tg.listen(tgPort, '127.0.0.1', r));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = await startServer();
}, 30000);
afterAll(async () => {
  if (child && child.exitCode === null) await killed(child);
  await new Promise((r) => tg.close(r));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 윈도우: 아직 잡힌 핸들 */ }
});

const n = (id, kind, params = {}) => ({ id, data: { kind, params } });
const e = (source, target, sourceHandle = 'main') => ({ id: `e_${source}_${target}_${sourceHandle}`, source, target, sourceHandle, targetHandle: 'main' });
const flow = {
  name: '크래시 승인 데모',
  nodes: [
    n('t', 'manualTrigger', { json: JSON.stringify({ name: '김민수', draft: '초안' }) }),
    n('g', 'approvalRequest', { channel: 'telegram', chatId: CHAT, title: '승인: {{ $json.name }}', text: '{{ $json.draft }}', remindAfterMin: 60, expireAfterMin: 1440 }),
    n('slow', 'delay', { ms: '2500' }),                       // 재개가 여기서 도는 동안 서버를 죽인다
    n('a', 'setFields', { json: '{"sent": true}' }),
  ],
  edges: [e('t', 'g'), e('g', 'slow', 'approved'), e('slow', 'a')],
};

describe('서버를 죽였다 살려도 승인 게이트는 그대로', () => {
  let wfId, apId;

  it('승인 대기까지 간다', async () => {
    const saved = await api('POST', '/api/workflows', flow);
    expect(saved.status).toBe(200);
    wfId = saved.json.id;
    const run = await api('POST', `/api/workflows/${wfId}/run`);
    expect(run.json.statuses.g.status).toBe('waiting');
    expect(run.json.statuses.a.status).toBe('skip');
    const pending = await api('GET', '/api/approvals?status=pending');
    expect(pending.json).toHaveLength(1);
    apId = pending.json[0].id;
    expect(tgSent).toHaveLength(1);                            // 승인 요청 메시지 1건
  }, 20000);

  it('재개 도중 SIGKILL → 재기동 → "재개 도중 서버가 종료됨" 으로 남고 결정은 잃지 않는다', async () => {
    // 결정을 보내되 기다리지 않는다 — 재개가 delay 노드에서 2.5초 돈다
    const deciding = fetch(`${base}/api/approvals/${apId}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }).catch(() => null);
    const mid = await until(async () => { const r = await api('GET', `/api/approvals/${apId}`); return r.json?.resumeStatus === 'resuming' ? r.json : null; });
    expect(mid).toMatchObject({ status: 'approved', decision: 'approve', resumeStatus: 'resuming' });

    await killed(child);                                       // 재개 한가운데서 죽인다
    await deciding;
    const before = fs.existsSync(path.join(dataDir, 'conduit.db'));
    expect(before).toBe(true);

    child = await startServer();                               // 같은 데이터 폴더로 재기동
    const after = await api('GET', `/api/approvals/${apId}`);
    expect(after.json).toMatchObject({ status: 'approved', decision: 'approve', resumeStatus: 'error' });
    expect(after.json.resumeError).toContain('재개 도중 서버가 종료됨');
    expect(after.json.flow).toBeTruthy();                      // 재시도용 데이터는 남아 있다
    expect(child.out).toContain('재개 중단 1건');

    const execs = await api('GET', '/api/executions');
    expect(execs.json.filter((x) => x.trigger === 'approval')).toHaveLength(0);   // 반쪽 실행 기록은 없다
  }, 40000);

  it('같은 결정을 다시 보내면 already (멱등) — 두 번째 재개는 시작되지 않는다', async () => {
    const again = await api('POST', `/api/approvals/${apId}/decide`, { decision: 'approve' });
    expect(again.json).toMatchObject({ ok: true, already: true, status: 'approved', resumeStatus: 'error' });
  });

  it('🔁 재시도 → 아래 노드만 실행되고 위 노드는 주입된다', async () => {
    const retry = await api('POST', `/api/approvals/${apId}/retry`);
    expect(retry.json).toMatchObject({ ok: true, status: 'approved', resumeStatus: 'done' });
    const execs = await api('GET', '/api/executions');
    const resumed = execs.json.find((x) => x.id === retry.json.executionId);
    expect(resumed.trigger).toBe('approval');
    expect(resumed.statuses.t.status).toBe('done');
    expect(resumed.statuses.a.status).toBe('done');
    expect(resumed.logs.some((l) => l.msg.includes('주입'))).toBe(true);           // t · g 는 주입, 재실행 아님
    expect(resumed.logs.filter((l) => l.msg.includes('수동 트리거') && l.msg.includes('입력 →'))).toHaveLength(0);
    const done = await api('GET', `/api/approvals/${apId}`);
    expect(done.json).toMatchObject({ resumeStatus: 'done', resumedExecutionId: retry.json.executionId });
    expect((await api('POST', `/api/approvals/${apId}/retry`)).json).toMatchObject({ ok: true, already: true });
  }, 20000);
});

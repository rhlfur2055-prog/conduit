// 사람 승인 게이트 — 서버 쪽: preparing → (실행 종료) 스냅샷 확정 + 메시지 → pending → 결정(멱등) → seed 재개 → 실패 알림/재시도 → 리마인드/만료.
// 텔레그램은 가짜 어댑터로 바꿔 실제 API 를 부르지 않는다. 데이터는 임시 폴더에 쓴다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-approval-'));
process.env.CONDUIT_DATA_DIR = dataDir;
delete process.env.CONDUIT_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

const { app } = await import('../../server/index.js');             // 브리지 설치
const { execute } = await import('../../server/runtime.js');
const { setApprovalAdapter, decide, retryResume, tick, recoverAtBoot } = await import('../../server/approvals.js');
const { Approvals, Executions, closeDb } = await import('../../server/store.js');

// 가짜 텔레그램 — 보낸 것만 기록한다
const fake = { sent: [], decided: [], reminded: [], ready: true, failSend: false, failRemind: false };
setApprovalAdapter('telegram', {
  ready: () => fake.ready,
  defaultChat: () => '123',
  send: async (a) => { if (fake.failSend) throw new Error('네트워크'); fake.sent.push(a); return { messageId: 100 + fake.sent.length, chatId: a.chatId }; },
  decided: async (a) => { fake.decided.push(a); },
  remind: async (a) => { if (fake.failRemind) throw new Error('리마인드 실패'); fake.reminded.push(a); },
});

const n = (id, kind, params = {}) => ({ id, data: { kind, params } });
const e = (source, target, sourceHandle, targetHandle = 'main') => ({ id: `e_${source}_${target}_${sourceHandle || 'main'}`, source, target, sourceHandle, targetHandle });
const gate = (id, params = {}) => n(id, 'approvalRequest', { channel: 'telegram', chatId: '', title: '승인: {{ $json.name }}', text: '{{ $json.draft }}', remindAfterMin: 60, expireAfterMin: 1440, ...params });
const flow = (gateParams = {}) => ({
  id: 'wf_gate', name: '문의 승인 데모',
  nodes: [
    n('t', 'manualTrigger', { json: JSON.stringify({ name: '김민수', draft: '오늘 구리 시세는 kg당 9,800원입니다.' }) }),
    gate('g', gateParams),
    n('a', 'setFields', { json: '{"sent": true}' }),
    n('r', 'setFields', { json: '{"rejected": true}' }),
    n('x', 'setFields', { json: '{"expired": true}' }),
    n('side', 'setFields', { json: '{"logged": true}' }),
  ],
  edges: [e('t', 'g'), e('g', 'a', 'approved'), e('g', 'r', 'rejected'), e('g', 'x', 'expired'), e('t', 'side')],
});
const lastExec = (id) => Executions.all().find((x) => x.id === id);

let server, base;
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  closeDb();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 윈도우: 아직 잡힌 핸들 */ }
});
beforeEach(() => {
  fake.sent.length = 0; fake.decided.length = 0; fake.reminded.length = 0;
  fake.ready = true; fake.failSend = false; fake.failRemind = false;
  Approvals.clearAll();                                              // 테스트마다 빈 저장소
});

describe('승인 요청 (멈춤)', () => {
  it('실행이 끝난 뒤에 스냅샷이 확정되고 메시지가 나간다 — 승인 뒤에 돈 가지(side)도 스냅샷에 든다', async () => {
    const r = await execute(flow(), { trigger: 'manual' });
    expect(r.statuses.g.status).toBe('waiting');
    expect(r.statuses.a.status).toBe('skip');
    expect(r.statuses.side.status).toBe('done');
    expect(r.execution.status).toBe('waiting');
    expect(r.logs.some((l) => l.msg.includes('승인 요청 전송'))).toBe(true);

    const [rec] = Approvals.pending();
    expect(rec).toMatchObject({ status: 'pending', channel: 'telegram', chatId: '123', title: '승인: 김민수', nodeId: 'g', workflowId: 'wf_gate', messageId: 101 });
    expect(rec.text).toContain('9,800원');
    expect(Object.keys(rec.snapshot).sort()).toEqual(['side', 't']);   // 승인 노드 자신은 제외, 그 뒤에 돈 side 포함
    expect(rec.flow.nodes.map((x) => x.id)).toContain('a');
    expect(fake.sent[0]).toMatchObject({ chatId: '123', approvalId: rec.id, title: '승인: 김민수', workflowName: '문의 승인 데모' });
  });

  it('채널이 준비되지 않았으면 조용히 통과하지 않고 노드 오류가 난다', async () => {
    fake.ready = false;
    const r = await execute(flow(), { trigger: 'manual' });
    expect(r.statuses.g.status).toBe('error');
    expect(r.statuses.g.error).toContain('설정되지 않았습니다');
    expect(r.statuses.a.status).toBe('skip');
    expect(Approvals.pending()).toHaveLength(0);
  });

  it('메시지 전송이 실패하면 실행이 오류가 되고 기록은 failed 로 남는다 (대기 상태로 남지 않음)', async () => {
    fake.failSend = true;
    const r = await execute(flow(), { trigger: 'manual' });
    expect(r.statuses.g.status).toBe('error');
    expect(r.statuses.g.error).toContain('승인 요청 전송 실패');
    expect(r.execution.status).toBe('error');
    expect(Approvals.all()[0].status).toBe('failed');
    expect(Approvals.pending()).toHaveLength(0);
  });

  it('빈 문자열·0 분은 기본값(60/1440)으로 — "0분 뒤 만료" 사고를 막는다', async () => {
    await execute(flow({ remindAfterMin: '', expireAfterMin: 0 }), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    const created = Date.parse(rec.createdAt);
    expect(Math.round((Date.parse(rec.remindAt) - created) / 60000)).toBe(60);
    expect(Math.round((Date.parse(rec.expireAt) - created) / 60000)).toBe(1440);
  });

  it('다른 가지가 실패해도 스냅샷은 확정되고, 실패한 노드는 재개 때 다시 실행되지 않는다', async () => {
    const f = flow();
    f.nodes.push(n('boom', 'stopError', { message: '기록 실패' }));
    f.edges.push(e('t', 'boom'));
    const r = await execute(f, { trigger: 'manual' });
    expect(r.statuses.boom.status).toBe('error');
    const rec = Approvals.pending()[0];
    expect(rec.snapshot.boom).toEqual({});                          // 빈 출력으로 주입 → 재실행 안 함
    const d = await decide(rec.id, { decision: 'approve' });
    const resumed = lastExec(d.executionId);
    expect(resumed.statuses.boom.status).toBe('done');              // seed 주입, 재실행 아님
    expect(resumed.statuses.a.status).toBe('done');
  });

  it('승인 노드가 둘이면 하나를 승인해도 다른 승인이 다시 요청되지 않는다', async () => {
    const f = flow();
    f.nodes.push(gate('g2', { title: '두 번째' }), n('b', 'setFields', { json: '{"b": true}' }));
    f.edges.push(e('t', 'g2'), e('g2', 'b', 'approved'));
    await execute(f, { trigger: 'manual' });
    expect(Approvals.pending()).toHaveLength(2);
    const first = Approvals.pending().find((x) => x.nodeId === 'g');
    expect(first.snapshot.g2).toEqual({});
    const d = await decide(first.id, { decision: 'approve' });
    expect(lastExec(d.executionId).statuses.g2.status).toBe('done'); // 주입됨, 새 요청 없음
    expect(lastExec(d.executionId).statuses.b.status).toBe('skip');
    expect(Approvals.pending()).toHaveLength(1);
    expect(fake.sent).toHaveLength(2);
  });
});

describe('결정 → 재개', () => {
  it('승인하면 approved 포트 아래만 실행되고, 위 노드는 재실행되지 않는다', async () => {
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    const before = Executions.all().length;

    const d = await decide(rec.id, { decision: 'approve', by: '@tester' });
    expect(d).toMatchObject({ ok: true, status: 'approved', resumeStatus: 'done' });
    expect(Executions.all().length).toBe(before + 1);

    const resumed = lastExec(d.executionId);
    expect(resumed.trigger).toBe('approval');
    expect(resumed.status).toBe('success');
    expect(resumed.statuses.t.status).toBe('done');
    expect(resumed.statuses.side.status).toBe('done');
    expect(resumed.statuses.a.status).toBe('done');
    expect(resumed.statuses.r.status).toBe('skip');
    expect(resumed.statuses.x.status).toBe('skip');
    expect(resumed.statuses.a.output.main[0]).toMatchObject({ name: '김민수', sent: true, approval: { decision: 'approve', by: '@tester', edited: false } });
    expect(fake.decided[0]).toMatchObject({ chatId: '123', messageId: rec.messageId, decision: 'approve', resumeOk: true });
    const done = Approvals.get(rec.id);
    expect(done).toMatchObject({ status: 'approved', resumedExecutionId: d.executionId, resumeStatus: 'done' });
    expect(done.flow).toBeUndefined();                                // 성공하면 큰 데이터는 버린다
    expect(done.snapshot).toBeUndefined();
  });

  it('같은 결정을 두 번 보내도 한 번만 재개한다 (멱등)', async () => {
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    await decide(rec.id, { decision: 'approve' });
    const count = Executions.all().length;
    const again = await decide(rec.id, { decision: 'reject' });
    expect(again).toMatchObject({ ok: true, already: true, status: 'approved' });
    expect(Executions.all().length).toBe(count);
  });

  it('아직 준비 중(preparing)이면 결정을 받지 않는다', async () => {
    const rec = Approvals.add({ status: 'preparing', channel: 'telegram', chatId: '123', nodeId: 'g', flow: { nodes: [], edges: [] } });
    expect(await decide(rec.id, { decision: 'approve' })).toMatchObject({ ok: false, error: expect.stringContaining('준비 중') });
    expect(Approvals.get(rec.id).status).toBe('preparing');
  });

  it('수정해서 승인하면 approval.text 가 수정본이 된다', async () => {
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    const d = await decide(rec.id, { decision: 'approve', editedText: '내일 오전에 연락드리겠습니다.', by: '@tester' });
    expect(lastExec(d.executionId).statuses.a.output.main[0].approval).toMatchObject({ text: '내일 오전에 연락드리겠습니다.', edited: true });
    expect(fake.decided.at(-1).editedText).toBe('내일 오전에 연락드리겠습니다.');
  });

  it('거절하면 rejected 포트로만 흐른다', async () => {
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    const d = await decide(rec.id, { decision: 'reject' });
    expect(lastExec(d.executionId).statuses.a.status).toBe('skip');
    expect(lastExec(d.executionId).statuses.r.status).toBe('done');
  });

  it('요청을 보낸 채팅이 아니면 결정을 거부한다', async () => {
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    expect(await decide(rec.id, { decision: 'approve', fromChatId: '999' })).toMatchObject({ ok: false });
    expect(Approvals.get(rec.id).status).toBe('pending');
    expect(await decide(rec.id, { decision: 'approve', fromChatId: '123' })).toMatchObject({ ok: true });
  });

  it('없는 요청·알 수 없는 결정·프로토타입 키는 ok:false', async () => {
    expect(await decide('ap_nope', { decision: 'approve' })).toMatchObject({ ok: false });
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    expect(await decide(rec.id, { decision: 'maybe' })).toMatchObject({ ok: false });
    expect(await decide(rec.id, { decision: 'toString' })).toMatchObject({ ok: false });
    expect(Approvals.get(rec.id).status).toBe('pending');
  });

  it('재개 실행이 실패하면 사람에게 "승인됐지만 실패"를 알리고, 🔁 재시도할 수 있다', async () => {
    const f = flow();
    f.nodes.push(n('send', 'stopError', { message: '발송 API 401' }));
    f.edges.push(e('a', 'send'));
    await execute(f, { trigger: 'manual' });
    const rec = Approvals.pending()[0];

    const d = await decide(rec.id, { decision: 'approve', by: '@tester' });
    expect(d).toMatchObject({ ok: true, status: 'approved', resumeStatus: 'error' });
    expect(d.resumeError).toContain('발송 API 401');
    expect(fake.decided.at(-1)).toMatchObject({ decision: 'approve', resumeOk: false, resumeError: expect.stringContaining('401') });
    const after = Approvals.get(rec.id);
    expect(after.resumeStatus).toBe('error');
    expect(after.flow).toBeDefined();                                 // 재시도용으로 유지

    const retry = await retryResume(rec.id);
    expect(retry).toMatchObject({ ok: true, resumeStatus: 'error' });  // 같은 원인이면 또 실패 — 그래도 알린다
    expect(fake.decided).toHaveLength(2);
    expect(await retryResume('ap_nope')).toMatchObject({ ok: false });
  });

  it('결정 전에는 재시도할 수 없다', async () => {
    await execute(flow(), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    expect(await retryResume(rec.id)).toMatchObject({ ok: false });
  });
});

describe('리마인드 · 만료', () => {
  it('리마인드는 한 번만, 만료되면 expired 포트로 재개한다', async () => {
    await execute(flow({ remindAfterMin: 0.0001, expireAfterMin: 10 }), { trigger: 'manual' });
    const rec = Approvals.pending()[0];
    await new Promise((r) => setTimeout(r, 20));
    expect(await tick()).toMatchObject({ reminded: 1, expired: 0 });
    expect(await tick()).toMatchObject({ reminded: 0, expired: 0 });   // 두 번 알리지 않음
    expect(fake.reminded).toHaveLength(1);

    const later = Date.now() + 11 * 60000;
    expect(await tick(later)).toMatchObject({ expired: 1 });
    const done = Approvals.get(rec.id);
    expect(done.status).toBe('expired');
    const resumed = lastExec(done.resumedExecutionId);
    expect(resumed.statuses.x.status).toBe('done');
    expect(resumed.statuses.a.status).toBe('skip');
  });

  it('리마인드 전송이 실패하면 표시하지 않고 다음 점검에 다시 보낸다', async () => {
    await execute(flow({ remindAfterMin: 0.0001, expireAfterMin: 10 }), { trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 20));
    fake.failRemind = true;
    expect(await tick()).toMatchObject({ reminded: 0 });
    fake.failRemind = false;
    expect(await tick()).toMatchObject({ reminded: 1 });
  });
});

describe('기동 정리', () => {
  it('준비 중에 죽은 건은 failed, 재개 중에 죽은 건은 error 로 알린다', async () => {
    const p = Approvals.add({ status: 'preparing', channel: 'telegram', chatId: '123', nodeId: 'g', flow: { nodes: [], edges: [] } });
    const r = Approvals.add({ status: 'approved', channel: 'telegram', chatId: '123', messageId: 5, nodeId: 'g', decision: 'approve', by: '@t', resumeStatus: 'resuming', title: 'T', text: 'B' });
    const out = await recoverAtBoot();
    expect(out).toMatchObject({ failedPreparing: 1, interruptedResume: 1 });
    expect(Approvals.get(p.id).status).toBe('failed');
    expect(Approvals.get(r.id)).toMatchObject({ resumeStatus: 'error', resumeError: expect.stringContaining('종료') });
    expect(fake.decided.at(-1)).toMatchObject({ approvalId: r.id, resumeOk: false });
  });
});

describe('API', () => {
  const api = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null), cors: r.headers.get('access-control-allow-origin') };
  };
  it('대기 목록을 보여주고, API 로도 결정할 수 있다', async () => {
    await execute(flow(), { trigger: 'manual' });
    const list = await api('GET', '/api/approvals?status=pending');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body[0].snapshot).toBeUndefined();          // 목록은 가볍게
    const id = list.body[0].id;

    const one = await api('GET', `/api/approvals/${id}`);
    expect(one.body.flow.nodes.length).toBe(6);

    const d = await api('POST', `/api/approvals/${id}/decide`, { decision: 'approve' });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ ok: true, status: 'approved', resumeStatus: 'done' });
    const again = await api('POST', `/api/approvals/${id}/decide`, { decision: 'reject' });   // 이미 처리됨 → already
    expect(again.body).toMatchObject({ ok: true, already: true, status: 'approved' });
    expect((await api('POST', `/api/approvals/${id}/decide`, { decision: 'bogus' })).status).toBe(400);
    expect((await api('POST', '/api/approvals/ap_none/decide', { decision: 'approve' })).status).toBe(400);
  });

  it('남의 웹페이지(다른 출처)에서는 읽지도 결정하지도 못한다 — CORS 미허용 + Host 검사', async () => {
    const evil = await api('GET', '/api/approvals', undefined, { Origin: 'https://evil.example' });
    expect(evil.cors).toBeNull();                              // 브라우저가 응답을 못 읽는다
    const local = await api('GET', '/api/approvals', undefined, { Origin: 'http://localhost:5173' });
    expect(local.cors).toBe('http://localhost:5173');
    // fetch 는 Host 헤더를 못 바꾸므로 node:http 로 직접 보낸다 (DNS 리바인딩은 Host 가 공격자 도메인)
    const { port } = server.address();
    const rebind = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/approvals', headers: { Host: 'attacker.example' } }, (res) => resolve(res.statusCode)).on('error', reject);
    });
    expect(rebind).toBe(403);                                  // Host 가 로컬이 아니면 거부
  });
});

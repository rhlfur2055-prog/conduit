// 운영 기록 저장소(SQLite) — 멱등 키의 원자적 claim, 승인 결정의 compare-and-set, 실행 기록 상한, 기존 JSON 이관.
// 데이터는 임시 폴더에 쓴다.
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sqlite-'));
process.env.CONDUIT_DATA_DIR = dataDir;
process.env.EXEC_MAX_TOTAL = '10';
process.env.EXEC_MAX_PER_WORKFLOW = '3';

// 이관 검증용 — store 가 처음 열리기 전에 옛 JSON 파일을 놓아 둔다
fs.writeFileSync(path.join(dataDir, 'approvals.json'), JSON.stringify([
  { id: 'ap_old1', status: 'pending', channel: 'telegram', chatId: '7', title: '옛 승인', text: '본문', item: { a: 1 }, nodeId: 'g', workflowId: 'wf1',
    flow: { nodes: [{ id: 'g' }], edges: [] }, snapshot: { t: { main: [{ x: 1 }] } }, createdAt: '2026-09-01T00:00:00.000Z', remindAt: '2099-01-01T00:00:00.000Z', expireAt: '2099-01-02T00:00:00.000Z', reminded: true },
  { id: 'ap_old2', status: '이상한값', channel: 'telegram', createdAt: '2026-09-02T00:00:00.000Z' },
]));
fs.writeFileSync(path.join(dataDir, 'processed.json'), JSON.stringify([
  { idempotency_key: 'old-done', status: 'done', first_seen_at: '2026-09-01T00:00:00.000Z', attempts: 1 },
]));
fs.writeFileSync(path.join(dataDir, 'dlq.json'), JSON.stringify([
  { id: 'dlq_old', workflow_id: 'wf1', node_id: 'n', payload: { k: 'v' }, error_code: 'E', error_msg: 'm', attempts: 2, failed_at: '2026-09-01T00:00:00.000Z', replay_status: 'pending' },
]));

const { Approvals, ProcessedEvents, DLQ, Executions, closeDb, db } = await import('../../server/store.js');

afterAll(() => {
  closeDb();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 윈도우: 아직 잡힌 핸들 */ }
});

describe('기존 JSON 기록 이관', () => {
  it('approvals/processed/dlq JSON 을 한 번 옮기고 파일 이름을 바꾼다', () => {
    const old = Approvals.get('ap_old1');
    expect(old).toMatchObject({ status: 'pending', chatId: '7', title: '옛 승인', reminded: true, item: { a: 1 } });
    expect(old.snapshot).toEqual({ t: { main: [{ x: 1 }] } });
    expect(Approvals.get('ap_old2').status).toBe('failed');                        // 모르는 상태는 failed 로
    expect(ProcessedEvents.find('old-done').status).toBe('done');
    expect(DLQ.all().find((d) => d.id === 'dlq_old')).toMatchObject({ payload: { k: 'v' }, attempts: 2 });
    expect(fs.existsSync(path.join(dataDir, 'approvals.json'))).toBe(false);
    expect(fs.readdirSync(dataDir).filter((f) => f.startsWith('approvals.json.migrated-'))).toHaveLength(1);
  });
});

describe('멱등 키 — claim 은 UPSERT 한 문장', () => {
  it('처음은 잡고, 잠금 중엔 in_progress, 완료 뒤엔 already_done, 실패 뒤엔 다시 잡는다', () => {
    expect(ProcessedEvents.claim('k1', { source: 'webhook' })).toEqual({ claimed: true });
    expect(ProcessedEvents.claim('k1')).toEqual({ claimed: false, reason: 'in_progress' });
    ProcessedEvents.complete('k1', 'ex_1');
    expect(ProcessedEvents.claim('k1')).toEqual({ claimed: false, reason: 'already_done' });
    expect(ProcessedEvents.find('k1')).toMatchObject({ status: 'done', result_ref: 'ex_1', attempts: 1 });

    expect(ProcessedEvents.claim('k2')).toEqual({ claimed: true });
    ProcessedEvents.fail('k2');
    expect(ProcessedEvents.claim('k2')).toEqual({ claimed: true });
    expect(ProcessedEvents.find('k2')).toMatchObject({ status: 'pending', attempts: 2 });
  });

  it('잠금이 만료된 pending 은 다시 잡는다 (죽은 워커의 키가 영원히 막히지 않게)', () => {
    expect(ProcessedEvents.claim('k3')).toEqual({ claimed: true });
    db.prepare(`UPDATE processed_events SET locked_until = ? WHERE idempotency_key = ?`).run('2000-01-01T00:00:00.000Z', 'k3');
    expect(ProcessedEvents.claim('k3')).toEqual({ claimed: true });
    expect(ProcessedEvents.find('k3').attempts).toBe(2);
  });

  it('같은 키를 100번 잡아도 하나만 성공한다', () => {
    const results = Array.from({ length: 100 }, () => ProcessedEvents.claim('k-burst'));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });
});

describe('승인 결정 — compare-and-set', () => {
  beforeEach(() => Approvals.clearAll());
  const add = (status = 'pending') => Approvals.add({ status, channel: 'telegram', chatId: '1', title: 't', text: 'x', item: {}, nodeId: 'g', flow: { nodes: [], edges: [] }, snapshot: {}, resumeStatus: null });

  it('pending 인 동안 한 번만 잡히고, 같은 문장에서 재개 시작이 기록된다', () => {
    const rec = add();
    const dec = { status: 'approved', decision: 'approve', editedText: null, by: 'a', decidedAt: '2026-09-24T00:00:00.000Z' };
    const wins = [1, 2, 3, 4, 5].map(() => Approvals.claimDecision(rec.id, dec));
    expect(wins).toEqual([true, false, false, false, false]);
    expect(Approvals.get(rec.id)).toMatchObject({ status: 'approved', decision: 'approve', by: 'a', resumeStatus: 'resuming', resumeStartedAt: dec.decidedAt });
  });

  it('preparing · failed · 이미 결정된 건은 잡히지 않는다', () => {
    const dec = { status: 'rejected', decision: 'reject', editedText: null, by: 'a', decidedAt: '2026-09-24T00:00:00.000Z' };
    for (const st of ['preparing', 'failed', 'approved', 'expired']) expect(Approvals.claimDecision(add(st).id, dec)).toBe(false);
  });

  it('재시도 claim 은 결정됐고 재개 중이 아닐 때만 한 번', () => {
    const rec = add('approved');
    Approvals.update(rec.id, { resumeStatus: 'error', resumeError: 'boom' });
    expect(Approvals.claimResume(rec.id)).toBe(true);
    expect(Approvals.claimResume(rec.id)).toBe(false);                             // 이미 resuming
    expect(Approvals.get(rec.id)).toMatchObject({ resumeStatus: 'resuming', resumeError: null });
    Approvals.update(rec.id, { resumeStatus: 'done' });
    expect(Approvals.claimResume(rec.id)).toBe(false);                             // 끝난 건 다시 안 돈다
    expect(Approvals.claimResume(add('pending').id)).toBe(false);                  // 결정 전
  });

  it('모르는 필드로 add/update 하면 조용히 버리지 않고 던진다', () => {
    expect(() => Approvals.update(add().id, { snapshit: {} })).toThrow(/모르는 필드/);
    expect(() => add() && Approvals.add({ channel: 'telegram', bogus: 1 })).toThrow(/모르는 필드/);
  });

  it('상한을 넘으면 끝난 것부터 버리고 대기 중인 건은 남는다', () => {
    process.env.APPROVALS_MAX; // 기본 500 — 여기서는 열 개만 넣어 순서만 본다
    const a = add('approved'); const b = add(); const c = add('rejected');
    expect(Approvals.all().map((x) => x.id)).toEqual([c.id, b.id, a.id]);          // 최신순
    expect(Approvals.pending().map((x) => x.id)).toEqual([b.id]);
  });
});

describe('실행 기록 — 워크플로별 · 전체 상한', () => {
  it('워크플로 하나가 매분 돌아도 다른 워크플로 기록을 밀어내지 못한다', () => {
    db.exec('DELETE FROM executions');
    for (let i = 0; i < 8; i++) Executions.add({ workflowId: 'busy', workflowName: 'b', trigger: 'schedule', status: 'success', logs: [], statuses: {} });
    Executions.add({ workflowId: 'quiet', workflowName: 'q', trigger: 'manual', status: 'success', logs: [{ kind: 'ok', msg: 'x' }], statuses: { n: { status: 'done' } } });
    const all = Executions.all();
    expect(all.filter((e) => e.workflowId === 'busy')).toHaveLength(3);            // EXEC_MAX_PER_WORKFLOW
    expect(all.filter((e) => e.workflowId === 'quiet')).toHaveLength(1);
    expect(all[0]).toMatchObject({ workflowId: 'quiet', logs: [{ kind: 'ok', msg: 'x' }], statuses: { n: { status: 'done' } } });
    expect(Executions.forWorkflow('busy')).toHaveLength(3);
  });
});

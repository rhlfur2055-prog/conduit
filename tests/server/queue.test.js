// 작업 큐 — "같은 일은 한 워커만", "워커가 죽으면 다른 워커가 이어받는다", "같은 키는 큐에 한 번만".
//   앞부분은 한 프로세스 안에서 문장 단위로, 뒷부분은 진짜 워커 프로세스 두 개를 띄워 경쟁시키고 하나를 죽인다.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-queue-'));
process.env.CONDUIT_DATA_DIR = dataDir;
process.env.CONDUIT_WORKER = 'off';                     // 이 프로세스는 넣기만 한다 — 돌리는 건 시험 대상 워커
process.env.EXEC_MAX_PER_WORKFLOW = '1000';             // 실행 기록 상한이 개수 검증을 가리지 않게
delete process.env.CONDUIT_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

await import('../../server/index.js');                  // 브리지 설치
const { Workflows, Executions, ProcessedEvents, db, closeDb } = await import('../../server/store.js');
const { enqueue, claimNext, heartbeat, complete, fail, reapExpired, runJob, waitForJob, Jobs } = await import('../../server/queue.js');
const { enqueueScheduled } = await import('../../server/runtime.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (id, kind, params = {}) => ({ id, data: { kind, params } });
const e = (source, target) => ({ id: `e_${source}_${target}`, source, target, sourceHandle: 'main', targetHandle: 'main' });
const quick = Workflows.save({ name: '빠른 일', active: true, nodes: [n('t', 'manualTrigger', { json: '{}' }), n('c', 'code', { code: 'return { ok: true };' })], edges: [e('t', 'c')] });
const slow = Workflows.save({ name: '느린 일', active: true, nodes: [n('t', 'manualTrigger', { json: '{}' }), n('d', 'delay', { ms: '2500' }), n('c', 'code', { code: 'return { ok: true };' })], edges: [e('t', 'd'), e('d', 'c')] });
const broken = Workflows.save({ name: '터지는 일', active: true, nodes: [n('t', 'manualTrigger', { json: '{}' }), n('x', 'stopError', { message: '일부러' })], edges: [e('t', 'x')] });

afterAll(() => { closeDb(); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 윈도우 */ } });

describe('큐 — 문장 단위 약속', () => {
  it('같은 idempotency 키는 큐에 한 번만 든다', () => {
    const a = enqueue({ workflowId: quick.id, workflowName: quick.name, trigger: 'webhook', idempotencyKey: 'evt-1' });
    const b = enqueue({ workflowId: quick.id, workflowName: quick.name, trigger: 'webhook', idempotencyKey: 'evt-1' });
    expect(a.deduped).toBe(false);
    expect(b).toEqual({ job: a.job, deduped: true });
    expect(Jobs.list({ status: 'queued' }).filter((j) => j.idempotencyKey === 'evt-1')).toHaveLength(1);
  });

  it('스케줄 틱은 분 단위 키 — 같은 분에 두 번 울려도 일은 하나', () => {
    const at = new Date('2026-09-24T09:00:10Z');
    const a = enqueueScheduled(quick, quick.nodes[0], { expr: '0 9 * * *', interval: '직접 지정', at });
    const b = enqueueScheduled(quick, quick.nodes[0], { expr: '0 9 * * *', interval: '직접 지정', at: new Date('2026-09-24T09:00:45Z') });
    const c = enqueueScheduled(quick, quick.nodes[0], { expr: '0 9 * * *', interval: '직접 지정', at: new Date('2026-09-24T09:01:00Z') });
    expect(a.deduped).toBe(false); expect(b.deduped).toBe(true); expect(b.job.id).toBe(a.job.id); expect(c.deduped).toBe(false);
    expect(a.job.idempotencyKey).toBe(`schedule:${quick.id}:t:2026-09-24T09:00`);
  });

  it('claimNext 는 한 일을 한 번만 준다 — 두 번째 워커는 빈손', () => {
    const { job } = enqueue({ workflowId: quick.id, workflowName: quick.name, trigger: 'manual', idempotencyKey: 'claim-1' });
    db_clear_others_except([job.id]);
    const first = claimNext('w1');
    expect(first).toMatchObject({ id: job.id, status: 'running', workerId: 'w1', attempts: 1 });
    expect(claimNext('w2')).toBeNull();
    expect(complete(job.id, 'w2', 'ex_x')).toBe(false);          // 남의 일은 못 끝낸다
    expect(complete(job.id, 'w1', 'ex_x')).toBe(true);
    expect(Jobs.get(job.id)).toMatchObject({ status: 'done', executionId: 'ex_x' });
  });

  it('임대가 만료된 일은 다른 워커가 다시 잡는다(시도 +1) · 심장박동은 임대를 늘린다 · 상한이면 failed', async () => {
    const { job } = enqueue({ workflowId: quick.id, workflowName: quick.name, trigger: 'manual', idempotencyKey: 'lease-1', maxAttempts: 2 });
    db_clear_others_except([job.id]);
    expect(claimNext('dead', { leaseMs: 60 })).toMatchObject({ id: job.id, attempts: 1 });
    expect(claimNext('alive', { leaseMs: 60 })).toBeNull();      // 아직 임대 중
    expect(heartbeat(job.id, 'dead', { leaseMs: 200 })).toBe(true);
    await sleep(100);
    expect(claimNext('alive', { leaseMs: 60 })).toBeNull();      // 박동으로 늘렸다
    await sleep(160);
    expect(claimNext('alive', { leaseMs: 60 })).toMatchObject({ id: job.id, attempts: 2, workerId: 'alive' });   // 죽은 워커의 일을 이어받음
    await sleep(80);
    expect(claimNext('third', { leaseMs: 60 })).toBeNull();      // 시도 상한(2) — 더는 안 잡는다
    expect(reapExpired()).toBe(1);
    expect(Jobs.get(job.id)).toMatchObject({ status: 'failed' });
    expect(Jobs.get(job.id).error).toContain('임대가 만료');
  });

  it('runJob: 실행 기록에 연결되고 멱등 원장이 done 이 된다 · 실패는 재시도 뒤 DLQ 로', async () => {
    ProcessedEvents.claim('hook-9', { source: 'webhook' });
    const { job } = enqueue({ workflowId: quick.id, workflowName: quick.name, trigger: 'webhook', idempotencyKey: 'hook-9' });
    db_clear_others_except([job.id]);
    const claimed = claimNext('w1');
    const r = await runJob(claimed, 'w1');
    expect(r.execution.status).toBe('success');
    expect(Jobs.get(job.id)).toMatchObject({ status: 'done', executionId: r.execution.id });
    expect(ProcessedEvents.find('hook-9')).toMatchObject({ status: 'done', result_ref: r.execution.id });
    expect(Executions.get(r.execution.id).trigger).toBe('webhook');

    // 워크플로가 없으면 실패 → 시도가 남았으니 queued 로, 다시 실패하면 failed + DLQ
    const gone = enqueue({ workflowId: 'wf_missing', workflowName: '없음', trigger: 'webhook', idempotencyKey: 'hook-10', maxAttempts: 2 });
    let c = claimNext('w1'); expect(c.id).toBe(gone.job.id);
    expect(await runJob(c, 'w1')).toBeNull();
    expect(Jobs.get(gone.job.id)).toMatchObject({ status: 'queued', attempts: 1 });
    c = claimNext('w1'); expect(c.id).toBe(gone.job.id);
    expect(await runJob(c, 'w1')).toBeNull();
    expect(Jobs.get(gone.job.id)).toMatchObject({ status: 'failed', attempts: 2 });

    // 노드 오류는 execute 가 삼키므로 job 은 done — 실행 기록이 error 를 말한다 (그게 DLQ·Error Trigger 의 몫)
    const b = enqueue({ workflowId: broken.id, workflowName: broken.name, trigger: 'manual', idempotencyKey: 'broken-1' });
    c = claimNext('w1'); expect(c.id).toBe(b.job.id);
    const rb = await runJob(c, 'w1');
    expect(rb.execution.status).toBe('error');
    expect(Jobs.get(b.job.id).status).toBe('done');
  });
});

/* ---------- 진짜 워커 프로세스 ---------- */
function spawnWorker(id, env = {}) {
  const c = spawn(process.execPath, [path.join(ROOT, 'server', 'worker.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CONDUIT_DATA_DIR: dataDir, CONDUIT_WORKER_ID: id, CONDUIT_WORKER_POLL_MS: '40', CONDUIT_LLM_AUTODETECT: 'off', TELEGRAM_BOT_TOKEN: '', CONDUIT_API_KEY: '', ...env },
  });
  c.out = '';
  c.stdout.on('data', (d) => (c.out += d)); c.stderr.on('data', (d) => (c.out += d));
  return c;
}
// 프로세스가 끝났는지는 exitCode 만으로 모른다 — 신호로 죽으면 exitCode 는 null 이고 signalCode 가 찬다
const killed = (c) => new Promise((r) => {
  if (c.exitCode !== null || c.signalCode !== null) return r();
  const t = setTimeout(r, 5000);                                                   // 어떤 이유로든 exit 가 안 오면 테스트를 붙잡지 않는다
  c.once('exit', () => { clearTimeout(t); r(); });
  if (!c.kill('SIGKILL')) { clearTimeout(t); r(); }
});
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('until: 시간 초과'); await sleep(50); } };

describe('워커 프로세스 두 개', () => {
  it('일 30개를 두 워커가 나눠 갖고, 어느 일도 두 번 돌지 않는다', async () => {
    db_clear_others_except([]);
    const before = Executions.all().length;
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(enqueue({ workflowId: quick.id, workflowName: quick.name, trigger: 'webhook', idempotencyKey: `race-${i}` }).job.id);
    const a = spawnWorker('A'); const b = spawnWorker('B');
    try {
      await until(() => ids.every((id) => Jobs.get(id).status === 'done'), 30000);
    } finally { await killed(a); await killed(b); }
    const jobs = ids.map((id) => Jobs.get(id));
    expect(jobs.every((j) => j.attempts === 1)).toBe(true);
    expect(new Set(jobs.map((j) => j.executionId)).size).toBe(30);                 // 실행 30개, 전부 다르다
    expect(Executions.all().length).toBe(before + 30);                            // 두 번 돈 일이 없다
    const workers = new Set(jobs.map((j) => j.workerId));
    expect(workers.has('A') && workers.has('B')).toBe(true);                       // 둘 다 일했다
  }, 60000);

  it('일을 잡은 워커를 SIGKILL 하면 임대가 만료된 뒤 다른 워커가 이어받아 끝낸다', async () => {
    db_clear_others_except([]);
    const before = Executions.all().length;
    const { job } = enqueue({ workflowId: slow.id, workflowName: slow.name, trigger: 'webhook', idempotencyKey: 'crash-1', maxAttempts: 3 });
    const a = spawnWorker('A', { CONDUIT_JOB_LEASE_MS: '600' });
    let b;
    const log = (m) => process.env.QUEUE_TEST_DEBUG && console.log(`[crash-test] ${m} · job=${JSON.stringify(Jobs.get(job.id))}`);
    try {
      log('A spawned');
      await until(() => Jobs.get(job.id).status === 'running' && Jobs.get(job.id).workerId === 'A');
      log('A claimed');
      await sleep(300);                                                             // 느린 노드(2.5초) 한가운데
      await killed(a);
      log(`A killed (exit ${a.exitCode}) out=${a.out.trim()}`);
      expect(Jobs.get(job.id)).toMatchObject({ status: 'running', workerId: 'A', attempts: 1 });   // 죽은 채로 running
      b = spawnWorker('B', { CONDUIT_JOB_LEASE_MS: '600' });
      log('B spawned');
      await until(() => Jobs.get(job.id).status === 'done', 20000);
      log(`done. B out=${b.out.trim()}`);
    } finally { log('finally'); await killed(a); if (b) await killed(b); log('cleaned'); }
    expect(Jobs.get(job.id)).toMatchObject({ status: 'done', workerId: 'B', attempts: 2 });
    expect(Executions.all().length).toBe(before + 1);                             // A 의 반쪽 실행은 기록되지 않았다
    expect(Executions.get(Jobs.get(job.id).executionId).status).toBe('success');
  }, 60000);
});

// 테스트끼리 섞이지 않게 — 지정한 일만 남기고 지운다
function db_clear_others_except(keep) {
  db.prepare(`DELETE FROM jobs WHERE id NOT IN (${keep.length ? keep.map(() => '?').join(',') : "''"})`).run(...keep);
}

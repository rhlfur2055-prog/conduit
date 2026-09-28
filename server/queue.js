// ============================================================
// 작업 큐 — 워크플로 실행을 HTTP 요청·크론 틱에서 떼어 SQLite jobs 테이블에 넣고, 워커가 하나씩 잡아 돈다.
//
//   왜: 웹훅 요청 안에서 워크플로가 끝까지 돌면 오래 걸릴 때 요청이 끊기고, 서버가 둘이면 같은 크론이 두 번 돈다.
//   약속:
//     - "다음 일 하나 잡기" 는 UPDATE 한 문장(claimNext). 워커가 몇 개든, 프로세스가 몇 개든 한 일은 한 워커만 잡는다.
//     - 잡은 워커는 임대(lease)를 받는다. 워커가 죽으면 임대가 만료되고 다른 워커가 다시 잡는다 (최소 한 번 실행).
//       그래서 발송 노드는 승인 게이트 뒤에 있고, 트리거 경계에는 멱등 키가 있다 — 두 번 돌아도 두 번 나가지 않는다.
//     - 같은 idempotency_key 는 큐에 한 번만 든다 (스케줄 틱 · 웹훅 이벤트) — 서버 두 대가 같은 크론을 울려도 일은 하나.
//   워커: 서버 프로세스 안(inline, 기본) 또는 별도 프로세스(node server/worker.js). 둘 다 같은 테이블을 본다.
// ============================================================
import { db, uid, Workflows, ProcessedEvents, DLQ } from './store.js';
import { transaction, bind, parseJson } from './db.js';
import { execute } from './runtime.js';

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT,
  workflow_name   TEXT,
  trigger         TEXT NOT NULL,
  seed            TEXT,                -- JSON
  gates           TEXT,                -- JSON
  idempotency_key TEXT UNIQUE,         -- 같은 키는 큐에 한 번만
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 2,
  lease_until     TEXT,                -- running 워커의 임대 만료 시각 — 지나면 다른 워커가 다시 잡는다
  worker_id       TEXT,
  execution_id    TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created_at);
`);

const nowISO = () => new Date().toISOString();
const row = (r) => r && ({
  id: r.id, workflowId: r.workflow_id, workflowName: r.workflow_name, trigger: r.trigger,
  seed: parseJson(r.seed, {}), gates: parseJson(r.gates, {}), idempotencyKey: r.idempotency_key,
  status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, leaseUntil: r.lease_until, workerId: r.worker_id,
  executionId: r.execution_id, error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});

export const Jobs = {
  get: (id) => row(db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id)) ?? null,
  byKey: (key) => row(db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`).get(key)) ?? null,
  list: ({ status, limit = 100 } = {}) => db.prepare(
    `SELECT * FROM jobs ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(...(status ? [status, limit] : [limit])).map(row),
  counts: () => Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all().map((r) => [r.status, r.n])),
};

/**
 * 큐에 넣는다. idempotencyKey 가 있으면 같은 키의 일이 이미 있을 때 새로 만들지 않고 그 일을 돌려준다(deduped:true).
 * @returns {{ job: object, deduped: boolean }}
 */
export function enqueue({ workflowId, workflowName, trigger, seed = {}, gates = {}, idempotencyKey = null, maxAttempts = 2 }) {
  const id = uid('job');
  const r = db.prepare(`
    INSERT INTO jobs (id, workflow_id, workflow_name, trigger, seed, gates, idempotency_key, status, attempts, max_attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    ON CONFLICT (idempotency_key) DO NOTHING`,
  ).run(id, bind.text(workflowId), bind.text(workflowName), trigger, bind.json(seed), bind.json(gates), bind.text(idempotencyKey), maxAttempts, nowISO());
  if (r.changes === 1) return { job: Jobs.get(id), deduped: false };
  return { job: Jobs.byKey(idempotencyKey), deduped: true };
}

/**
 * 다음 일 하나를 원자적으로 잡는다 — queued 이거나, running 인데 임대가 만료된(워커가 죽은) 일.
 * 한 문장이라 두 워커가 같은 일을 잡을 수 없다. 시도 횟수가 상한이면 잡지 않는다.
 */
export function claimNext(workerId, { leaseMs = 30000 } = {}) {
  const now = nowISO();
  const lease = new Date(Date.now() + leaseMs).toISOString();
  const r = db.prepare(`
    UPDATE jobs SET status = 'running', worker_id = ?, attempts = attempts + 1, lease_until = ?, started_at = COALESCE(started_at, ?)
    WHERE id = (
      SELECT id FROM jobs
      WHERE (status = 'queued' OR (status = 'running' AND lease_until < ?)) AND attempts < max_attempts
      ORDER BY created_at ASC, rowid ASC LIMIT 1)
    RETURNING *`,
  ).get(workerId, lease, now, now);
  return row(r) ?? null;
}

/** 임대 연장 — 오래 걸리는 일을 잡은 워커가 살아 있음을 알린다 */
export function heartbeat(jobId, workerId, { leaseMs = 30000 } = {}) {
  const r = db.prepare(`UPDATE jobs SET lease_until = ? WHERE id = ? AND worker_id = ? AND status = 'running'`)
    .run(new Date(Date.now() + leaseMs).toISOString(), jobId, workerId);
  return r.changes === 1;
}

export function complete(jobId, workerId, executionId) {
  const r = db.prepare(`UPDATE jobs SET status = 'done', execution_id = ?, finished_at = ?, error = NULL WHERE id = ? AND worker_id = ? AND status = 'running'`)
    .run(bind.text(executionId), nowISO(), jobId, workerId);
  return r.changes === 1;
}

/** 실패 — 시도가 남았으면 queued 로 돌리고, 아니면 failed */
export function fail(jobId, workerId, error) {
  return transaction(db, () => {
    const j = Jobs.get(jobId);
    if (!j || j.workerId !== workerId || j.status !== 'running') return false;
    const again = j.attempts < j.maxAttempts;
    db.prepare(`UPDATE jobs SET status = ?, error = ?, finished_at = ?, lease_until = NULL WHERE id = ?`)
      .run(again ? 'queued' : 'failed', String(error || '').slice(0, 800), again ? null : nowISO(), jobId);
    return true;
  });
}

/** 워커가 죽은 채 시도 상한에 닿은 일은 failed 로 — 영원히 running 으로 남지 않게 */
export function reapExpired() {
  const r = db.prepare(`UPDATE jobs SET status = 'failed', error = COALESCE(error, '워커가 응답하지 않아 임대가 만료됨'), finished_at = ?
    WHERE status = 'running' AND lease_until < ? AND attempts >= max_attempts`).run(nowISO(), nowISO());
  return r.changes;
}

/** 일 하나를 실제로 돈다 — 워크플로를 그때 읽고(지워졌으면 실패), 멱등 원장(processed_events)이 있으면 결과를 적는다 */
export async function runJob(job, workerId, { leaseMs = 30000 } = {}) {
  const wf = job.workflowId ? Workflows.get(job.workflowId) : null;
  if (!wf) {
    fail(job.id, workerId, `워크플로를 찾을 수 없습니다: ${job.workflowId}`);
    if (job.idempotencyKey && ProcessedEvents.find(job.idempotencyKey)) ProcessedEvents.fail(job.idempotencyKey);
    return null;
  }
  const beat = setInterval(() => heartbeat(job.id, workerId, { leaseMs }), Math.max(250, leaseMs / 3));
  beat.unref?.();
  try {
    const result = await execute(wf, { seed: job.seed, gates: job.gates, trigger: job.trigger });
    clearInterval(beat);
    complete(job.id, workerId, result.execution.id);
    if (job.idempotencyKey && ProcessedEvents.find(job.idempotencyKey)) ProcessedEvents.complete(job.idempotencyKey, result.execution.id);
    return result;
  } catch (e) {
    clearInterval(beat);
    fail(job.id, workerId, e.message);
    if (job.idempotencyKey && ProcessedEvents.find(job.idempotencyKey)) ProcessedEvents.fail(job.idempotencyKey);
    if (Jobs.get(job.id)?.status === 'failed') {                  // 시도를 다 썼다 — 페이로드를 격리해 두고 나중에 재실행할 수 있게
      DLQ.add({ workflowId: wf.id, workflowName: wf.name, nodeId: null, nodeKind: job.trigger, payload: job.seed, errorCode: 'JOB', errorMsg: e.message, attempts: job.attempts });
    }
    return null;
  }
}

/** 일이 끝날 때까지 기다린다 (웹훅처럼 결과를 돌려줘야 하는 호출자용). 시간 안에 안 끝나면 그때의 상태를 돌려준다. */
export async function waitForJob(jobId, { timeoutMs = 25000, pollMs = 50 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const j = Jobs.get(jobId);
    if (!j || j.status === 'done' || j.status === 'failed' || Date.now() >= end) return j;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* ---------- 워커 루프 ---------- */
export const workerMode = () => {
  const v = String(process.env.CONDUIT_WORKER ?? 'inline').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' ? 'off' : 'inline';
};
const leaseMsEnv = () => Number(process.env.CONDUIT_JOB_LEASE_MS) || 30000;

/**
 * 폴링 워커. pollMs 마다 claimNext → runJob. 한 번에 하나(concurrency=1)가 기본 — 워크플로 안의 병렬은 엔진이 한다.
 * @returns {{ id: string, stop: () => void, running: () => boolean }}
 */
export function startWorker({ workerId = `w_${process.pid}_${uid('').slice(1)}`, pollMs = 500, leaseMs = leaseMsEnv(), onJob, keepAlive = false } = {}) {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      reapExpired();
      for (;;) {
        const job = claimNext(workerId, { leaseMs });
        if (!job) break;
        const result = await runJob(job, workerId, { leaseMs });
        onJob?.(job, result);
        if (stopped) break;
      }
    } catch (e) {
      console.warn(`[queue] 워커 오류 ${workerId}: ${e.message}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(tick, pollMs);
  // 서버 안 워커는 프로세스를 붙잡지 않는다(unref). 별도 워커 프로세스는 이 타이머가 유일한 생명줄이라 붙잡아야 한다 —
  // 안 그러면 잡을 일이 없는 순간 이벤트 루프가 비어 조용히 종료된다.
  if (!keepAlive) t.unref?.();
  setImmediate(tick);
  return { id: workerId, stop: () => { stopped = true; clearInterval(t); }, running: () => busy };
}

let inlineWorker = null;
/** 서버 프로세스 안의 워커 — 처음 필요할 때 한 번 띄운다. CONDUIT_WORKER=off 면 띄우지 않는다(별도 워커 프로세스가 돈다). */
export function ensureInlineWorker(opts = {}) {
  if (workerMode() === 'off') return null;
  if (!inlineWorker) inlineWorker = startWorker({ workerId: `inline_${process.pid}`, ...opts });
  return inlineWorker;
}
export function stopInlineWorker() { inlineWorker?.stop(); inlineWorker = null; }

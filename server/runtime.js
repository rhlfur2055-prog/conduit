// ============================================================
// 서버 실행 런타임 — 워크플로 실행, 실패 시 Error Trigger 발동, 크론 스케줄러.
// 라우트(웹훅·MCP·DLQ 재실행 등)가 모두 이 execute() 를 거친다.
// ============================================================
import cron from 'node-cron';
import { runFlow } from '../src/engine/executor.ts';
import { Workflows, Executions, DLQ, uid } from './store.js';
import { finalizeApproval } from './approvals.js';
import { currentPolicy } from './policy.js';
import { enqueue, ensureInlineWorker } from './queue.js';

/** 실패한 노드 목록과 Error Trigger 에 넘길 페이로드 */
export function buildErrorPayload({ workflow, exec, statuses, trigger }) {
  const failedNodes = Object.entries(statuses)
    .filter(([, s]) => s.status === 'error')
    .map(([id, s]) => {
      const node = (workflow.nodes || []).find((n) => n.id === id);
      return { nodeId: id, nodeKind: node?.data?.kind || 'unknown', error: s.error || '알 수 없는 오류' };
    });
  return {
    workflowId: workflow.id || null,
    workflowName: workflow.name || '(임시)',
    executionId: exec.id,
    trigger,
    failedAt: exec.at,
    errorNode: failedNodes[0]?.nodeKind || 'unknown',
    errorMessage: failedNodes[0]?.error || '알 수 없는 오류',
    failedNodes,
  };
}

/* ---------- Error Trigger 발동 ----------
   실패한 실행이 생기면, errorTrigger 노드를 가진 "다른" 활성 워크플로를 실행한다.
   에러 핸들러 자신의 실패(trigger='error')는 재발동하지 않는다(무한루프 방지). */
export async function dispatchErrorWorkflows(failed) {
  const handlers = Workflows.all().filter(
    (w) =>
      w.active &&
      w.id !== failed.workflowId &&
      (w.nodes || []).some((n) => n.data.kind === 'errorTrigger')
  );
  for (const wf of handlers) {
    const seed = {};
    for (const n of wf.nodes || []) {
      if (n.data.kind === 'errorTrigger') seed[n.id] = { main: failed.payload };
    }
    try {
      await execute(wf, { seed, trigger: 'error' });
      console.log(`[error-trigger] "${wf.name}" 발동 (원인: ${failed.payload.workflowName})`);
    } catch (e) {
      console.warn(`[error-trigger] "${wf.name}" 실행 실패: ${e.message}`);
    }
  }
}

/* ---------- 추적 재료 ----------
   노드마다 status 만이 아니라 걸린 시간(ms) · 시도 횟수(attempts) · 실패 격리 건수 · 주입 여부(injected)를 남긴다.
   execute() 와 캔버스의 스트리밍 실행이 같은 함수를 써서, 실행 기록 화면의 "추적" 이 두 경로에서 같게 나온다. */

/** onStatus 콜백 — 처음 running 이 된 시각을 기억했다가 끝 상태에서 ms 를 채운다 */
export function statusRecorder(statuses) {
  const started = new Map();
  return (id, status, payload) => {
    if ((status === 'running' || status === 'retrying') && !started.has(id)) started.set(id, Date.now());
    const rec = { ...(statuses[id] || {}), status, ...(payload || {}) };
    if (started.has(id) && status !== 'running' && status !== 'retrying') rec.ms = Date.now() - started.get(id);
    statuses[id] = rec;
  };
}

/** 실행 결과(Map)에서 시도 횟수·실패 격리 건수·노드 종류를 상태에 보탠다 — 워크플로가 지워져도 기록만으로 추적이 되게 */
export function enrichStatuses(statuses, results, nodes = []) {
  const kindOf = new Map(nodes.map((n) => [n.id, n.data?.kind]));
  for (const [id, r] of results) {
    const s = (statuses[id] ||= { status: r.status });
    if (r.attempts !== undefined) s.attempts = r.attempts;
    if (r.failedItems) s.failedItems = r.failedItems;
    if (kindOf.get(id)) s.kind = kindOf.get(id);
  }
}

/**
 * 사람 승인 대기: 승인 노드(또는 자동 게이트)는 실행 도중 기록만 만든다('preparing'). 실행이 끝난 지금 "끝난 노드 전부"를
 * 스냅샷으로 넘겨 확정(메시지 전송 → 'pending')한다. 다른 승인 노드·실패한 노드는 빈 출력으로 넣어
 * 재개할 때 다시 실행되지 않게 한다. 실행에 오류가 있어도 확정한다 — 안 하면 부분 스냅샷으로 재개돼 노드가 두 번 돈다.
 */
export async function finalizeWaiting(results, { logs, statuses }) {
  for (const [id, r] of results) {
    if (r.status !== 'waiting') continue;
    const snapshot = {};
    for (const [oid, o] of results) {
      if (oid === id) continue;
      if (o.status === 'done' || o.status === 'failedContinue') snapshot[oid] = o.output || {};
      else if (o.status === 'waiting' || o.status === 'error') snapshot[oid] = {};
    }
    for (const w of r.wait || []) {
      if (!w?.approvalId) continue;
      try {
        await finalizeApproval(w.approvalId, snapshot);
        logs.push({ kind: 'ok', msg: `⏸ 승인 요청 전송 (${w.approvalId})` });
      } catch (e) {
        statuses[id] = { ...(statuses[id] || {}), status: 'error', error: `승인 요청 전송 실패: ${e.message}` };
        logs.push({ kind: 'err', msg: `✖ 승인 요청 전송 실패 (${w.approvalId}): ${e.message}` });
      }
    }
  }
}

/* ---------- 실행 ---------- */
export async function execute(workflow, { seed = {}, trigger = 'manual', gates = {} } = {}) {
  const execId = uid('ex');                  // 먼저 발급 — 승인 요청·DLQ 가 이 실행에 매달린다
  const startedAt = Date.now();
  const nodes = (workflow.nodes || []).map((n) => ({
    id: n.id,
    data: { kind: n.data.kind, params: n.data.params },
  }));
  const edges = workflow.edges || [];

  /** @type {import('../src/engine/types.ts').LogEntry[]} */
  const logs = [];
  /** @type {Record<string, { status: import('../src/engine/types.ts').NodeStatus } & import('../src/engine/types.ts').StatusDetail>} */
  const statuses = {};
  /** @type {Map<string, import('../src/engine/types.ts').NodeResult>} — 승인 대기 스냅샷의 재료 */
  const results = await runFlow(nodes, edges, {
    seed,
    gates,                                   // 자동 게이트의 승인/거절 (승인 재개에서만 채워진다)
    policy: currentPolicy(),
    meta: { workflowId: workflow.id || null, workflowName: workflow.name || '(임시)', trigger, executionId: execId },
    onLog: (l) => logs.push(l),
    onStatus: statusRecorder(statuses),
    onDeadLetter: (e) => DLQ.add({ ...e, workflowId: workflow.id, workflowName: workflow.name, executionId: execId }),
  });
  enrichStatuses(statuses, results, nodes);

  const outputs = {};
  for (const [id, r] of results) outputs[id] = r.output;

  await finalizeWaiting(results, { logs, statuses });
  const hadError = Object.values(statuses).some((s) => s.status === 'error');
  const waiting = !hadError && Object.values(statuses).some((s) => s.status === 'waiting');

  const exec = Executions.add({
    id: execId,
    workflowId: workflow.id || null,
    workflowName: workflow.name || '(임시)',
    trigger,
    status: hadError ? 'error' : waiting ? 'waiting' : 'success',
    durationMs: Date.now() - startedAt,
    logs,
    statuses,
  });

  // 휴대폰 알림 (실패 · 설정에 따라 완료) — 응답을 막지 않도록 비동기, 순환 import 를 피해 필요할 때 불러온다
  import('./telegramChannel.js').then((m) => m.notifyExecution({ execution: exec, workflow, trigger })).catch(() => {});

  // 실패 시 Error Trigger 워크플로 발동 (에러 핸들러 자신의 실패는 제외) — 응답을 막지 않도록 비동기
  if (hadError && trigger !== 'error') {
    const payload = buildErrorPayload({ workflow, exec, statuses, trigger });
    dispatchErrorWorkflows({ workflowId: workflow.id || null, payload }).catch(() => {});
  }

  return { execution: exec, outputs, statuses, logs };
}

/* ---------- 스케줄러 ---------- */
const CRON_BY_INTERVAL = {
  '매분': '* * * * *',
  '10분마다': '*/10 * * * *',
  '매시': '0 * * * *',
  '매일 09:00': '0 9 * * *',
  '매주 월요일': '0 9 * * 1',
};
const scheduled = new Map(); // key: `${wfId}:${nodeId}` -> cron task

export function clearSchedulesFor(wfId) {
  for (const [key, task] of scheduled) {
    if (key.startsWith(wfId + ':')) { task.stop(); scheduled.delete(key); }
  }
}

export function registerSchedules(wf) {
  clearSchedulesFor(wf.id);
  if (!wf.active) return;
  for (const node of wf.nodes || []) {
    if (node.data.kind !== 'scheduleTrigger') continue;
    const p = node.data.params || {};
    const expr = p.interval === '직접 지정' ? String(p.cron || '').trim() : (CRON_BY_INTERVAL[p.interval] || null);
    if (!expr || !cron.validate(expr)) continue;
    const task = cron.schedule(expr, async () => {
      const fresh = Workflows.get(wf.id);
      if (!fresh || !fresh.active) return;
      const { job, deduped } = enqueueScheduled(fresh, node, { expr, interval: p.interval });
      ensureInlineWorker();
      console.log(`[cron] ${wf.name} ${deduped ? '이미 큐에 있음' : '큐에 넣음'} (${expr}) → ${job.id}`);
    });
    scheduled.set(`${wf.id}:${node.id}`, task);
  }
}

/** 스케줄 틱을 큐에 넣는다. 키가 분 단위라 서버 두 대가 같은 분에 같은 크론을 울려도 일은 하나만 생긴다. */
export function enqueueScheduled(wf, node, { expr, interval, at = new Date() } = {}) {
  const minute = at.toISOString().slice(0, 16);
  const seed = { [node.id]: { main: { triggeredAt: at.toISOString(), interval: interval === '직접 지정' ? expr : interval } } };
  return enqueue({ workflowId: wf.id, workflowName: wf.name, trigger: 'schedule', seed, idempotencyKey: `schedule:${wf.id}:${node.id}:${minute}` });
}

export function registerAll() {
  for (const wf of Workflows.all()) registerSchedules(wf);
  console.log(`[cron] 활성 스케줄 ${scheduled.size}개 등록`);
}

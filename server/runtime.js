// ============================================================
// 서버 실행 런타임 — 워크플로 실행, 실패 시 Error Trigger 발동, 크론 스케줄러.
// 라우트(웹훅·MCP·DLQ 재실행 등)가 모두 이 execute() 를 거친다.
// ============================================================
import cron from 'node-cron';
import { runFlow } from '../src/engine/executor.js';
import { Workflows, Executions, DLQ } from './store.js';
import { finalizeApproval } from './approvals.js';
import { currentPolicy } from './policy.js';

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

/* ---------- 실행 ---------- */
export async function execute(workflow, { seed = {}, trigger = 'manual' } = {}) {
  const nodes = (workflow.nodes || []).map((n) => ({
    id: n.id,
    data: { kind: n.data.kind, params: n.data.params },
  }));
  const edges = workflow.edges || [];

  const logs = [];
  const statuses = {};
  const results = await runFlow(nodes, edges, {
    seed,
    policy: currentPolicy(),
    meta: { workflowId: workflow.id || null, workflowName: workflow.name || '(임시)', trigger },
    onLog: (l) => logs.push(l),
    onStatus: (id, status, payload) => { statuses[id] = { status, ...(payload || {}) }; },
    onDeadLetter: (e) => DLQ.add({ ...e, workflowId: workflow.id, workflowName: workflow.name }),
  });

  const outputs = {};
  for (const [id, r] of results) outputs[id] = r.output;

  // 사람 승인 대기: 승인 노드는 실행 도중 기록만 만든다('preparing'). 실행이 끝난 지금 "끝난 노드 전부"를
  // 스냅샷으로 넘겨 확정(메시지 전송 → 'pending')한다. 다른 승인 노드·실패한 노드는 빈 출력으로 넣어
  // 재개할 때 다시 실행되지 않게 한다. 실행에 오류가 있어도 확정한다 — 안 하면 부분 스냅샷으로 재개돼 노드가 두 번 돈다.
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
  const hadError = Object.values(statuses).some((s) => s.status === 'error');
  const waiting = !hadError && Object.values(statuses).some((s) => s.status === 'waiting');

  const exec = Executions.add({
    workflowId: workflow.id || null,
    workflowName: workflow.name || '(임시)',
    trigger,
    status: hadError ? 'error' : waiting ? 'waiting' : 'success',
    logs,
    statuses,
  });

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
    const expr = CRON_BY_INTERVAL[node.data.params?.interval] || null;
    if (!expr || !cron.validate(expr)) continue;
    const task = cron.schedule(expr, async () => {
      const fresh = Workflows.get(wf.id);
      if (!fresh || !fresh.active) return;
      const seed = { [node.id]: { main: { triggeredAt: new Date().toISOString(), interval: node.data.params.interval } } };
      await execute(fresh, { seed, trigger: 'schedule' });
      console.log(`[cron] ${wf.name} 실행 (${node.data.params.interval})`);
    });
    scheduled.set(`${wf.id}:${node.id}`, task);
  }
}

export function registerAll() {
  for (const wf of Workflows.all()) registerSchedules(wf);
  console.log(`[cron] 활성 스케줄 ${scheduled.size}개 등록`);
}

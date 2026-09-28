// 워크플로 CRUD · 실행 · 실행 기록 · 크리덴셜
import { Router } from 'express';
import { Workflows, Executions, Credentials, DLQ, Approvals, uid } from '../store.js';
import { execute, registerSchedules, clearSchedulesFor, buildErrorPayload, dispatchErrorWorkflows, statusRecorder, enrichStatuses, finalizeWaiting } from '../runtime.js';
import { countItems } from '../../src/engine/items.ts';
import { Jobs } from '../queue.js';
import { runFlow } from '../../src/engine/executor.ts';
import { currentPolicy } from '../policy.js';
import { NODE_TYPES } from '../../src/engine/nodeTypes.ts';
import { analyzeGates } from '../../src/engine/gates.ts';

export const workflows = Router();

/* ---------- 워크플로 ---------- */
workflows.get('/workflows', (_req, res) => {
  res.json(Workflows.all().map((w) => ({
    id: w.id, name: w.name, active: w.active,
    nodeCount: w.nodes.length, updatedAt: w.updatedAt,
  })));
});
// 보호되지 않은 발송 경로 — 저장 전에 화면이 물어볼 수 있게. 실행기가 쓰는 것과 같은 판정(src/engine/gates.ts)
workflows.post('/workflows/lint', (req, res) => {
  const { nodes = [], edges = [] } = req.body || {};
  const title = (id) => NODE_TYPES[nodes.find((n) => n.id === id)?.data?.kind]?.title || id;
  const unguarded = analyzeGates(nodes, edges).map((u) => ({
    target: u.target, targetTitle: title(u.target), sources: u.sources, sourceTitles: u.sources.map(title),
    message: `${u.sources.map(title).join(', ')} → ${title(u.target)}: AI 출력이 승인 없이 밖으로 나갑니다. 실행하면 발송 직전에 자동으로 승인을 묻습니다.`,
  }));
  res.json({ aiGate: currentPolicy().aiGate, unguarded });
});

workflows.get('/workflows/:id', (req, res) => {
  const wf = Workflows.get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(wf);
});
workflows.post('/workflows', (req, res) => {
  const saved = Workflows.save(req.body);
  registerSchedules(saved);
  res.json(saved);
});
workflows.delete('/workflows/:id', (req, res) => {
  clearSchedulesFor(req.params.id);
  Workflows.remove(req.params.id);
  res.json({ ok: true });
});

/* ---------- 실행 ---------- */
workflows.post('/run', async (req, res) => {
  // 저장하지 않은 현재 캔버스 즉시 실행
  const result = await execute({ id: null, name: '(캔버스)', ...req.body }, { trigger: 'manual' });
  res.json(result);
});
workflows.post('/workflows/:id/run', async (req, res) => {
  const wf = Workflows.get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(await execute(wf, { trigger: 'manual' }));
});

// SSE 스트리밍 실행 — 노드 상태/로그/에이전트 스텝을 실시간 전송
workflows.post('/run/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const workflow = { id: null, name: '(캔버스)', ...req.body };
  const nodes = (workflow.nodes || []).map((n) => ({ id: n.id, data: { kind: n.data.kind, params: n.data.params } }));
  const edges = workflow.edges || [];

  const logs = [];
  const statuses = {};
  const execId = uid('ex');
  const startedAt = Date.now();
  const record = statusRecorder(statuses);
  try {
    const results = await runFlow(nodes, edges, {
      policy: currentPolicy(),
      meta: { workflowId: null, workflowName: workflow.name, trigger: 'manual', executionId: execId },
      onStatus: (id, status, payload) => {
        record(id, status, payload);
        send('status', { id, status, output: payload?.output, input: payload?.input, error: payload?.error, wait: payload?.wait });
      },
      onLog: (l) => { logs.push(l); send('log', l); },
      onAgentStep: (id, step) => send('agentStep', { id, step }),
      onItemProgress: (id, done, total) => send('progress', { id, done, total }),
      onDeadLetter: (e) => DLQ.add({ ...e, workflowId: null, workflowName: workflow.name, executionId: execId }),
    });
    enrichStatuses(statuses, results, nodes);
    await finalizeWaiting(results, { logs, statuses });        // 캔버스에서 서버 실행해도 승인 요청이 나간다
    const hadError = Object.values(statuses).some((s) => s.status === 'error');
    const waiting = !hadError && Object.values(statuses).some((s) => s.status === 'waiting');
    const exec = Executions.add({ id: execId, workflowId: null, workflowName: workflow.name, trigger: 'manual', status: hadError ? 'error' : waiting ? 'waiting' : 'success', durationMs: Date.now() - startedAt, logs, statuses });
    if (hadError) {
      const payload = buildErrorPayload({ workflow, exec, statuses, trigger: 'manual' });
      dispatchErrorWorkflows({ workflowId: null, payload }).catch(() => {});
    }
    send('done', {});
  } catch (e) {
    send('log', { kind: 'err', msg: '실행 오류: ' + e.message });
    send('done', {});
  }
  res.end();
});

/* ---------- 작업 큐 ---------- */
workflows.get('/jobs', (req, res) => res.json({ counts: Jobs.counts(), jobs: Jobs.list({ status: req.query.status, limit: Number(req.query.limit) || 100 }) }));
workflows.get('/jobs/:id', (req, res) => {
  const j = Jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

/* ---------- 실행 기록 ---------- */
// 실행 하나를 끝까지 — 노드별 상태·시도·시간·주입, 이 실행이 만든 승인과 그 재개 실행, 어느 승인의 재개였는지, 격리된 실패
const lightApproval = ({ flow, snapshot, item, ...rest }) => rest;
workflows.get('/executions/:id/trace', (req, res) => {
  const ex = Executions.get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'not found' });
  const approvals = Approvals.forExecution(ex.id).map(lightApproval);
  const from = Approvals.resumedInto(ex.id);
  // 노드 종류: 실행 기록에 남긴 kind → 저장된 워크플로 → 승인 기록의 flow (오래된 기록은 kind 가 없을 수 있다)
  const flowNodes = Workflows.get(ex.workflowId)?.nodes || Approvals.forExecution(ex.id).find((a) => a.flow)?.flow?.nodes || from?.flow?.nodes || [];
  const kindOf = (id) => ex.statuses?.[id]?.kind || flowNodes.find((n) => n.id === id)?.data?.kind || null;
  const firstPort = (o) => (o ? (o.main ?? Object.values(o).find((v) => v !== undefined)) : undefined);
  const nodes = Object.entries(ex.statuses || {}).map(([id, s]) => ({
    id, kind: kindOf(id), title: NODE_TYPES[kindOf(id)]?.title || id,
    status: s.status, attempts: s.attempts ?? null, failedItems: s.failedItems ?? 0, ms: s.ms ?? null, injected: !!s.injected,
    inCount: s.input ? countItems(s.input) : null, outCount: s.output ? countItems(firstPort(s.output)) : null,
    error: s.error ?? null, wait: s.wait ?? null,
  }));
  res.json({
    execution: { id: ex.id, workflowId: ex.workflowId, workflowName: ex.workflowName, trigger: ex.trigger, status: ex.status, at: ex.at, durationMs: ex.durationMs },
    nodes,
    approvals,
    resumedFrom: from ? { approvalId: from.id, executionId: from.executionId, gate: from.gate, decision: from.decision, by: from.by, decidedAt: from.decidedAt } : null,
    children: approvals.filter((a) => a.resumedExecutionId).map((a) => ({ approvalId: a.id, executionId: a.resumedExecutionId, decision: a.decision })),
    deadLetters: DLQ.forExecution(ex.id),
  });
});

workflows.get('/executions', (req, res) => {
  const { workflowId } = req.query;
  const list = workflowId ? Executions.forWorkflow(workflowId) : Executions.all();
  res.json(list.slice(0, 50));
});

/* ---------- 크리덴셜 ---------- */
workflows.get('/credentials', (_req, res) => res.json(Credentials.listMasked()));
workflows.post('/credentials', (req, res) => res.json(Credentials.save(req.body)));
workflows.delete('/credentials/:id', (req, res) => { Credentials.remove(req.params.id); res.json({ ok: true }); });

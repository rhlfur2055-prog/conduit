// 워크플로 CRUD · 실행 · 실행 기록 · 크리덴셜
import { Router } from 'express';
import { Workflows, Executions, Credentials } from '../store.js';
import { execute, registerSchedules, clearSchedulesFor, buildErrorPayload, dispatchErrorWorkflows } from '../runtime.js';
import { runFlow } from '../../src/engine/executor.ts';
import { currentPolicy } from '../policy.js';

export const workflows = Router();

/* ---------- 워크플로 ---------- */
workflows.get('/workflows', (_req, res) => {
  res.json(Workflows.all().map((w) => ({
    id: w.id, name: w.name, active: w.active,
    nodeCount: w.nodes.length, updatedAt: w.updatedAt,
  })));
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
  try {
    await runFlow(nodes, edges, {
      policy: currentPolicy(),
      onStatus: (id, status, payload) => {
        statuses[id] = { status, ...(payload || {}) };
        send('status', { id, status, output: payload?.output, input: payload?.input, error: payload?.error });
      },
      onLog: (l) => { logs.push(l); send('log', l); },
      onAgentStep: (id, step) => send('agentStep', { id, step }),
      onItemProgress: (id, done, total) => send('progress', { id, done, total }),
    });
    const hadError = Object.values(statuses).some((s) => s.status === 'error');
    const exec = Executions.add({ workflowId: null, workflowName: workflow.name, trigger: 'manual', status: hadError ? 'error' : 'success', logs, statuses });
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

/* ---------- 실행 기록 ---------- */
workflows.get('/executions', (req, res) => {
  const { workflowId } = req.query;
  const list = workflowId ? Executions.forWorkflow(workflowId) : Executions.all();
  res.json(list.slice(0, 50));
});

/* ---------- 크리덴셜 ---------- */
workflows.get('/credentials', (_req, res) => res.json(Credentials.listMasked()));
workflows.post('/credentials', (req, res) => res.json(Credentials.save(req.body)));
workflows.delete('/credentials/:id', (req, res) => { Credentials.remove(req.params.id); res.json({ ok: true }); });

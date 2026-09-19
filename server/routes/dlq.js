// 실패 큐(DLQ) 조회·재실행·삭제, 멱등성 기록 조회
import { Router } from 'express';
import { Workflows, DLQ, ProcessedEvents } from '../store.js';
import { execute } from '../runtime.js';

export const dlq = Router();

dlq.get('/dlq', (_req, res) => res.json(DLQ.all().slice(0, 100)));

dlq.post('/dlq/:id/replay', async (req, res) => {
  const rec = DLQ.all().find((r) => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const wf = rec.workflow_id ? Workflows.get(rec.workflow_id) : null;
  if (!wf) { DLQ.setStatus(rec.id, 'dropped'); return res.status(400).json({ error: '원본 워크플로를 찾을 수 없어 replay 불가' }); }
  const seed = {};
  for (const n of wf.nodes || []) {
    if (['manualTrigger', 'webhookTrigger', 'scheduleTrigger'].includes(n.data.kind)) seed[n.id] = { main: rec.payload || {} };
  }
  const result = await execute(wf, { seed, trigger: 'replay' });
  DLQ.setStatus(rec.id, 'replayed');
  res.json({ ok: true, executionId: result.execution.id });
});

dlq.delete('/dlq/:id', (req, res) => { DLQ.remove(req.params.id); res.json({ ok: true }); });

dlq.get('/idempotency', (_req, res) => res.json(ProcessedEvents.all().slice(-100).reverse()));

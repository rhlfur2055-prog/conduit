// 사람 승인 대기 — 목록 조회 · 결정 (텔레그램 버튼 대신 API 로도 결정할 수 있다)
import { Router } from 'express';
import { Approvals } from '../store.js';
import { decide, retryResume } from '../approvals.js';

export const approvals = Router();

// 스냅샷(노드 출력)과 flow 는 크므로 목록에서는 뺀다
const light = ({ flow, snapshot, ...rest }) => rest;

approvals.get('/approvals', (req, res) => {
  const { status } = req.query;
  res.json(Approvals.all().filter((a) => !status || a.status === status).slice(0, 100).map(light));
});
approvals.get('/approvals/:id', (req, res) => {
  const a = Approvals.get(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});
approvals.post('/approvals/:id/decide', async (req, res) => {
  const { decision, editedText } = req.body || {};
  const r = await decide(req.params.id, { decision, editedText, by: 'api' });
  res.status(r.ok ? 200 : 400).json(r);
});
// 재개가 실패한 건을 같은 결정으로 다시 실행 (텔레그램 🔁 버튼과 같다)
approvals.post('/approvals/:id/retry', async (req, res) => {
  const r = await retryResume(req.params.id);
  res.status(r.ok ? 200 : 400).json(r);
});

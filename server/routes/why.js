// "왜 이 행동이 일어났나" — 운영 기록 벡터 검색 + 소크라테스식 문답 (server/why.js)
import { Router } from 'express';
import { explainWhy, syncWhyIndex, indexStats, searchWhy } from '../why.js';

export const why = Router();

// { question, executionId?, mode?: 'auto'|'rule' }
why.post('/why', async (req, res) => {
  const { question, executionId, mode } = req.body || {};
  if (!question && !executionId) return res.status(400).json({ ok: false, error: 'question 또는 executionId 가 필요해요' });
  try {
    res.json(await explainWhy({ question, executionId, mode: mode === 'rule' ? 'rule' : 'auto' }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
why.get('/why/index', (_req, res) => res.json(indexStats()));
why.post('/why/reindex', async (_req, res) => res.json({ ...(await syncWhyIndex()), stats: indexStats() }));
// 검색만 (사슬·문답 없이) — 어떤 기록이 왜 걸렸는지 점수로 본다
why.get('/why/search', async (req, res) => {
  await syncWhyIndex();
  res.json(await searchWhy(String(req.query.q || '')));
});

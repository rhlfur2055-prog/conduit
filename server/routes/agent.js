// 목표 · 하트비트 (specs/004-goals-heartbeat) — 목표 관리, 하트비트 한 번 돌리기, 승인 대기 제안 결정
import { Router } from 'express';
import { Goals, Heartbeats, PendingActions, Settings } from '../store.js';
import { runHeartbeat, decidePending } from '../heartbeat.js';
import { quickstart, status, activity, saveClaudeKey, saveTelegramToken, applyHeartbeatSetting } from '../quickstart.js';
import { setMode, allowChat, removeChat, startTelegram } from '../telegramChannel.js';
import { listTemplates, createFromTemplate } from '../templates.js';
import { handleAssistant, confirmAssistant } from '../assistant.js';

export const agent = Router();

agent.get('/goals', (_req, res) => res.json(Goals.all()));
agent.post('/goals', (req, res) => {
  const b = req.body || {};
  if (!String(b.text || '').trim()) return res.status(400).json({ error: '목표 문장(text)이 비어 있습니다' });
  res.json(Goals.save({ ...b, id: undefined }));
});
agent.patch('/goals/:id', (req, res) => {
  if (!Goals.get(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(Goals.save({ ...(req.body || {}), id: req.params.id }));
});
agent.delete('/goals/:id', (req, res) => { Goals.remove(req.params.id); res.json({ ok: true }); });

agent.get('/heartbeat', (_req, res) => res.json(Heartbeats.all().slice(0, 50)));
agent.post('/heartbeat', async (_req, res) => res.json(await runHeartbeat()));

agent.get('/heartbeat/pending', (_req, res) => res.json(PendingActions.all().filter((p) => p.status === 'pending')));
agent.post('/heartbeat/pending/:id/approve', async (req, res) => {
  const r = await decidePending(req.params.id, { approve: true, by: req.body?.by || 'api' });
  res.status(r.ok ? 200 : 400).json(r);
});
agent.post('/heartbeat/pending/:id/reject', async (req, res) => {
  const r = await decidePending(req.params.id, { approve: false, by: req.body?.by || 'api' });
  res.status(r.ok ? 200 : 400).json(r);
});

/* ---------- 쉬운 시작 (specs/005) ---------- */

agent.get('/agent/status', async (_req, res) => res.json(await status()));
agent.get('/agent/activity', (_req, res) => res.json(activity()));
agent.post('/agent/quickstart', (_req, res) => res.json(quickstart()));

agent.post('/agent/claude-key', async (req, res) => {
  const r = await saveClaudeKey(req.body?.apiKey);
  res.status(r.ok ? 200 : 400).json(r);
});
agent.post('/agent/telegram-token', async (req, res) => {
  const r = await saveTelegramToken(req.body?.botToken);
  if (r.ok) await startTelegram({ onReceived: () => runHeartbeat() });   // 새 토큰으로 바로 듣기 시작
  res.status(r.ok ? 200 : 400).json(r);
});
agent.put('/agent/telegram', (req, res) => {
  try {
    if (req.body?.mode) setMode(req.body.mode);
    if (req.body?.goalId !== undefined) Settings.set('telegram', { goalId: req.body.goalId });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
agent.post('/agent/telegram/allow', (req, res) => res.json({ ok: true, settings: allowChat(req.body?.chatId) }));
agent.post('/agent/telegram/remove', (req, res) => res.json({ ok: true, settings: removeChat(req.body?.chatId) }));
agent.put('/agent/heartbeat', (req, res) => {
  const min = Math.max(0, Math.min(60, Number(req.body?.everyMin) || 0));
  Settings.set('agent', { heartbeatMin: min });
  res.json({ ok: true, everyMin: min, cron: applyHeartbeatSetting() });
});

/* ---------- 개인 비서 (specs/006) — 골라서 쓰기 · 말로 시키기 · 알림 ---------- */
agent.get('/templates', (_req, res) => res.json(listTemplates()));
agent.post('/templates/:id', (req, res) => {
  const r = createFromTemplate(req.params.id, req.body?.params || {});
  res.status(r.ok ? 200 : 400).json(r);
});
agent.post('/assistant', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 1000);
  if (!text.trim()) return res.status(400).json({ error: '말이 비어 있어요' });
  res.json(await handleAssistant({ text, channel: 'web' }));
});
agent.post('/assistant/confirm/:id', async (req, res) => res.json(await confirmAssistant(req.params.id, !!req.body?.yes)));
agent.put('/agent/notify', (req, res) => {
  const v = ['errors', 'all', 'off'].includes(req.body?.notify) ? req.body.notify : 'errors';
  Settings.set('agent', { notify: v });
  res.json({ ok: true, notify: v });
});

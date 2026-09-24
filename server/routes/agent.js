// 목표 · 하트비트 (specs/004-goals-heartbeat) — 목표 관리, 하트비트 한 번 돌리기, 승인 대기 제안 결정
import { Router } from 'express';
import { Goals, Heartbeats, PendingActions, Settings, People } from '../store.js';
import { runHeartbeat, decidePending } from '../heartbeat.js';
import { quickstart, status, activity, saveClaudeKey, saveTelegramToken, applyHeartbeatSetting, setLlm } from '../quickstart.js';
import { setMode, allowChat, removeChat, startTelegram } from '../telegramChannel.js';
import { listTemplates, createFromTemplate } from '../templates.js';
import { handleAssistant, confirmAssistant, parseTime } from '../assistant.js';
import { normLang, LANGS } from '../lang.js';

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
agent.put('/agent/llm', async (req, res) => {
  const r = await setLlm(req.body || {});
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
agent.post('/agent/telegram/allow', (req, res) => res.json({ ok: true, settings: allowChat(req.body?.chatId, { asOwner: req.body?.asOwner === true ? true : req.body?.asOwner === false ? false : undefined }) }));
agent.post('/agent/telegram/remove', (req, res) => res.json({ ok: true, settings: removeChat(req.body?.chatId) }));
agent.put('/agent/heartbeat', (req, res) => {
  const min = Math.max(0, Math.min(60, Number(req.body?.everyMin) || 0));
  Settings.set('agent', { heartbeatMin: min });
  res.json({ ok: true, everyMin: min, cron: applyHeartbeatSetting() });
});

/* ---------- 개인 비서 (specs/006) — 골라서 쓰기 · 말로 시키기 · 알림 ---------- */
// 화면은 PC 주인이 쓴다 — 템플릿·비서는 주인 것으로, 언어는 화면에서 고른 것(없으면 주인 설정)
const webLang = (req) => normLang(req.query?.lang || req.body?.lang || People.owner().lang);
agent.get('/templates', (req, res) => res.json(listTemplates(webLang(req), 'owner')));
agent.post('/templates/:id', (req, res) => {
  const r = createFromTemplate(req.params.id, req.body?.params || {}, { ownerId: 'owner' });
  res.status(r.ok ? 200 : 400).json(r);
});
agent.post('/assistant', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 1000);
  if (!text.trim()) return res.status(400).json({ error: '말이 비어 있어요' });
  res.json(await handleAssistant({ text, channel: 'web', ownerId: 'owner', lang: webLang(req) }));
});
agent.post('/assistant/confirm/:id', async (req, res) => res.json(await confirmAssistant(req.params.id, !!req.body?.yes, { ownerId: 'owner' })));

/* ---------- 사람 (specs/007) — 사람마다 따로 · 언어 · 일어나는 시각 · 관심사 ---------- */
agent.get('/people', (_req, res) => {
  People.owner();
  res.json(People.all().map(({ id, role, name, lang, wake, interests, chatId, onboarding }) => ({ id, role, name, lang, wake, interests, chatId, onboarding })));
});
agent.put('/people/:id', (req, res) => {
  const cur = req.params.id === 'owner' ? People.owner() : People.get(req.params.id);
  if (!cur) return res.status(404).json({ ok: false, error: '없는 사람이에요' });
  const b = req.body || {};
  const patch = { id: cur.id };
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 40);
  if (b.lang !== undefined) { if (!LANGS.includes(b.lang)) return res.status(400).json({ ok: false, error: 'lang: ko · en' }); patch.lang = b.lang; }
  if (b.wake !== undefined) {
    const w = b.wake ? parseTime(String(b.wake)) : null;
    if (b.wake && !w) return res.status(400).json({ ok: false, error: '일어나는 시각: 07:00 처럼' });
    patch.wake = w;
  }
  if (b.interests !== undefined) patch.interests = (Array.isArray(b.interests) ? b.interests : String(b.interests).split(',')).map((w) => String(w).trim().slice(0, 30)).filter(Boolean).slice(0, 10);
  res.json({ ok: true, person: People.save(patch) });
});
agent.put('/agent/notify', (req, res) => {
  const v = ['errors', 'all', 'off'].includes(req.body?.notify) ? req.body.notify : 'errors';
  Settings.set('agent', { notify: v });
  res.json({ ok: true, notify: v });
});

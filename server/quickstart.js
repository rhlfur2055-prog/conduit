// ============================================================
// 쉬운 시작 — 초보자가 노드를 몰라도 버튼 몇 번으로 쓰게 한다 (specs/005-telegram-two-way)
//   상태 점검 · 원클릭 준비(읽기 워크플로 + 목표 + 받은편지함) · Claude 키 / 텔레그램 토큰 확인 후 저장 · 하트비트 주기
//   비밀값(키·토큰)은 자격 증명에 암호화해 저장하고 화면에는 돌려주지 않는다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { Settings, Workflows, Goals, Credentials, Heartbeats, PendingActions, Approvals, Executions, DATA_DIR } from './store.js';
import { getApiKey } from './llm.js';
import { tgToken, tgChatIds, tgApiBase } from './telegram.js';
import { MODES, telegramMode, tgSettings, telegramRunning, inboxGoal } from './telegramChannel.js';
import { paddleHealth } from './ocrEnsemble.js';
import { runHeartbeat } from './heartbeat.js';

export const QUICK_WORKFLOW_NAME = '사진·글 읽고 답하기 (쉬운 시작)';

/** 원클릭 준비 — 이미 있으면 다시 만들지 않는다 */
export function quickstart() {
  const s = Settings.get('agent');
  let wf = s.quickWorkflowId ? Workflows.get(s.quickWorkflowId) : null;
  if (!wf) {
    const n = (id, kind, params, x) => ({ id, type: 'flow', position: { x, y: 160 }, data: { kind, params } });
    wf = Workflows.save({
      name: QUICK_WORKFLOW_NAME,
      active: true,
      nodes: [
        n('start', 'manualTrigger', {}, 80),
        n('read', 'socraticRead', { image: '{{ $json.image }}', title: '{{ $json.title }}', engine: 'auto', lang: 'kor+eng', rounds: '2', learn: 'true', memory: 'true', model: 'claude-sonnet-5' }, 340),
        n('done', 'output', {}, 600),
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'read', sourceHandle: 'main', targetHandle: 'main' },
        { id: 'e2', source: 'read', target: 'done', sourceHandle: 'main', targetHandle: 'main' },
      ],
    });
  }
  const inbox = path.join(DATA_DIR, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  let goal = s.quickGoalId ? Goals.get(s.quickGoalId) : null;
  if (!goal) goal = Goals.save({ text: '받은 사진·글을 읽고 기억하고, 보낸 사람에게 답한다', workflows: [wf.id], inbox });
  Settings.set('agent', { quickWorkflowId: wf.id, quickGoalId: goal.id });
  if (!tgSettings().goalId) Settings.set('telegram', { goalId: goal.id });
  if (s.heartbeatMin === undefined) Settings.set('agent', { heartbeatMin: 5 });
  applyHeartbeatSetting();
  return { workflowId: wf.id, goalId: goal.id, inbox };
}

/* ---------- 하트비트 주기 (화면에서 고름) ---------- */
let task = null;
let beating = false;
export function applyHeartbeatSetting() {
  if (task) { task.stop(); task = null; }
  const min = Number(Settings.get('agent').heartbeatMin) || 0;
  if (process.env.CONDUIT_HEARTBEAT || min <= 0) return null;          // .env 의 크론식이 있으면 그쪽이 돈다 (index.js)
  const expr = min >= 60 ? '0 * * * *' : `*/${Math.max(1, Math.floor(min))} * * * *`;
  if (!cron.validate(expr)) return null;
  task = cron.schedule(expr, async () => {
    if (beating) return;
    beating = true;
    try { await runHeartbeat(); } catch (e) { console.warn('[heartbeat] 오류:', e.message); } finally { beating = false; }
  });
  return expr;
}

/* ---------- 키 · 토큰 확인 후 저장 ---------- */
function replaceCredential(type, name, data) {
  for (const c of Credentials.all().filter((x) => x.type === type)) Credentials.remove(c.id);
  return Credentials.save({ type, name, data });
}

export async function saveClaudeKey(apiKey, { fetchImpl = fetch } = {}) {
  const key = String(apiKey || '').replace(/\s/g, '');
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return { ok: false, error: 'sk-ant- 로 시작하는 Anthropic API 키가 아니에요' };
  try {
    const anthropicBase = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const r = await fetchImpl(`${anthropicBase}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    if (r.status === 401) return { ok: false, error: 'Anthropic 이 이 키를 거부했어요 (401). 키를 다시 복사해 주세요' };
    if (r.status === 403) return { ok: false, error: '키는 맞지만 권한이 없어요 (403). 콘솔에서 결제·권한을 확인해 주세요' };
  } catch { /* 네트워크 문제 — 저장은 한다 */ }
  replaceCredential('anthropic', 'Claude (쉬운 시작)', { apiKey: key });
  return { ok: true, masked: `sk-ant-…${key.slice(-4)}` };
}

export async function saveTelegramToken(botToken, { fetchImpl = fetch } = {}) {
  const token = String(botToken || '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) return { ok: false, error: '봇 토큰 모양이 아니에요 (예: 123456789:AA…) — BotFather 가 준 값을 그대로 붙여 넣어 주세요' };
  let bot;
  try {
    const r = await fetchImpl(`${tgApiBase()}/bot${token}/getMe`);
    const d = await r.json();
    if (!d.ok) return { ok: false, error: `텔레그램이 이 토큰을 거부했어요: ${d.description || r.status}` };
    bot = d.result;
  } catch (e) {
    return { ok: false, error: `텔레그램에 연결하지 못했어요: ${e.message}` };
  }
  replaceCredential('telegram', `텔레그램 @${bot.username}`, { botToken: token });
  Settings.set('telegram', { botUsername: bot.username });
  return { ok: true, bot: { username: bot.username, name: bot.first_name } };
}

/* ---------- 상태 · 활동 ---------- */
export async function status() {
  const s = Settings.get('agent');
  const t = tgSettings();
  const goal = inboxGoal();
  return {
    claude: { connected: !!getApiKey() },
    telegram: {
      connected: !!tgToken(), polling: telegramRunning(), bot: t.botUsername || null,
      chats: tgChatIds(), pendingChats: t.pendingChats || [], mode: telegramMode(),
      modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])),
    },
    ocr: { paddle: await paddleHealth() },
    quickstart: { ready: !!(s.quickWorkflowId && Workflows.get(s.quickWorkflowId) && goal), workflowId: s.quickWorkflowId || null, goalId: goal?.id || null, inbox: goal?.inbox || null },
    heartbeat: { everyMin: Number(s.heartbeatMin) || 0, env: process.env.CONDUIT_HEARTBEAT || null },
  };
}

export function activity() {
  const readings = Executions.all()
    .filter((x) => x.trigger === 'agent' || x.trigger === 'webhook' || x.trigger === 'manual')
    .map((x) => {
      const out = Object.values(x.statuses || {}).map((st) => st?.output?.main?.[0]).find((o) => o?.reading);
      if (!out) return null;
      const r = out.reading;
      return {
        executionId: x.id, at: x.at, status: x.status, title: out.title || out.image?.split(/[\\/]/).pop() || '(제목 없음)',
        from: out.replyTo ? '휴대폰' : x.trigger === 'agent' ? '받은편지함' : x.trigger,
        sentences: r.sentences || [], unanswered: (r.unanswered || []).map((u) => u.q), stats: r.stats || null,
        simulated: !!r.simulated, note: r.note || null,
      };
    }).filter(Boolean).slice(0, 10);
  return {
    readings,
    heartbeats: Heartbeats.all().slice(0, 10).map((h) => ({ at: h.at, mode: h.mode, note: h.note, results: (h.results || []).map((r) => ({ verdict: r.verdict, reason: r.reason })) })),
    pendingActions: PendingActions.all().filter((p) => p.status === 'pending').map((p) => ({ id: p.id, reason: p.reason, workflowId: p.workflowId, input: p.input, createdAt: p.createdAt })),
    approvals: Approvals.all().filter((a) => a.status === 'pending').map((a) => ({ id: a.id, title: a.title, text: a.text, createdAt: a.createdAt })),
  };
}

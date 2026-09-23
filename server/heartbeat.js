// ============================================================
// 하트비트 — 스스로 일을 시작한다 (specs/004-goals-heartbeat)
//
//   상황 모으기 → 제안(LLM, 없으면 규칙) → 코드 검증 → 실행 / 사람 승인 대기 / 기록만 → 하트비트 기록
//
//   LLM 은 "무엇을 할지 제안" 만 한다. 실행은 코드가 검증한 뒤에만 한다 (원칙 I).
//     · 목표·워크플로·근거 ID 는 이번 상황에 실제로 있는 것만
//     · 입력의 파일 경로는 이번에 감지된 것만 (지어낸 경로로 아무 파일이나 읽게 하지 않는다)
//     · 부작용 노드(발행·메시지·코드 실행 등)가 있는 워크플로, 확신 낮은 제안, 승인 필요 목표 → 사람 승인
//   하트비트는 기억을 쓰지 않는다 — 기억은 워크플로(소크라테스식 읽기) 안의 검증을 거쳐서만 들어간다 (원칙 III).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { Goals, Heartbeats, InboxSeen, PendingActions, Workflows, Executions, People } from './store.js';
import { callLLM } from './llm.js';
import { parseJson } from './vision.js';
import cron from 'node-cron';
import { execute as runtimeExecute } from './runtime.js';

// 밖으로 무언가를 내보내거나 코드를 실행하는 노드 — 이런 워크플로는 자동 실행하지 않고 사람 승인을 받는다
export const SIDE_EFFECT_KINDS = new Set([
  'youtubeUpload', 'slack', 'gmail', 'telegram', 'notion', 'bloggerPublish', 'verifiedComment',
  'httpRequest', 'httpAuth', 'mcpTool', 'code', 'aiAgent',
]);
export const HEARTBEAT_LIMITS = Object.freeze({
  minConfidence: 0.7,
  dailyCap: Number(process.env.CONDUIT_HEARTBEAT_DAILY_CAP) || 50,
  perBeat: 5,
});
const INBOX_EXT = /\.(png|jpe?g|webp|gif|bmp|txt|md)$/i;
const TRIGGERS = new Set(['webhookTrigger', 'manualTrigger', 'scheduleTrigger']);

export const hasSideEffects = (wf) => (wf?.nodes || []).some((n) => SIDE_EFFECT_KINDS.has(n.data?.kind));

/** 목표의 받은편지함에서 아직 다루지 않은 파일 */
export function senseInbox(goal, seen = InboxSeen) {
  if (!goal?.inbox) return [];
  let names;
  try { names = fs.readdirSync(goal.inbox); } catch { return []; }
  return names
    .filter((n) => INBOX_EXT.test(n))
    .map((n) => {
      const p = path.join(goal.inbox, n);
      let st;
      try { st = fs.statSync(p); } catch { return null; }
      if (!st.isFile()) return null;
      // 텔레그램으로 받은 파일은 옆에 .meta.json 이 있다 — 답장할 곳(replyTo)은 코드가 여기서만 정한다
      let replyTo = null;
      try {
        const meta = JSON.parse(fs.readFileSync(`${p}.meta.json`, 'utf8'));
        // 누가 보냈나도 코드가 정한다 — 사람 기록(채팅 → 사람)에서만 찾는다 (specs/007)
        if (meta?.chatId) replyTo = { chatId: String(meta.chatId), messageId: meta.messageId ?? null, source: meta.source ?? null, ownerId: People.byChat(meta.chatId)?.id || null };
      } catch { /* 폴더에 직접 넣은 파일 */ }
      return { path: p, name: n, size: st.size, key: `${goal.id}|${p}|${st.size}|${Math.round(st.mtimeMs)}`, replyTo };
    })
    .filter((f) => f && !seen.has(f.key))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const today = (iso) => String(iso ?? '').slice(0, 10);

/** 이번 하트비트의 상황 — 모든 항목에 ID(G·I·W·E)를 붙인다. 제안은 이 ID 로만 말할 수 있다 */
export function gatherContext({ now = Date.now(), goals, workflows, executions, heartbeats, seen } = {}) {
  const allGoals = (goals ?? Goals.all()).filter((g) => g.active !== false);
  const wfAll = workflows ?? Workflows.all();
  const beats = heartbeats ?? Heartbeats.all();

  const lastRunOf = (goalId) => beats.flatMap((b) => (b.results || []).filter((r) => r.goalId === goalId && r.execution?.id).map(() => b.at))[0];
  const G = allGoals.map((goal, i) => {
    const last = lastRunOf(goal.id);
    const due = goal.cadenceMin > 0 && (!last || now - Date.parse(last) >= goal.cadenceMin * 60000);
    return { ref: `G${i + 1}`, goal, due, lastRunAt: last ?? null };
  });
  const I = [];
  for (const g of G) for (const f of senseInbox(g.goal, seen)) I.push({ ref: `I${I.length + 1}`, goalRef: g.ref, goalId: g.goal.id, ...f });
  const allowed = new Set(G.flatMap((g) => g.goal.workflows));
  const W = wfAll.filter((w) => allowed.has(w.id)).map((wf, i) => ({ ref: `W${i + 1}`, wf, sideEffects: hasSideEffects(wf) }));
  const E = (executions ?? Executions.all()).filter((x) => allowed.has(x.workflowId)).slice(0, 5)
    .map((x, i) => ({ ref: `E${i + 1}`, id: x.id, workflowId: x.workflowId, workflowName: x.workflowName, status: x.status, at: x.at }));
  const D = beats.slice(0, 5).flatMap((b) => (b.results || []).map((r) => ({ at: b.at, goalId: r.goalId, verdict: r.verdict, reason: r.reason })));
  const refs = new Set([...G, ...I, ...W, ...E].map((x) => x.ref));
  return { now, goals: G, inputs: I, workflows: W, executions: E, decisions: D.slice(0, 10), refs };
}

export function contextBlock(ctx) {
  const lines = [`지금: ${new Date(ctx.now).toISOString()}`, '', '목표:'];
  for (const g of ctx.goals) {
    const ws = ctx.workflows.filter((w) => g.goal.workflows.includes(w.wf.id)).map((w) => w.ref).join(', ') || '(없음)';
    lines.push(`${g.ref}: ${g.goal.text} — 허용 워크플로 ${ws}${g.goal.cadenceMin ? ` · 주기 ${g.goal.cadenceMin}분 (${g.due ? '지금 할 때' : '아직'})` : ''}${g.goal.inbox ? ' · 받은편지함 있음' : ''}`);
  }
  lines.push('', '새로 들어온 것:');
  lines.push(...(ctx.inputs.length ? ctx.inputs.map((i) => `${i.ref}: [${i.goalRef}] ${i.name} (${i.size} bytes) 경로 ${i.path}`) : ['(없음)']));
  lines.push('', '워크플로:');
  lines.push(...ctx.workflows.map((w) => `${w.ref}: ${w.wf.name}${w.sideEffects ? ' — 밖으로 내보내는 동작 있음(사람 승인 필요)' : ''}`));
  lines.push('', '최근 실행:');
  lines.push(...(ctx.executions.length ? ctx.executions.map((x) => `${x.ref}: ${x.workflowName} ${x.status} ${x.at ?? ''}`) : ['(없음)']));
  lines.push('', '최근 하트비트 결정 (참고):');
  lines.push(...(ctx.decisions.length ? ctx.decisions.map((d) => `- ${d.at?.slice(0, 16)} ${d.verdict} ${d.reason ?? ''}`) : ['(없음)']));
  return lines.join('\n');
}

const HEARTBEAT_SYSTEM = `너는 사람이 정한 목표를 이루기 위해 다음 할 일을 "제안" 하는 에이전트다. 실행은 네가 하지 않는다 — 코드가 검증한 뒤 실행한다.
규칙:
- 주어진 ID(G·I·W·E)만 쓴다. 없는 ID 나 없는 파일 경로를 만들지 마라.
- 목표마다 제안한다: run(워크플로 실행) · wait(지금 할 일 없음) · ask(사람에게 물어야 함).
- run 은 그 목표에 허용된 워크플로만. 새로 들어온 것(I)을 처리할 때는 inputRef 에 그 I 를 적고, input 에 {"image": 그 I 의 경로, "title": 파일 이름} 을 넣는다. 새로 들어온 것 하나당 run 하나.
- 새로 들어온 것도 없고 주기도 아니면 wait. 확신이 없으면 ask.
- evidence 에는 근거 ID 를 넣는다 (최소 목표 G, 입력을 처리하면 그 I). confidence 는 0~1.
JSON 하나만 출력한다:
{"actions":[{"goal":"G1","action":"run","workflow":"W1","inputRef":"I1","input":{"image":"…","title":"…"},"reason":"…","evidence":["G1","I1"],"confidence":0.9}]}`;

/** 규칙 모드 (LLM 없음) — 허용 워크플로가 하나일 때만 새 입력·주기로 실행을 제안한다 */
export function ruleProposals(ctx) {
  const out = [];
  for (const g of ctx.goals) {
    const ws = ctx.workflows.filter((w) => g.goal.workflows.includes(w.wf.id));
    const ins = ctx.inputs.filter((i) => i.goalRef === g.ref);
    if (ws.length === 1 && ins.length) {
      for (const i of ins) out.push({ goal: g.ref, action: 'run', workflow: ws[0].ref, inputRef: i.ref, input: { image: i.path, title: i.name }, reason: '규칙: 새 입력', evidence: [g.ref, i.ref], confidence: 1 });
    } else if (ws.length === 1 && g.due) {
      out.push({ goal: g.ref, action: 'run', workflow: ws[0].ref, input: {}, reason: '규칙: 주기가 됨', evidence: [g.ref], confidence: 1 });
    } else {
      out.push({ goal: g.ref, action: 'wait', reason: ws.length > 1 && (ins.length || g.due) ? '규칙 모드는 워크플로가 여럿이면 고르지 않는다 (LLM 필요)' : '새 입력도 주기도 없음', evidence: [g.ref] });
    }
  }
  return out;
}

const looksLikePath = (s) => typeof s === 'string' && (/^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]/.test(s) || /\.(png|jpe?g|webp|gif|bmp|txt|md|pdf|json|js)$/i.test(s));
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * 제안 하나를 검증한다 (결정론).
 * @returns {{ verdict:'run'|'approval'|'wait'|'asked'|'rejected'|'skipped', reason:string, g?, w?, input?, item? }}
 */
export function validate(p, ctx, state, limits = HEARTBEAT_LIMITS) {
  const g = ctx.goals.find((x) => x.ref === p?.goal);
  if (!g) return { verdict: 'rejected', reason: `없는 목표 ${p?.goal}` };
  if (p.action === 'wait') return { verdict: 'wait', reason: String(p.reason ?? ''), g };

  const ev = Array.isArray(p.evidence) ? p.evidence.map(String) : [];
  if (!ev.length) return { verdict: 'rejected', reason: '근거 없음', g };
  const fake = ev.filter((r) => !ctx.refs.has(r));
  if (fake.length) return { verdict: 'rejected', reason: `없는 근거 ${fake.join(', ')}`, g };
  if (p.action === 'ask' && !p.workflow) return { verdict: 'asked', reason: String(p.reason ?? ''), g };
  if (p.action !== 'run' && p.action !== 'ask') return { verdict: 'rejected', reason: `알 수 없는 동작 ${p.action}`, g };

  const w = ctx.workflows.find((x) => x.ref === p.workflow);
  if (!w) return { verdict: 'rejected', reason: `없는 워크플로 ${p.workflow}`, g };
  if (!g.goal.workflows.includes(w.wf.id)) return { verdict: 'rejected', reason: `목표 ${g.ref} 에 허용되지 않은 워크플로 ${w.ref}`, g };

  // replyTo 는 LLM 이 정할 수 없다 (다른 채팅으로 보내게 하지 못하도록) — 제안에 있으면 버린다
  const { replyTo: _ignored, ownerId: _ignoredOwner, ...input } = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input : {};
  if (JSON.stringify(input).length > 4000) return { verdict: 'rejected', reason: '입력이 너무 크다', g };
  const mine = ctx.inputs.filter((i) => i.goalRef === g.ref);
  if (p.inputRef && !mine.some((i) => i.ref === p.inputRef)) return { verdict: 'rejected', reason: `목표 ${g.ref} 의 입력이 아닌 ${p.inputRef}`, g };
  // 경로처럼 보이는 값은 감지된 입력의 경로이거나, 그 입력의 파일 이름(제목)과 정확히 같아야 한다
  const unknownPath = strings(input).filter(looksLikePath).find((s) => !mine.some((i) => samePath(i.path, s) || s === i.name));
  if (unknownPath) return { verdict: 'rejected', reason: `감지되지 않은 경로 ${unknownPath}`, g };
  const item = p.inputRef ? mine.find((i) => i.ref === p.inputRef) : mine.find((i) => strings(input).some((s) => looksLikePath(s) && samePath(i.path, s)));
  if (item && !strings(input).some((s) => looksLikePath(s) && samePath(item.path, s))) return { verdict: 'rejected', reason: `${item.ref} 를 처리한다면서 입력에 그 경로가 없다`, g };

  if (item && state.handled.has(item.key)) return { verdict: 'skipped', reason: `${item.ref} 는 이번 하트비트에서 이미 다뤘다`, g };
  if (!item && !g.due) return { verdict: 'skipped', reason: '새 입력도 주기도 아닌데 실행하려 했다', g };
  if (state.runsToday >= limits.dailyCap) return { verdict: 'skipped', reason: `하루 실행 상한 ${limits.dailyCap}`, g };
  if (state.runsThisBeat >= limits.perBeat) return { verdict: 'skipped', reason: `하트비트 한 번 실행 상한 ${limits.perBeat}`, g };

  const conf = Number(p.confidence);
  const why = [];
  if (p.action === 'ask') why.push('에이전트가 물어봄');
  if (!(conf >= limits.minConfidence)) why.push(`확신도 ${Number.isFinite(conf) ? conf : '없음'} < ${limits.minConfidence}`);
  if (g.goal.requireApproval) why.push('목표가 실행 전 승인을 요구');
  if (w.sideEffects) why.push('밖으로 내보내는 동작이 있는 워크플로');
  if (why.length) return { verdict: 'approval', reason: why.join(' · '), g, w, input, item };
  return { verdict: 'run', reason: String(p.reason ?? ''), g, w, input, item };
}

function triggerSeed(wf, input) {
  const t = (wf.nodes || []).find((n) => TRIGGERS.has(n.data?.kind));
  return t ? { [t.id]: { main: { ...input, _agent: { heartbeat: true } } } } : {};
}

/**
 * 하트비트 한 번.
 * @param {object} [p._deps] 테스트용 { llm, execute, goals, workflows, executions, heartbeats, seen, pending }
 */
export async function runHeartbeat({ now = Date.now(), limits = HEARTBEAT_LIMITS, _deps = {} } = {}) {
  const llm = _deps.llm || callLLM;
  const exec = _deps.execute || runtimeExecute;
  const notify = _deps.notify || (async (replyTo, execution) => (await import('./telegramChannel.js')).sendResult(replyTo, execution));
  const seen = _deps.seen || InboxSeen;
  const pending = _deps.pending || PendingActions;
  const beats = _deps.heartbeats || Heartbeats;
  const ctx = gatherContext({ now, goals: _deps.goals, workflows: _deps.workflows, executions: _deps.executions, heartbeats: beats.all(), seen });

  if (!ctx.goals.length) return beats.add({ mode: 'idle', note: '활성 목표 없음', results: [] });

  let mode = 'llm';
  let note;
  let proposals;
  let usage;
  const r = await llm({ system: HEARTBEAT_SYSTEM, prompt: contextBlock(ctx), maxTokens: 2048 });
  if (r.simulated || r.error) {
    mode = 'rule';
    note = r.simulated ? 'LLM 키가 없어 규칙 모드' : `LLM 오류 → 규칙 모드 (${String(r.text).slice(0, 120)})`;
    proposals = ruleProposals(ctx);
  } else {
    usage = r.usage;
    const j = parseJson(r.text);
    if (Array.isArray(j?.actions)) proposals = j.actions;
    else { mode = 'rule'; note = '제안 JSON 파싱 실패 → 규칙 모드'; proposals = ruleProposals(ctx); }
  }

  const todayRuns = beats.all().filter((b) => today(b.at) === today(new Date(now).toISOString()))
    .flatMap((b) => b.results || []).filter((x) => x.execution?.id).length;
  const state = { handled: new Set(), runsToday: todayRuns, runsThisBeat: 0 };
  const results = [];
  for (const p of proposals.slice(0, 20)) {
    const v = validate(p, ctx, state, limits);
    const row = {
      goalId: v.g?.goal.id ?? null, goal: p?.goal, action: p?.action, workflow: v.w?.wf.id ?? null,
      inputRef: v.item?.ref ?? p?.inputRef ?? null, verdict: v.verdict, reason: v.reason, confidence: p?.confidence ?? null,
    };
    if (v.verdict === 'run') {
      state.runsThisBeat++;
      state.runsToday++;
      if (v.item) { state.handled.add(v.item.key); seen.mark(v.item.key, { status: 'run', goalId: row.goalId }); }
      const replyTo = v.item?.replyTo || null;
      try {
        // 기억은 보낸 사람 것으로 — 보낸 사람을 모르면(폴더에 직접 넣은 파일) PC 주인 것
        const seed = replyTo ? { ...v.input, replyTo, ownerId: replyTo.ownerId || 'owner' } : v.input;
        const res = await exec(v.w.wf, { seed: triggerSeed(v.w.wf, seed), trigger: 'agent' });
        row.execution = { id: res.execution.id, status: res.execution.status };
        // 휴대폰에서 온 입력이면 결과를 그 채팅으로 답장 (모드가 보내기를 허용할 때만 — telegramChannel 이 판단)
        if (replyTo) {
          try { row.reply = await notify(replyTo, res.execution); } catch (e) { row.reply = { error: e.message }; }
        }
      } catch (e) {
        row.execution = { id: null, status: 'error', error: e.message };
      }
    } else if (v.verdict === 'approval') {
      if (v.item) { state.handled.add(v.item.key); seen.mark(v.item.key, { status: 'awaiting', goalId: row.goalId }); }
      row.pendingId = pending.add({ goalId: row.goalId, workflowId: v.w.wf.id, input: v.input, reason: v.reason, proposal: p }).id;
    }
    results.push(row);
  }
  return beats.add({ mode, note, usage, inputs: ctx.inputs.length, results });
}

/** 사람 승인 대기 제안을 실행 · 거절 */
export async function decidePending(id, { approve, by = 'api', _deps = {} } = {}) {
  const pending = _deps.pending || PendingActions;
  const exec = _deps.execute || runtimeExecute;
  const rec = pending.get(id);
  if (!rec) return { ok: false, error: '없는 제안' };
  if (rec.status !== 'pending') return { ok: true, already: true, status: rec.status };
  if (!approve) return { ok: true, status: pending.update(id, { status: 'rejected', by, decidedAt: new Date().toISOString() }).status };
  const wf = (_deps.workflows || Workflows.all()).find((w) => w.id === rec.workflowId);
  if (!wf) return { ok: false, error: '워크플로가 없어졌다' };
  pending.update(id, { status: 'approved', by, decidedAt: new Date().toISOString() });
  const res = await exec(wf, { seed: triggerSeed(wf, rec.input || {}), trigger: 'agent' });
  pending.update(id, { executionId: res.execution.id });
  return { ok: true, status: 'approved', executionId: res.execution.id };
}

// CONDUIT_HEARTBEAT (크론식, 예: 10분마다 = "*/10 * * * *") 로 주기 실행. 앞 하트비트가 아직 돌면 건너뛴다
let beating = false;
export function startHeartbeat(expr = process.env.CONDUIT_HEARTBEAT) {
  if (!expr) return null;
  if (!cron.validate(expr)) { console.warn(`[heartbeat] 크론식이 올바르지 않음: ${expr}`); return null; }
  return cron.schedule(expr, async () => {
    if (beating) return;
    beating = true;
    try {
      const hb = await runHeartbeat();
      const ran = (hb.results || []).filter((r) => r.execution?.id).length;
      if (ran || (hb.results || []).some((r) => r.verdict !== 'wait')) console.log(`[heartbeat] ${hb.mode} · 실행 ${ran} · ${hb.results.map((r) => r.verdict).join(', ')}`);
    } catch (e) {
      console.warn('[heartbeat] 오류:', e.message);
    } finally {
      beating = false;
    }
  });
}

// ============================================================
// 사람 승인 게이트 — 워크플로가 "사람 승인 대기" 노드에서 멈추고, 텔레그램 버튼으로 결정하면 이어서 실행한다.
//
//   두 단계로 멈춘다:
//     1) 노드 실행 중: requestApproval() 이 기록을 'preparing' 으로 만들고 { __wait } 를 돌려준다. 메시지는 아직 안 보낸다.
//     2) 실행이 끝난 뒤: runtime.execute() 가 "끝난 노드 전부"의 출력을 스냅샷으로 넘기며 finalizeApproval() 을 부른다.
//        그때 메시지를 보내고 'pending' 이 된다. → 실행이 끝나기 전에 버튼을 누를 수 없고, 재개 때 어떤 노드도 두 번 돌지 않는다.
//   재개: 스냅샷을 seed 로 주입해 같은 워크플로를 다시 실행 → approved/rejected/expired 포트 하나로만 흐른다.
//   결정은 멱등(두 번 눌러도 한 번만). 재개가 실패하면 사람에게 "승인됐지만 실행 실패"를 알리고 🔁 다시 시도 버튼을 남긴다.
//   서버가 재시작돼도 대기 건은 파일에 남는다. 재개 도중 죽은 건은 기동 시 찾아 다시 시도하라고 알린다.
// ============================================================
import { Approvals } from './store.js';
import { execute } from './runtime.js';
import * as tg from './telegram.js';

const adapters = {
  telegram: {
    ready: () => !!tg.tgToken(),
    defaultChat: () => tg.tgDefaultChat(),
    send: (a) => tg.sendApproval(a),
    decided: (a) => tg.markDecided(a),
    remind: (a) => tg.sendReminder(a),
  },
};
/** 테스트·다른 채널(Slack 등) 어댑터 교체 */
export function setApprovalAdapter(name, adapter) { adapters[name] = adapter; }

// 빈 문자열·0·음수는 기본값으로 — "0분 뒤 만료" 같은 사고를 막는다
const minutes = (n, fallback) => {
  if (n === '' || n === null || n === undefined) return fallback;
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const PORT = Object.freeze({ approve: 'approved', reject: 'rejected', expired: 'expired' });
const STATUS = Object.freeze({ approve: 'approved', reject: 'rejected', expired: 'expired' });
const nowISO = () => new Date().toISOString();

/** 승인 노드(run)에서 호출 — 기록만 만들고 { waiting } 을 돌려준다. 메시지는 finalizeApproval 이 보낸다. */
export async function requestApproval({ channel = 'telegram', chatId, title, text, remindAfterMin, expireAfterMin, item, _ctx = {} }) {
  const ad = adapters[channel];
  if (!ad) return { error: `지원하지 않는 승인 채널: ${channel}` };
  if (!ad.ready()) return { error: `${channel} 승인 채널이 설정되지 않았습니다 (TELEGRAM_BOT_TOKEN)` };
  const chat = chatId || ad.defaultChat();
  if (!chat) return { error: '승인 받을 채팅 ID 가 없습니다 (노드 설정 또는 TELEGRAM_CHAT_ID)' };
  const { flow, meta = {}, nodeId } = _ctx;
  if (!flow?.nodes || !nodeId) return { error: '실행 컨텍스트가 없어 승인 대기를 만들 수 없습니다' };

  const now = Date.now();
  const remind = minutes(remindAfterMin, 60);
  const expire = minutes(expireAfterMin, 1440);
  if (expire <= remind) console.warn(`[approval] 만료(${expire}분)가 리마인드(${remind}분)보다 빠릅니다 — 리마인드는 오지 않습니다`);
  const rec = Approvals.add({
    status: 'preparing',
    channel, chatId: String(chat), title: String(title || '승인 요청'), text: String(text ?? ''), item: item ?? {},
    nodeId, workflowId: meta.workflowId ?? null, workflowName: meta.workflowName ?? null, trigger: meta.trigger ?? null,
    flow: { nodes: flow.nodes, edges: flow.edges }, snapshot: {},
    remindAt: new Date(now + remind * 60000).toISOString(),
    expireAt: new Date(now + expire * 60000).toISOString(),
    resumeStatus: null,
  });
  return { waiting: true, approvalId: rec.id, channel };
}

/**
 * runtime.execute 가 실행 종료 후 호출 — 스냅샷 확정 → 메시지 전송 → pending.
 * 전송에 실패하면 'failed' 로 남기고 던진다(실행 로그에 오류로 잡히도록).
 */
export async function finalizeApproval(approvalId, snapshot) {
  const rec = Approvals.get(approvalId);
  if (!rec) throw new Error(`없는 승인 요청: ${approvalId}`);
  if (rec.status !== 'preparing') return rec;                       // 이미 확정됨 (멱등)
  Approvals.update(rec.id, { snapshot: snapshot || {} });
  const ad = adapters[rec.channel];
  try {
    const sent = await ad.send({ chatId: rec.chatId, approvalId: rec.id, title: rec.title, text: rec.text, workflowName: rec.workflowName });
    return Approvals.update(rec.id, { status: 'pending', messageId: sent?.messageId ?? null, chatId: sent?.chatId ?? rec.chatId });
  } catch (e) {
    Approvals.update(rec.id, { status: 'failed', error: e.message });
    throw e;
  }
}

const firstError = (statuses = {}) => Object.values(statuses).find((s) => s.status === 'error')?.error || '실행 오류';

/** 스냅샷 + 결정을 seed 로 주입해 같은 워크플로를 다시 실행 */
async function resume(rec, { decision, editedText, by, at }) {
  const approval = { id: rec.id, decision, text: editedText || rec.text, edited: !!editedText, by, at, requestedAt: rec.createdAt };
  const seed = { ...(rec.snapshot || {}), [rec.nodeId]: { [PORT[decision]]: [{ ...(rec.item || {}), approval }] } };
  Approvals.update(rec.id, { resumeStatus: 'resuming', resumeStartedAt: nowISO() });
  let result = null;
  let error = null;
  try {
    result = await execute(
      { id: rec.workflowId, name: rec.workflowName || '(승인 재개)', nodes: rec.flow.nodes, edges: rec.flow.edges },
      { seed, trigger: 'approval' },
    );
  } catch (e) {
    error = e.message;
  }
  const ok = !!result && result.execution.status !== 'error';
  const resumeError = error || (!ok && result ? firstError(result.statuses) : null);
  const patch = { resumedExecutionId: result?.execution?.id ?? null, resumeStatus: ok ? 'done' : 'error', resumeError, resumeEndedAt: nowISO() };
  if (ok) { patch.flow = undefined; patch.snapshot = undefined; }   // 성공하면 큰 데이터는 버린다 (실패하면 재시도용으로 유지)
  Approvals.update(rec.id, patch);
  if (!ok) console.error(`[approval] 재개 실패 ${rec.id}: ${resumeError}`);
  return { ok, executionId: result?.execution?.id ?? null, error: resumeError };
}

async function notifyDecided(rec, { decision, by, editedText }, r) {
  const ad = adapters[rec.channel];
  if (!ad?.decided || !rec.messageId) return;
  try {
    await ad.decided({
      chatId: rec.chatId, messageId: rec.messageId, approvalId: rec.id, title: rec.title, text: rec.text,
      decision, by, editedText, resumeOk: r.ok, resumeError: r.error,
    });
  } catch (e) {
    console.warn(`[approval] 결과 메시지 편집 실패 ${rec.id}: ${e.message}`);
  }
}

/**
 * 결정 — 멱등. fromChatId 를 주면 요청을 보낸 채팅과 같아야 한다.
 * @returns {{ ok:boolean, already?:boolean, status?:string, executionId?:string|null, resumeStatus?:string, resumeError?:string|null, error?:string }}
 */
export async function decide(approvalId, { decision, editedText, by = 'unknown', fromChatId } = {}) {
  const rec = Approvals.get(approvalId);
  if (!rec) return { ok: false, error: '없는 승인 요청입니다' };
  if (!Object.hasOwn(PORT, decision)) return { ok: false, error: `알 수 없는 결정: ${decision}` };
  if (fromChatId !== undefined && String(fromChatId) !== String(rec.chatId)) return { ok: false, error: '요청을 보낸 채팅이 아닙니다' };
  if (rec.status === 'preparing') return { ok: false, error: '아직 준비 중입니다. 잠시 뒤 다시 눌러주세요' };
  if (rec.status !== 'pending') return { ok: true, already: true, status: rec.status, resumeStatus: rec.resumeStatus };

  const at = nowISO();
  const status = STATUS[decision];
  Approvals.update(rec.id, { status, decision, editedText: editedText || null, by, decidedAt: at });
  const r = await resume(Approvals.get(rec.id), { decision, editedText, by, at });
  await notifyDecided(rec, { decision, by, editedText }, r);
  return { ok: true, status, executionId: r.executionId, resumeStatus: r.ok ? 'done' : 'error', resumeError: r.error };
}

/** 재개가 실패한 건을 같은 결정으로 다시 실행 (🔁 버튼) */
export async function retryResume(approvalId, { fromChatId } = {}) {
  const rec = Approvals.get(approvalId);
  if (!rec) return { ok: false, error: '없는 승인 요청입니다' };
  if (fromChatId !== undefined && String(fromChatId) !== String(rec.chatId)) return { ok: false, error: '요청을 보낸 채팅이 아닙니다' };
  if (rec.status === 'pending' || rec.status === 'preparing') return { ok: false, error: '아직 결정되지 않은 요청입니다' };
  if (rec.resumeStatus === 'done') return { ok: true, already: true, status: rec.status, resumeStatus: 'done' };
  if (rec.resumeStatus === 'resuming') return { ok: false, error: '지금 실행 중입니다' };
  if (!rec.flow || !rec.snapshot || !rec.decision) return { ok: false, error: '재실행 데이터가 없습니다' };
  const r = await resume(rec, { decision: rec.decision, editedText: rec.editedText, by: rec.by, at: rec.decidedAt });
  await notifyDecided(rec, { decision: rec.decision, by: rec.by, editedText: rec.editedText }, r);
  return { ok: true, status: rec.status, executionId: r.executionId, resumeStatus: r.ok ? 'done' : 'error', resumeError: r.error };
}

/** 주기 점검 — 리마인드 1회(전송 성공 시에만 표시), 만료되면 expired 포트로 재개 */
export async function tick(now = Date.now()) {
  const out = { reminded: 0, expired: 0 };
  for (const rec of Approvals.pending()) {
    if (Date.parse(rec.expireAt) <= now) {
      await decide(rec.id, { decision: 'expired', by: 'system' });
      out.expired++;
      continue;
    }
    if (!rec.reminded && Date.parse(rec.remindAt) <= now) {
      try {
        await adapters[rec.channel]?.remind?.({ chatId: rec.chatId, messageId: rec.messageId, title: rec.title });
        Approvals.update(rec.id, { reminded: true });
        out.reminded++;
      } catch (e) {
        console.warn(`[approval] 리마인드 실패 ${rec.id}: ${e.message}`);   // 다음 tick 에 다시 시도
      }
    }
  }
  return out;
}

let ticking = false;
export function startApprovalTimer(intervalMs = 60000) {
  const t = setInterval(async () => {
    if (ticking) return;                        // 이전 점검이 아직 돌면 겹치지 않는다
    ticking = true;
    try { await tick(); } catch (e) { console.warn('[approval] 점검 오류:', e.message); } finally { ticking = false; }
  }, intervalMs);
  t.unref?.();
  return t;
}

/** 서버 기동 시 — 실행 도중 죽은 건을 정리하고 알린다 */
export async function recoverAtBoot() {
  const out = { failedPreparing: 0, interruptedResume: 0 };
  for (const rec of Approvals.all()) {
    if (rec.status === 'preparing') {
      Approvals.update(rec.id, { status: 'failed', error: '실행이 끝나기 전에 서버가 종료됨' });
      out.failedPreparing++;
    } else if (rec.resumeStatus === 'resuming') {
      Approvals.update(rec.id, { resumeStatus: 'error', resumeError: '재개 도중 서버가 종료됨' });
      out.interruptedResume++;
      await notifyDecided(rec, { decision: rec.decision, by: rec.by, editedText: rec.editedText }, { ok: false, error: '재개 도중 서버가 종료됨' });
    }
  }
  if (out.failedPreparing || out.interruptedResume) console.warn(`[approval] 기동 정리: 준비 중 실패 ${out.failedPreparing}건 · 재개 중단 ${out.interruptedResume}건`);
  return out;
}

/** 텔레그램 롱폴링을 결정 처리에 연결. 토큰이 없으면 null. */
export function startTelegramApprovals() {
  if (!tg.tgToken()) return null;
  return tg.startPolling({
    onDecision: ({ approvalId, action, by, chatId, editedText }) =>
      action === 'retry'
        ? retryResume(approvalId, { fromChatId: chatId })
        : decide(approvalId, { decision: action, editedText, by, fromChatId: chatId }),
  });
}

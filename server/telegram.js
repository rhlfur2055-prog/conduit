// ============================================================
// 텔레그램 봇 — 승인 버튼 메시지 전송 + 롱폴링 수신
//   공개 URL 없이 동작한다(getUpdates 롱폴링). 노트북에서 돌려도 버튼 콜백을 받는다.
//   토큰: .env TELEGRAM_BOT_TOKEN
//   허용 채팅: TELEGRAM_CHAT_ID (쉼표로 여러 개, 첫 번째가 기본 채팅)
//   허용 사용자(선택): TELEGRAM_ALLOWED_USER_IDS — 그룹 채팅에서 아무나 누르지 못하게
//   화면(쉬운 시작)에서 넣은 토큰은 자격 증명(type=telegram, 암호화)에, 허용 채팅은 설정(settings.telegram.chatIds)에 있다.
// ============================================================
import { Credentials, Settings } from './store.js';

// TELEGRAM_API_BASE — 로컬 끝까지 테스트에서 가짜 텔레그램 서버를 가리킬 때만 쓴다 (기본값은 진짜 주소)
export const tgApiBase = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const API = (token) => `${tgApiBase()}/bot${token}`;
const MAX_TEXT = 3500;                                   // 텔레그램 메시지 4096자 제한 안쪽

function credentialToken() {
  try {
    const c = Credentials.all().find((x) => x.type === 'telegram');
    return c ? (Credentials.reveal(c.id)?.botToken || '') : '';
  } catch { return ''; }
}
export const tgToken = () => process.env.TELEGRAM_BOT_TOKEN || credentialToken();
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
export const tgChatIds = () => [...new Set([...csv(process.env.TELEGRAM_CHAT_ID), ...(Settings.get('telegram').chatIds || []).map(String)])];
export const tgUserIds = () => csv(process.env.TELEGRAM_ALLOWED_USER_IDS);
export const tgDefaultChat = () => tgChatIds()[0] || '';

/** Bot API 호출. 실패하면 description 을 담은 오류를 던진다 (status = error_code). URL(토큰)은 오류에 넣지 않는다. */
export async function tgCall(method, body, { token = tgToken(), fetchImpl = fetch, timeoutMs = 45000 } = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN 이 없습니다');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${API(token)}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const e = new Error(`텔레그램 ${method} 실패: ${data.description || res.status}`);
      e.status = data.error_code || res.status;
      if (data.parameters?.retry_after) e.retryAfter = data.parameters.retry_after;
      throw e;
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

const clip = (s, n = MAX_TEXT) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '\n…(잘림)' : s; };

/** 노드용: 메시지 보내기 */
export async function telegramSend({ chatId, text }, opts = {}) {
  const token = opts.token ?? tgToken();
  if (!token) return { simulated: true, note: '텔레그램 크리덴셜(TELEGRAM_BOT_TOKEN) 없음' };
  const chat = chatId || tgDefaultChat();
  if (!chat) return { ok: false, error: '채팅 ID 가 없습니다 (노드 설정 또는 TELEGRAM_CHAT_ID)' };
  const r = await tgCall('sendMessage', { chat_id: chat, text: clip(text, 4000), disable_web_page_preview: true }, { ...opts, token });
  return { ok: true, messageId: r.message_id, chatId: String(r.chat?.id ?? chat) };
}

/* ---------- 승인 버튼 ---------- */
export const buildCallback = (approvalId, action) => `ap:${approvalId}:${action}`;
export function parseCallback(data) {
  const m = /^ap:([A-Za-z0-9_-]{1,40}):(approve|edit|reject|retry)$/.exec(String(data || ''));
  return m ? { approvalId: m[1], action: m[2] } : null;
}
export const approvalKeyboard = (approvalId) => ({
  inline_keyboard: [[
    { text: '✅ 승인', callback_data: buildCallback(approvalId, 'approve') },
    { text: '✏️ 수정', callback_data: buildCallback(approvalId, 'edit') },
    { text: '❌ 거절', callback_data: buildCallback(approvalId, 'reject') },
  ]],
});
const retryKeyboard = (approvalId) => ({ inline_keyboard: [[{ text: '🔁 다시 시도', callback_data: buildCallback(approvalId, 'retry') }]] });

export const approvalText = ({ title, text, workflowName, approvalId }) =>
  [`🔔 ${title || '승인 요청'}`, workflowName ? `워크플로: ${workflowName}` : null, '', clip(text), '', `버튼을 눌러 결정하세요. [${approvalId || '-'}]`]
    .filter((l) => l !== null).join('\n');

const DECISION_LABEL = { approve: '✅ 승인됨', reject: '❌ 거절됨', expired: '⌛ 만료됨' };

/** 승인 요청 메시지(버튼 포함) → { messageId, chatId } */
export async function sendApproval({ chatId, approvalId, title, text, workflowName }, opts = {}) {
  const r = await tgCall('sendMessage', {
    chat_id: chatId, text: approvalText({ title, text, workflowName, approvalId }),
    reply_markup: approvalKeyboard(approvalId), disable_web_page_preview: true,
  }, opts);
  return { messageId: r.message_id, chatId: String(r.chat?.id ?? chatId) };
}

/**
 * 결정 뒤 원래 메시지를 결과로 바꾼다(버튼 제거).
 * 재개가 실패했으면 "승인됐지만 이후 실행 실패"를 분명히 쓰고 🔁 다시 시도 버튼을 남긴다.
 * 메시지가 없어졌으면 새로 보낸다.
 */
export async function markDecided({ chatId, messageId, approvalId, title, text, decision, by, editedText, resumeOk = true, resumeError }, opts = {}) {
  const label = DECISION_LABEL[decision] || decision;
  const head = resumeOk === false
    ? `⚠️ ${label}${by ? ` · ${by}` : ''} — 하지만 이후 실행이 실패했습니다\n원인: ${resumeError || '알 수 없음'}`
    : `${label}${by ? ` · ${by}` : ''}`;
  const body = [head, title || '', '', editedText ? `수정된 내용:\n${clip(editedText)}` : clip(text)].join('\n');
  const payload = { chat_id: chatId, text: body, disable_web_page_preview: true };
  if (resumeOk === false && approvalId) payload.reply_markup = retryKeyboard(approvalId);
  try {
    await tgCall('editMessageText', { message_id: messageId, ...payload }, opts);
  } catch (e) {
    console.warn(`[telegram] 메시지 편집 실패(${e.message}) — 새로 보냅니다`);
    await tgCall('sendMessage', payload, opts);
  }
}

export async function sendReminder({ chatId, messageId, title }, opts = {}) {
  const body = { chat_id: chatId, text: `⏰ 아직 결정되지 않은 승인 요청이 있습니다: ${title || ''}` };
  if (messageId) body.reply_to_message_id = messageId;
  await tgCall('sendMessage', body, opts);
}

const EDIT_PROMPT = (approvalId) => `수정할 내용을 이 메시지에 답장으로 보내주세요. [${approvalId}]`;
const refInReply = (m) => /\[(ap_[A-Za-z0-9_-]+)\]/.exec(String(m?.reply_to_message?.text || ''))?.[1] || null;

/**
 * 롱폴링 수신 루프.
 *   버튼 → 즉시 "처리 중" 응답 → onDecision({ approvalId, action, by, chatId, userId, editedText? })
 *          결과는 onDecision 쪽(markDecided)이 메시지를 고쳐 알린다.
 *   ✏️ 수정 → "[ap_id] 에 답장으로 보내주세요" 안내. 그 안내에 대한 답장만 수정본으로 받는다 (메모리 상태 없음 → 재시작·여러 건에 안전)
 *   🔁 다시 시도 → action:'retry'
 *   /start · /id → 채팅 ID·사용자 ID 를 알려준다
 *   allowedChatIds / allowedUserIds 밖에서 온 결정은 무시한다
 * @returns {{ stop: () => void }}
 */
export function startPolling({
  token = tgToken(), allowedChatIds = tgChatIds, allowedUserIds = tgUserIds(), onDecision, onMessage, onCallback,
  fetchImpl = fetch, log = console.log, retryMs = 2000, idleMs = 0,
} = {}) {
  let running = true;
  let offset = 0;
  let conflictLogged = false;
  // 허용 채팅은 함수로도 받는다 — 화면에서 채팅을 허용하면 재시작 없이 바로 반영된다
  const chats = () => (typeof allowedChatIds === 'function' ? allowedChatIds() : allowedChatIds);
  const allowed = (chatId, userId) =>
    (!chats().length || chats().includes(String(chatId))) &&
    (!allowedUserIds.length || allowedUserIds.includes(String(userId)));
  // 받기(사진·글)는 허용 목록이 비어 있으면 아무도 허용하지 않는다 — 승인 버튼보다 엄격하게
  const allowedStrict = (chatId, userId) => chats().includes(String(chatId)) && allowed(chatId, userId);
  const call = (m, b) => tgCall(m, b, { token, fetchImpl });
  const who = (from) => (from?.username ? '@' + from.username : (from?.first_name || String(from?.id || '')));
  const outcomeText = (r, okText) => (r?.already ? '이미 처리된 요청입니다'
    : r?.ok === false ? (r.error || '처리하지 못했습니다')
      : r?.resumeStatus === 'error' ? `${okText} — 하지만 이후 실행이 실패했습니다 (메시지 참고)`
        : okText);

  const handle = async (u) => {
    if (u.callback_query) {
      const q = u.callback_query;
      const chatId = String(q.message?.chat?.id ?? '');
      const userId = String(q.from?.id ?? '');
      const parsed = parseCallback(q.data);
      if (!parsed && onCallback) return onCallback(q, { call, allowed: allowedStrict(chatId, userId), chatId, userId });
      if (!parsed) return call('answerCallbackQuery', { callback_query_id: q.id });
      if (!allowed(chatId, userId)) {
        log(`[telegram] 허용되지 않은 채팅/사용자(${chatId}/${userId})의 콜백 무시`);
        return call('answerCallbackQuery', { callback_query_id: q.id, text: '권한이 없습니다' });
      }
      if (parsed.action === 'edit') {
        await call('sendMessage', { chat_id: chatId, text: EDIT_PROMPT(parsed.approvalId), reply_markup: { force_reply: true, selective: true } });
        return call('answerCallbackQuery', { callback_query_id: q.id, text: '수정 내용을 답장으로 보내주세요' });
      }
      // 재개 실행이 길어질 수 있으니 버튼에는 먼저 답하고, 결과는 메시지 편집으로 알린다
      await call('answerCallbackQuery', { callback_query_id: q.id, text: '처리 중…' }).catch(() => {});
      const r = await onDecision({ approvalId: parsed.approvalId, action: parsed.action, by: who(q.from), chatId, userId });
      if (r?.ok === false || r?.already) {
        await call('sendMessage', { chat_id: chatId, text: outcomeText(r, ''), reply_to_message_id: q.message?.message_id }).catch(() => {});
      }
      return r;
    }
    if (u.message) {
      const m = u.message;
      const chatId = String(m.chat?.id ?? '');
      const userId = String(m.from?.id ?? '');
      const text = String(m.text || '');
      if (/^\/(start|id)\b/.test(text)) {
        if (onMessage) await onMessage(m, { call, allowed: allowedStrict(chatId, userId), chatId, userId, command: 'start' });
        if (onMessage) return null;                          // 연결 안내는 채널 쪽이 한다 (허용 여부에 따라 다르게)
        return call('sendMessage', { chat_id: chatId, text: `이 채팅의 ID: ${chatId}\n사용자 ID: ${userId}\n\n.env 의 TELEGRAM_CHAT_ID 에 채팅 ID 를 넣으면 승인 요청이 여기로 옵니다.` });
      }
      const approvalId = refInReply(m);                              // ✏️ 안내 메시지에 대한 답장인가
      if (approvalId && text.trim()) {
        if (!allowed(chatId, userId)) return log(`[telegram] 허용되지 않은 채팅/사용자(${chatId}/${userId})의 수정 답장 무시`);
        const r = await onDecision({ approvalId, action: 'approve', by: who(m.from), chatId, userId, editedText: text.trim() });
        return call('sendMessage', { chat_id: chatId, text: outcomeText(r, '수정한 내용으로 승인했습니다'), reply_to_message_id: m.message_id });
      }
      if (onMessage) return onMessage(m, { call, allowed: allowedStrict(chatId, userId), chatId, userId });
    }
  };

  (async () => {
    // 웹훅이 걸려 있으면 getUpdates 가 409 로 막힌다 — 롱폴링으로 전환
    await call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    let backoff = retryMs;
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query', 'message'] });
        backoff = retryMs;
        conflictLogged = false;
        for (const u of updates || []) {
          offset = u.update_id + 1;
          try { await handle(u); } catch (e) { log(`[telegram] 업데이트 처리 오류: ${e.message}`); }
        }
        if (!updates?.length && idleMs) await new Promise((r) => setTimeout(r, idleMs));
      } catch (e) {
        if (!running) break;
        if (e.status === 409 && !conflictLogged) {
          conflictLogged = true;
          log('[telegram] 409 Conflict — 같은 봇 토큰으로 다른 프로세스가 getUpdates 중입니다. 이 인스턴스는 버튼을 받지 못합니다. 다른 서버를 끄세요.');
        } else if (e.status !== 409) {
          log(`[telegram] 폴링 오류: ${e.message} — ${backoff}ms 후 재시도`);
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  })();
  return { stop: () => { running = false; } };
}

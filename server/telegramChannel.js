// ============================================================
// 텔레그램 양방향 (specs/005-telegram-two-way)
//   받기  — 휴대폰 → PC : 허용 채팅의 사진·이미지 파일·글을 목표의 받은편지함에 저장하고, 하트비트를 바로 돌린다
//   보내기 — PC → 휴대폰 : 받은 것을 읽은 결과를 보낸 채팅으로 답장한다 (내용은 코드가 만든다)
//   모드는 사용자가 고른다: 둘 다 · 받기만 · 보내기만 · 끄기 (기본 끄기). 화면(쉬운 시작) 또는 텔레그램 /mode
//   허용되지 않은 채팅이 말을 걸면 "연결 요청" 으로 기록하고, 화면에서 [허용] 을 누르면 연결된다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { Settings, Goals, Heartbeats } from './store.js';
import * as tg from './telegram.js';

export const MODES = Object.freeze({
  both: { receive: true, send: true, label: '둘 다 (휴대폰 ↔ PC)' },
  inbound: { receive: true, send: false, label: '받기만 (휴대폰 → PC)' },
  outbound: { receive: false, send: true, label: '보내기만 (PC → 휴대폰)' },
  off: { receive: false, send: false, label: '끄기' },
});
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

export const tgSettings = () => ({ mode: 'off', chatIds: [], goalId: null, pendingChats: [], ...Settings.get('telegram') });
export const telegramMode = () => (MODES[tgSettings().mode] ? tgSettings().mode : 'off');
export const canReceive = () => MODES[telegramMode()].receive;
export const canSend = () => MODES[telegramMode()].send;

export function setMode(mode) {
  if (!MODES[mode]) throw new Error(`알 수 없는 모드: ${mode}`);
  return Settings.set('telegram', { mode });
}

/** 연결 요청을 허용 — 허용 채팅에 넣고 요청 목록에서 뺀다 */
export function allowChat(chatId) {
  const s = tgSettings();
  const id = String(chatId);
  return Settings.set('telegram', {
    chatIds: [...new Set([...(s.chatIds || []).map(String), id])],
    pendingChats: (s.pendingChats || []).filter((c) => String(c.chatId) !== id),
  });
}
export function removeChat(chatId) {
  const s = tgSettings();
  return Settings.set('telegram', { chatIds: (s.chatIds || []).map(String).filter((c) => c !== String(chatId)) });
}

function notePending(m) {
  const s = tgSettings();
  const chatId = String(m.chat?.id ?? '');
  if ((s.pendingChats || []).some((c) => String(c.chatId) === chatId)) return false;
  const name = m.chat?.title || [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || chatId;
  Settings.set('telegram', { pendingChats: [...(s.pendingChats || []), { chatId, name, username: m.from?.username || null, at: new Date().toISOString() }].slice(-20) });
  return true;
}

/** 받은 것을 넣을 받은편지함 — 설정에서 고른 목표, 없으면 받은편지함이 있는 첫 목표 */
export function inboxGoal() {
  const s = tgSettings();
  const goals = Goals.all().filter((g) => g.active !== false && g.inbox);
  return goals.find((g) => g.id === s.goalId) || goals[0] || null;
}

export const modeKeyboard = () => ({
  inline_keyboard: Object.entries(MODES).map(([k, v]) => [{ text: `${telegramMode() === k ? '● ' : ''}${v.label}`, callback_data: `md:${k}` }]),
});

function statusText() {
  const hb = Heartbeats.all()[0];
  const goal = inboxGoal();
  return [
    `모드: ${MODES[telegramMode()].label}`,
    `받은 것을 넣는 곳: ${goal ? goal.text : '(없음 — 화면의 쉬운 시작에서 준비하세요)'}`,
    `마지막 하트비트: ${hb ? `${hb.at.slice(0, 16).replace('T', ' ')} · ${(hb.results || []).map((r) => r.verdict).join(', ') || hb.mode}` : '(없음)'}`,
  ].join('\n');
}

/** 텔레그램 파일 받기 — getFile 로 경로를 얻고 파일 서버에서 받는다 */
async function download(fileId, { call, token = tg.tgToken(), fetchImpl = fetch }) {
  const f = await call('getFile', { file_id: fileId });
  if (!f?.file_path) throw new Error('파일 경로를 받지 못했습니다');
  if (f.file_size && f.file_size > MAX_BYTES) throw new Error('10MB 보다 큽니다');
  const r = await fetchImpl(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
  if (!r.ok) throw new Error(`파일 받기 실패 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('10MB 보다 큽니다');
  return { buf, ext: path.extname(f.file_path).slice(1).toLowerCase() };
}

/**
 * 메시지 처리 (telegram.startPolling 의 onMessage).
 * @returns {Promise<{saved?:string, ignored?:string}>}
 */
export async function handleMessage(m, { call, allowed, chatId, command, onReceived = () => {}, fetchImpl, token } = {}) {
  const say = (text) => call('sendMessage', { chat_id: chatId, text, reply_to_message_id: m.message_id }).catch(() => {});
  if (!allowed) {
    const first = notePending(m);
    if (first || command === 'start') await say('안녕하세요! 이 채팅은 아직 연결되지 않았어요.\nPC 의 conduit "쉬운 시작" 화면에서 [허용] 을 누르면 연결됩니다.');
    return { ignored: 'not_allowed' };
  }
  const text = String(m.text || '').trim();
  if (command === 'start') { await say(`연결되어 있어요 ✅\n${statusText()}\n\n사진이나 글을 보내면 PC 가 읽어요. /mode 로 받기·보내기를 고를 수 있어요.`); return { ignored: 'command' }; }
  if (/^\/mode\b/.test(text)) { await call('sendMessage', { chat_id: chatId, text: '어떻게 주고받을까요?', reply_markup: modeKeyboard() }); return { ignored: 'command' }; }
  if (/^\/status\b/.test(text)) { await say(statusText()); return { ignored: 'command' }; }
  if (text.startsWith('/')) { await say('쓸 수 있는 명령: /mode · /status'); return { ignored: 'command' }; }

  if (!canReceive()) { await say(`지금은 받지 않아요 (모드: ${MODES[telegramMode()].label}).\n/mode 로 바꿀 수 있어요.`); return { ignored: 'mode' }; }
  const goal = inboxGoal();
  if (!goal) { await say('받은 것을 넣을 곳이 없어요. PC 의 "쉬운 시작" 화면에서 [시작 준비] 를 눌러 주세요.'); return { ignored: 'no_inbox' }; }

  let buf;
  let ext;
  try {
    if (m.photo?.length) {
      ({ buf, ext } = await download(m.photo[m.photo.length - 1].file_id, { call, fetchImpl, token }));
      ext = ext || 'jpg';
    } else if (m.document && IMAGE_EXT[m.document.mime_type]) {
      if (m.document.file_size > MAX_BYTES) throw new Error('10MB 보다 큽니다');
      ({ buf } = await download(m.document.file_id, { call, fetchImpl, token }));
      ext = IMAGE_EXT[m.document.mime_type];
    } else if (m.document?.mime_type === 'text/plain') {
      ({ buf } = await download(m.document.file_id, { call, fetchImpl, token }));
      ext = 'txt';
    } else if (text) {
      buf = Buffer.from(text, 'utf8');
      ext = 'txt';
    } else {
      await say('사진이나 글만 받을 수 있어요.');
      return { ignored: 'type' };
    }
  } catch (e) {
    await say(`받지 못했어요: ${e.message}`);
    return { ignored: 'download' };
  }

  fs.mkdirSync(goal.inbox, { recursive: true });
  const file = path.join(goal.inbox, `tg_${chatId}_${m.message_id}.${ext}`);
  fs.writeFileSync(file, buf);
  fs.writeFileSync(`${file}.meta.json`, JSON.stringify({
    source: 'telegram', chatId: String(chatId), messageId: m.message_id,
    from: m.from?.username || m.from?.first_name || null, caption: m.caption || null, receivedAt: new Date().toISOString(),
  }, null, 2));
  await say(canSend() ? '받았어요 📥 읽고 나서 알려 드릴게요.' : '받았어요 📥 (보내기가 꺼져 있어 결과는 PC 에서만 볼 수 있어요)');
  Promise.resolve().then(onReceived).catch(() => {});
  return { saved: file };
}

/** 모드 버튼 (telegram.startPolling 의 onCallback) */
export async function handleCallback(q, { call, allowed, chatId }) {
  const m = /^md:(both|inbound|outbound|off)$/.exec(String(q.data || ''));
  if (!m) return call('answerCallbackQuery', { callback_query_id: q.id });
  if (!allowed) return call('answerCallbackQuery', { callback_query_id: q.id, text: '연결되지 않은 채팅이에요' });
  setMode(m[1]);
  await call('answerCallbackQuery', { callback_query_id: q.id, text: `${MODES[m[1]].label} 로 바꿨어요` });
  return call('editMessageText', { chat_id: chatId, message_id: q.message?.message_id, text: `모드: ${MODES[m[1]].label}`, reply_markup: modeKeyboard() }).catch(() => {});
}

/** 실행 결과를 사람이 읽을 답장으로 — 검증된 요약 문장 · 원문에 없던 질문 · 대기 여부 (코드가 만든다) */
export function formatResult(execution) {
  const outs = Object.values(execution?.statuses || {}).map((s) => s?.output?.main?.[0]).filter(Boolean);
  const reading = outs.map((o) => o.reading).find((r) => r && !r.simulated && Array.isArray(r.sentences));
  const lines = [];
  if (reading) {
    lines.push('📖 읽은 내용');
    lines.push(...(reading.sentences.length ? reading.sentences.map((s) => `• ${s}`) : ['• 근거가 확인된 문장이 없어요']));
    if (reading.unanswered?.length) lines.push('', `❓ 문서에 없던 것: ${reading.unanswered.map((u) => u.q).join(' · ')}`);
    const st = reading.stats || {};
    lines.push('', `검증 ${st.verified ?? 0}/${st.questions ?? 0} · 근거율 ${st.groundedRatio ?? '-'}${reading.memory?.recalled?.length ? ` · 전에 읽은 것 ${reading.memory.recalled.length}건과 연결` : ''}`);
  } else {
    const sim = outs.map((o) => o.reading).find((r) => r?.simulated);
    lines.push(sim ? `읽기를 건너뛰었어요: ${sim.note || 'Claude 키가 없어요'}` : `처리했어요 (${execution?.status ?? '?'})`);
  }
  if (execution?.status === 'waiting') lines.push('', '⏸ 다음 단계는 승인을 기다려요.');
  if (execution?.status === 'error') lines.push('', '⚠️ 처리 중 오류가 있었어요. PC 의 실행 기록을 확인해 주세요.');
  return lines.join('\n');
}

/** 받은 채팅으로 결과 답장 — 모드가 보내기를 허용하고, 허용 채팅일 때만 */
export async function sendResult(replyTo, execution, { send = tg.telegramSend } = {}) {
  if (!replyTo?.chatId) return { skipped: '답장할 곳 없음' };
  if (!canSend()) return { skipped: '보내기 꺼짐' };
  if (!tg.tgChatIds().includes(String(replyTo.chatId))) return { skipped: '허용되지 않은 채팅' };
  return send({ chatId: replyTo.chatId, text: formatResult(execution) });
}

/* ---------- 폴링 시작 (승인 버튼 + 받기 + 모드) ---------- */
let poller = null;
export async function startTelegram({ onReceived } = {}) {
  if (poller) { poller.stop(); poller = null; }
  if (!tg.tgToken()) return null;
  const { decide, retryResume } = await import('./approvals.js');
  poller = tg.startPolling({
    onDecision: ({ approvalId, action, by, chatId, editedText }) => (action === 'retry'
      ? retryResume(approvalId, { fromChatId: chatId })
      : decide(approvalId, { decision: action, editedText, by, fromChatId: chatId })),
    onMessage: (m, ctx) => handleMessage(m, { ...ctx, onReceived }),
    onCallback: (q, ctx) => handleCallback(q, ctx),
  });
  return poller;
}
export const telegramRunning = () => !!poller;

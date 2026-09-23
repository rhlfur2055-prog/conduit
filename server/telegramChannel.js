// ============================================================
// 텔레그램 양방향 (specs/005-telegram-two-way · 007-people-and-languages)
//   받기  — 휴대폰 → PC : 허용 채팅의 사진·이미지 파일·글을 목표의 받은편지함에 저장하고, 하트비트를 바로 돌린다
//   보내기 — PC → 휴대폰 : 받은 것을 읽은 결과를 보낸 채팅으로 답장한다 (내용은 코드가 만든다)
//   모드는 사용자가 고른다: 둘 다 · 받기만 · 보내기만 · 끄기 (기본 끄기). 화면(쉬운 시작) 또는 텔레그램 /mode (PC 주인만)
//   허용되지 않은 채팅이 말을 걸면 "연결 요청" 으로 기록하고, 화면에서 [허용] 을 누르면 연결된다.
//   사람마다 따로: 채팅 하나 = 한 사람. 처음 연결되면 언어 → 이름 → 일어나는 시각 → 관심사를 묻는다.
//   답은 그 사람 언어로, 확인 버튼은 요청한 사람만, 받은 파일은 보낸 사람의 기억으로.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { Settings, Goals, Heartbeats, Workflows, People } from './store.js';
import * as tg from './telegram.js';
import { t, normLang, MODE_LABEL } from './lang.js';

export const MODES = Object.freeze({
  both: { receive: true, send: true, label: MODE_LABEL.ko.both },
  inbound: { receive: true, send: false, label: MODE_LABEL.ko.inbound },
  outbound: { receive: false, send: true, label: MODE_LABEL.ko.outbound },
  off: { receive: false, send: false, label: MODE_LABEL.ko.off },
});
const modeLabel = (mode, L) => MODE_LABEL[normLang(L)][mode] || mode;
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

/* ---------- 사람 ---------- */

/** 채팅의 사람 — 없으면 만든다 (처음 연결: 언어부터 묻는다) */
export function personForChat(chatId, m = null) {
  const found = People.byChat(chatId);
  if (found) return found;
  // 예전(사람 기록 전)부터 연결돼 있던 첫 채팅 = PC 주인의 휴대폰 (그동안 알림이 가던 곳)
  const owner = People.owner();
  if (!owner.chatId && tg.tgDefaultChat() === String(chatId)) return People.save({ id: 'owner', chatId: String(chatId) });
  const name = m ? (m.from?.first_name || m.chat?.title || m.from?.username || '') : '';
  return People.save({ id: `p_${chatId}`, chatId: String(chatId), role: 'member', lang: m?.from?.language_code?.startsWith('ko') ? 'ko' : m?.from?.language_code ? 'en' : 'ko', name, onboarding: 'lang' });
}
const langOfChat = (chatId) => normLang(People.byChat(chatId)?.lang);
const isOwnerPerson = (p) => p?.id === 'owner' || p?.role === 'owner';

/** 연결 요청을 허용 — 허용 채팅에 넣고 요청 목록에서 뺀다. 처음 연결하는 채팅이면 PC 주인의 휴대폰으로 본다 */
export function allowChat(chatId, { asOwner } = {}) {
  const s = tgSettings();
  const id = String(chatId);
  const pending = (s.pendingChats || []).find((c) => String(c.chatId) === id);
  const owner = People.owner();
  const first = !(s.chatIds || []).length;
  if (!People.byChat(id)) {
    if (asOwner === true || (asOwner !== false && !owner.chatId && first)) People.save({ id: 'owner', chatId: id, ...(owner.name ? {} : { name: pending?.name || '' }) });
    else People.save({ id: `p_${id}`, chatId: id, role: 'member', name: pending?.name || '', onboarding: 'lang' });
  }
  return Settings.set('telegram', {
    chatIds: [...new Set([...(s.chatIds || []).map(String), id])],
    pendingChats: (s.pendingChats || []).filter((c) => String(c.chatId) !== id),
  });
}
export function removeChat(chatId) {
  const s = tgSettings();
  const owner = People.get('owner');
  if (owner?.chatId === String(chatId)) People.save({ id: 'owner', chatId: null });
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

export const modeKeyboard = (L = 'ko') => ({
  inline_keyboard: Object.keys(MODES).map((k) => [{ text: `${telegramMode() === k ? '● ' : ''}${modeLabel(k, L)}`, callback_data: `md:${k}` }]),
});
const langKeyboard = () => ({ inline_keyboard: [[{ text: '한국어', callback_data: 'lg:ko' }, { text: 'English', callback_data: 'lg:en' }]] });

function statusText(L = 'ko') {
  const hb = Heartbeats.all()[0];
  const goal = inboxGoal();
  return [
    t(L, 'statusMode', { mode: modeLabel(telegramMode(), L) }),
    t(L, 'statusInbox', { inbox: goal ? goal.text : t(L, 'statusInboxNone') }),
    t(L, 'statusBeat', { beat: hb ? `${hb.at.slice(0, 16).replace('T', ' ')} · ${(hb.results || []).map((r) => r.verdict).join(', ') || hb.mode}` : t(L, 'none') }),
  ].join('\n');
}

/** 텔레그램 파일 받기 — getFile 로 경로를 얻고 파일 서버에서 받는다 */
async function download(fileId, { call, token = tg.tgToken(), fetchImpl = fetch }) {
  const f = await call('getFile', { file_id: fileId });
  if (!f?.file_path) throw new Error('파일 경로를 받지 못했습니다');
  if (f.file_size && f.file_size > MAX_BYTES) throw new Error('10MB 보다 큽니다');
  const r = await fetchImpl(`${tg.tgApiBase()}/file/bot${token}/${f.file_path}`);
  if (!r.ok) throw new Error(`파일 받기 실패 ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('10MB 보다 큽니다');
  return { buf, ext: path.extname(f.file_path).slice(1).toLowerCase() };
}

/* ---------- 처음 연결 — 내 정보 묻기 ---------- */

const SKIP = /^(건너뛰기|건너뛰|스킵|없음|없어|skip|none|no|pass|-)$/i;
async function parseWake(text) {
  const { parseTime } = await import('./assistant.js');
  return parseTime(/^\d{1,2}$/.test(text.trim()) ? `${text.trim()}시` : text);
}

/** 온보딩 한 단계 — 처리했으면 true */
async function onboardingStep(person, text, say, call, chatId) {
  const L = normLang(person.lang);
  const step = person.onboarding;
  if (step === 'lang') {
    await call('sendMessage', { chat_id: chatId, text: t(L, 'obLang'), reply_markup: langKeyboard() }).catch(() => {});
    return true;
  }
  if (step === 'name') {
    const name = SKIP.test(text) || !text ? person.name || '' : text.slice(0, 40);
    const p = People.save({ id: person.id, name, onboarding: 'wake' });
    await say(t(L, 'obWake', { name: p.name || (L === 'en' ? 'friend' : '') }).replace(/^님, /, ''));
    return true;
  }
  if (step === 'wake') {
    if (!SKIP.test(text)) {
      const wake = await parseWake(text);
      if (!wake) { await say(t(L, 'obBadTime')); return true; }
      People.save({ id: person.id, wake });
    }
    People.save({ id: person.id, onboarding: 'interests' });
    await say(t(L, 'obInterests'));
    return true;
  }
  if (step === 'interests') {
    const interests = SKIP.test(text) ? [] : text.split(/[,，、·\n]/).map((w) => w.trim()).filter(Boolean).slice(0, 10).map((w) => w.slice(0, 30));
    const p = People.save({ id: person.id, interests, onboarding: 'done' });
    await say(t(L, 'obDone', { name: p.name || '', help: t(L, 'help') }));
    return true;
  }
  return false;
}

/**
 * 메시지 처리 (telegram.startPolling 의 onMessage).
 * @returns {Promise<{saved?:string, ignored?:string, onboarding?:string, assistant?:string}>}
 */
export async function handleMessage(m, { call, allowed, chatId, command, onReceived = () => {}, fetchImpl, token } = {}) {
  const say = (text) => call('sendMessage', { chat_id: chatId, text, reply_to_message_id: m.message_id }).catch(() => {});
  if (!allowed) {
    const first = notePending(m);
    const L = m.from?.language_code && !m.from.language_code.startsWith('ko') ? 'en' : 'ko';
    if (first || command === 'start') await say(t(L, 'notConnected'));
    return { ignored: 'not_allowed' };
  }
  const person = personForChat(chatId, m);
  const L = normLang(person.lang);
  const text = String(m.text || '').trim();

  if (/^\/me\b/.test(text)) {
    People.save({ id: person.id, onboarding: 'lang' });
    await onboardingStep({ ...person, onboarding: 'lang' }, '', say, call, chatId);
    return { onboarding: 'lang' };
  }
  // 처음 연결 — 내 정보를 다 묻기 전에는 다른 일을 하지 않는다 (PC 주인은 건너뛴다)
  if (person.onboarding && person.onboarding !== 'done' && !isOwnerPerson(person)) {
    await onboardingStep(person, command === 'start' || text.startsWith('/') ? '' : text, say, call, chatId);
    return { onboarding: People.get(person.id)?.onboarding };
  }

  if (command === 'start') { await say(t(L, 'connected', { status: statusText(L) })); return { ignored: 'command' }; }
  if (/^\/mode\b/.test(text)) { await call('sendMessage', { chat_id: chatId, text: t(L, 'modeAsk'), reply_markup: modeKeyboard(L) }); return { ignored: 'command' }; }
  if (/^\/status\b/.test(text)) { await say(statusText(L)); return { ignored: 'command' }; }
  if (text.startsWith('/')) { await say(t(L, 'commands')); return { ignored: 'command' }; }

  // 짧은 글은 비서에게 하는 말 — 긴 글(200자 이상)이나 "읽어줘 …"/"read: …" 는 읽을 글
  const isCommand = text && !m.photo?.length && !m.document && text.length < 200 && !/^(읽어\s*줘|read\s*(this)?\s*:)/i.test(text);
  if (isCommand) {
    if (telegramMode() === 'off') { await say(t(L, 'tgOff')); return { ignored: 'mode' }; }
    const { handleAssistant } = await import('./assistant.js');
    const r = await handleAssistant({ text, channel: 'telegram', ownerId: person.id, chatId });
    await call('sendMessage', {
      chat_id: chatId, text: r.reply, reply_to_message_id: m.message_id,
      ...(r.buttons ? { reply_markup: { inline_keyboard: [r.buttons.map((b) => ({ text: b.label, callback_data: b.value }))] } } : {}),
    }).catch(() => {});
    return { assistant: r.action, understood: r.understood };
  }

  if (!canReceive()) { await say(t(L, 'notReceiving', { mode: modeLabel(telegramMode(), L) })); return { ignored: 'mode' }; }
  const goal = inboxGoal();
  if (!goal) { await say(t(L, 'noInbox')); return { ignored: 'no_inbox' }; }

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
      buf = Buffer.from(text.replace(/^(읽어\s*줘|read\s*(this)?\s*:)[:\s]*/i, ''), 'utf8');
      ext = 'txt';
    } else {
      await say(t(L, 'onlyPhotoText'));
      return { ignored: 'type' };
    }
  } catch (e) {
    await say(t(L, 'gotFail', { error: e.message }));
    return { ignored: 'download' };
  }

  fs.mkdirSync(goal.inbox, { recursive: true });
  const file = path.join(goal.inbox, `tg_${chatId}_${m.message_id}.${ext}`);
  fs.writeFileSync(file, buf);
  fs.writeFileSync(`${file}.meta.json`, JSON.stringify({
    source: 'telegram', chatId: String(chatId), messageId: m.message_id,
    from: m.from?.username || m.from?.first_name || null, caption: m.caption || null, receivedAt: new Date().toISOString(),
  }, null, 2));
  await say(canSend() ? t(L, 'gotReply') : t(L, 'gotNoReply'));
  Promise.resolve().then(onReceived).catch(() => {});
  return { saved: file };
}

/** 버튼 (telegram.startPolling 의 onCallback) — 비서 확인 · 언어 · 모드 */
export async function handleCallback(q, { call, allowed, chatId }) {
  const data = String(q.data || '');
  const L = langOfChat(chatId);
  const notConnected = () => call('answerCallbackQuery', { callback_query_id: q.id, text: L === 'en' ? 'This chat isn\'t connected' : '연결되지 않은 채팅이에요' });

  const a = /^as:([A-Za-z0-9_-]{1,40}):(yes|no)$/.exec(data);
  if (a) {
    if (!allowed) return notConnected();
    const person = personForChat(chatId);
    const { confirmAssistant } = await import('./assistant.js');
    const r = await confirmAssistant(a[1], a[2] === 'yes', { ownerId: person.id });
    // 다른 사람의 요청 — 버튼 글은 그대로 두고 누른 사람에게만 알린다
    if (r.denied) return call('answerCallbackQuery', { callback_query_id: q.id, text: r.reply }).catch(() => {});
    await call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    return call('editMessageText', { chat_id: chatId, message_id: q.message?.message_id, text: r.reply }).catch(() => {});
  }

  const lg = /^lg:(ko|en)$/.exec(data);
  if (lg) {
    if (!allowed) return notConnected();
    const person = personForChat(chatId);
    const next = person.onboarding === 'lang' ? (isOwnerPerson(person) ? 'done' : 'name') : person.onboarding;
    const p = People.save({ id: person.id, lang: lg[1], onboarding: next });
    await call('answerCallbackQuery', { callback_query_id: q.id, text: lg[1] === 'en' ? 'English' : '한국어' }).catch(() => {});
    const msg = next === 'name' ? t(p.lang, 'obName') : t(p.lang, 'help');
    return call('editMessageText', { chat_id: chatId, message_id: q.message?.message_id, text: msg }).catch(() => {});
  }

  const m = /^md:(both|inbound|outbound|off)$/.exec(data);
  if (!m) return call('answerCallbackQuery', { callback_query_id: q.id });
  if (!allowed) return notConnected();
  // 모드는 모두에게 걸리는 설정 — PC 주인만 바꾼다
  if (!isOwnerPerson(People.byChat(chatId))) {
    return call('answerCallbackQuery', { callback_query_id: q.id, text: L === 'en' ? 'Only the PC owner can change the mode' : '모드는 PC 주인만 바꿀 수 있어요' });
  }
  setMode(m[1]);
  await call('answerCallbackQuery', { callback_query_id: q.id, text: t(L, 'modeChanged', { mode: modeLabel(m[1], L) }) });
  return call('editMessageText', { chat_id: chatId, message_id: q.message?.message_id, text: t(L, 'modeNow', { mode: modeLabel(m[1], L) }), reply_markup: modeKeyboard(L) }).catch(() => {});
}

/** 실행 결과를 사람이 읽을 답장으로 — 검증된 요약 문장 · 원문에 없던 질문 · 대기 여부 (코드가 만든다) */
export function formatResult(execution, lang = 'ko') {
  const L = normLang(lang);
  const outs = Object.values(execution?.statuses || {}).map((s) => s?.output?.main?.[0]).filter(Boolean);
  const reading = outs.map((o) => o.reading).find((r) => r && !r.simulated && Array.isArray(r.sentences));
  const lines = [];
  if (reading) {
    lines.push(t(L, 'readHead'));
    lines.push(...(reading.sentences.length ? reading.sentences.map((s) => `• ${s}`) : [t(L, 'readNoSentence')]));
    if (reading.unanswered?.length) lines.push('', t(L, 'notInDoc', { list: reading.unanswered.map((u) => u.q).join(' · ') }));
    const st = reading.stats || {};
    lines.push('', `${t(L, 'readStats', { v: st.verified ?? 0, q: st.questions ?? 0, g: st.groundedRatio ?? '-' })}${reading.memory?.recalled?.length ? t(L, 'linkedMem', { n: reading.memory.recalled.length }) : ''}`);
  } else {
    const sim = outs.map((o) => o.reading).find((r) => r?.simulated);
    lines.push(sim ? t(L, 'skipped', { note: sim.note || t(L, 'noKey') }) : t(L, 'handled', { status: execution?.status ?? '?' }));
  }
  if (execution?.status === 'waiting') lines.push('', t(L, 'waitApproval'));
  if (execution?.status === 'error') lines.push('', t(L, 'hadError'));
  return lines.join('\n');
}

/** 받은 채팅으로 결과 답장 — 모드가 보내기를 허용하고, 허용 채팅일 때만. 그 사람 언어로 */
export async function sendResult(replyTo, execution, { send = tg.telegramSend } = {}) {
  if (!replyTo?.chatId) return { skipped: '답장할 곳 없음' };
  if (!canSend()) return { skipped: '보내기 꺼짐' };
  if (!tg.tgChatIds().includes(String(replyTo.chatId))) return { skipped: '허용되지 않은 채팅' };
  return send({ chatId: replyTo.chatId, text: formatResult(execution, langOfChat(replyTo.chatId)) });
}

/* ---------- 자동화 결과 알림 (specs/006 FR-005) ----------
   예약·웹훅·자동 확인으로 돈 자동화가 실패하면 휴대폰으로 알린다. 설정: errors(기본) · all · off.
   알림은 **그 자동화를 만든 사람의 채팅으로** (없으면 PC 주인). 그 사람 언어로.
   스스로 텔레그램으로 보내는 자동화(템플릿)와 휴대폰에서 온 입력(답장이 따로 감)은 성공 알림을 겹쳐 보내지 않는다. */
export async function notifyExecution({ execution, workflow, trigger }, { send = tg.telegramSend } = {}) {
  const pref = Settings.get('agent').notify || 'errors';
  if (pref === 'off' || !canSend() || !tg.tgToken()) return { skipped: true };
  if (!['schedule', 'webhook', 'agent'].includes(trigger)) return { skipped: true };
  const person = workflow?.ownerId ? People.get(workflow.ownerId) : People.get('owner');
  const chat = (person?.chatId && tg.tgChatIds().includes(person.chatId)) ? person.chatId : tg.tgDefaultChat();
  if (!chat) return { skipped: true };
  const L = normLang(person?.lang);
  const selfSends = (workflow?.nodes || []).some((n) => n.data?.kind === 'telegram');
  const name = workflow?.name || execution.workflowName;
  if (execution.status === 'error') {
    const firstErr = Object.entries(execution.statuses || {}).find(([, s]) => s?.status === 'error');
    return send({ chatId: chat, text: t(L, 'failNotice', { name, err: firstErr ? `${firstErr[0]}: ${String(firstErr[1].error || '').slice(0, 300)}` : '' }) });
  }
  if (pref === 'all' && execution.status === 'success' && !selfSends && trigger !== 'agent') {
    return send({ chatId: chat, text: t(L, 'doneNotice', { name }) });
  }
  return { skipped: true };
}
export const notifyWorkflowsCount = () => Workflows.all().length;

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

// 사람마다 따로 · 한국어 + 영어 (specs/007-people-and-languages)
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-people-'));
process.env.CONDUIT_EMBED = 'off';
process.env.CONDUIT_RERANK = 'off';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const A = await import('../../server/assistant.js');
const T = await import('../../server/templates.js');
const ch = await import('../../server/telegramChannel.js');
const { remember, recall } = await import('../../server/memory/memory.js');
const { senseInbox } = await import('../../server/heartbeat.js');
const { Workflows, Settings, People, Goals } = await import('../../server/store.js');
const { NODE_TYPES } = await import('../../src/engine/nodeTypes.js');

const registrar = () => {};
const sent = [];
const call = async (method, body) => { sent.push({ method, body }); return { message_id: 999 }; };
const msg = (t, chatId, extra = {}) => ({ message_id: 8, chat: { id: chatId }, from: { id: chatId, first_name: 'Sam', ...extra }, text: t });
const lastText = () => sent.filter((s) => s.method === 'sendMessage' || s.method === 'editMessageText').at(-1)?.body.text;
const cb = (data, chatId) => ch.handleCallback({ id: 'q', data, message: { message_id: 5 } }, { call, allowed: true, chatId: String(chatId) });

beforeEach(() => {
  for (const f of ['workflows.json', 'pending-actions.json', 'memory.json', 'settings.json', 'people.json', 'executions.json', 'goals.json']) fs.rmSync(path.join(process.env.CONDUIT_DATA_DIR, f), { force: true });
  sent.length = 0;
  Settings.set('telegram', { mode: 'both', chatIds: [] });
  ch.allowChat('100');                              // 처음 연결 → PC 주인의 휴대폰
  ch.allowChat('200');                              // 두 번째 → 다른 사람 (처음 연결 질문부터)
  People.save({ id: 'p_200', lang: 'en', name: 'Sam', wake: '07:00', interests: ['AI', 'football'], onboarding: 'done' });
});

describe('사람 — 처음 연결하면 묻는다', () => {
  it('첫 채팅은 PC 주인, 다음 채팅은 새 사람 (언어부터 묻는다)', () => {
    expect(People.get('owner').chatId).toBe('100');
    ch.allowChat('300');
    expect(People.byChat('300')).toMatchObject({ id: 'p_300', role: 'member', onboarding: 'lang' });
  });

  it('언어 → 이름 → 일어나는 시각 → 관심사, 끝나기 전에는 다른 일을 하지 않는다', async () => {
    ch.allowChat('300');
    let r = await ch.handleMessage(msg('remind me to drink water at 9am', '300'), { call, allowed: true, chatId: '300' });
    expect(r.onboarding).toBe('lang');
    expect(sent.at(-1).body.reply_markup.inline_keyboard[0].map((b) => b.callback_data)).toEqual(['lg:ko', 'lg:en']);
    expect(Workflows.all()).toHaveLength(0);
    await cb('lg:en', '300');
    expect(lastText()).toMatch(/What should I call you/);
    await ch.handleMessage(msg('Jess', '300'), { call, allowed: true, chatId: '300' });
    expect(lastText()).toMatch(/wake up, Jess/);
    await ch.handleMessage(msg('sometime', '300'), { call, allowed: true, chatId: '300' });
    expect(lastText()).toMatch(/didn't catch the time/);
    await ch.handleMessage(msg('6:30am', '300'), { call, allowed: true, chatId: '300' });
    r = await ch.handleMessage(msg('economy, AI', '300'), { call, allowed: true, chatId: '300' });
    expect(r.onboarding).toBe('done');
    expect(People.byChat('300')).toMatchObject({ name: 'Jess', lang: 'en', wake: '06:30', interests: ['economy', 'AI'], onboarding: 'done' });
    expect(lastText()).toMatch(/All set, Jess/);
  });

  it('한국어로 고르면 한국어로 묻는다 · "건너뛰기"', async () => {
    ch.allowChat('400');
    await ch.handleMessage(msg('안녕', '400'), { call, allowed: true, chatId: '400' });
    await cb('lg:ko', '400');
    await ch.handleMessage(msg('영희', '400'), { call, allowed: true, chatId: '400' });
    expect(lastText()).toMatch(/영희님, 보통 몇 시에/);
    await ch.handleMessage(msg('건너뛰기', '400'), { call, allowed: true, chatId: '400' });
    await ch.handleMessage(msg('없음', '400'), { call, allowed: true, chatId: '400' });
    expect(People.byChat('400')).toMatchObject({ lang: 'ko', wake: null, interests: [], onboarding: 'done' });
  });
});

describe('SC-001 두 사람 — 자기 언어로 답 · 자기 알림은 자기 채팅으로만', () => {
  it('한국어 주인과 영어 사용자가 같은 봇으로 알림을 만든다', async () => {
    await ch.handleMessage(msg('매일 8시 30분에 약 먹으라고 알려줘', '100'), { call, allowed: true, chatId: '100' });
    const koAsk = sent.at(-1).body;
    expect(koAsk.text).toMatch(/만들까요/);
    await ch.handleMessage(msg('remind me to take vitamins every day at 9am', '200'), { call, allowed: true, chatId: '200' });
    const enAsk = sent.at(-1).body;
    expect(enAsk.text).toMatch(/every day at 9:00 AM: "⏰ take vitamins" reminder — create it\?/);
    expect(enAsk.reply_markup.inline_keyboard[0][0].text).toBe('✅ Create');

    await cb(koAsk.reply_markup.inline_keyboard[0][0].callback_data, '100');
    await cb(enAsk.reply_markup.inline_keyboard[0][0].callback_data, '200');
    expect(lastText()).toMatch(/Created: Reminder — every day at 9:00 AM "take vitamins"/);

    const byOwner = Object.fromEntries(Workflows.all().map((w) => [w.ownerId || 'owner', w]));
    const chatOf = (w) => w.nodes.find((n) => n.data.kind === 'telegram').data.params.chatId;
    expect(chatOf(byOwner.owner)).toBe('100');
    expect(chatOf(byOwner.p_200)).toBe('200');
    expect(byOwner.p_200.nodes[1].data.params.text).toBe('⏰ take vitamins');
  });

  it('템플릿 결과 알림 · 실패 알림은 만든 사람 채팅으로', async () => {
    Settings.set('agent', { notify: 'errors' });
    const r = T.createFromTemplate('reminder', { time: '09:00', days: '매일', message: 'x' }, { registrar, ownerId: 'p_200' });
    const wf = Workflows.get(r.workflowId);
    const out = [];
    process.env.TELEGRAM_BOT_TOKEN = 'fake';
    try {
      await ch.notifyExecution({ execution: { status: 'error', statuses: { send: { status: 'error', error: 'boom' } } }, workflow: wf, trigger: 'schedule' }, { send: async (m) => { out.push(m); return { ok: true }; } });
    } finally { delete process.env.TELEGRAM_BOT_TOKEN; }
    expect(out[0].chatId).toBe('200');
    expect(out[0].text).toMatch(/Automation failed/);
  });

  it('목록·상태는 자기 것만, PC 주인은 전부', async () => {
    T.createFromTemplate('reminder', { message: '물 마시기' }, { registrar, ownerId: 'owner' });
    T.createFromTemplate('reminder', { message: 'stretch' }, { registrar, ownerId: 'p_200' });
    const mine = await A.handleAssistant({ text: 'list my automations', ownerId: 'p_200' });
    expect(mine.reply).toMatch(/stretch/);
    expect(mine.reply).not.toMatch(/물 마시기/);
    const all = await A.handleAssistant({ text: '내 자동화 목록', ownerId: 'owner' });
    expect(all.reply).toMatch(/물 마시기/);
    expect(all.reply).toMatch(/stretch/);
    // 다른 사람 자동화는 이름으로도 실행할 수 없다
    const run = await A.handleAssistant({ text: '물 마시기 실행해줘', ownerId: 'p_200', _deps: { execute: async () => { throw new Error('실행되면 안 됨'); } } });
    expect(run.reply).toMatch(/couldn't find/);
  });
});

describe('SC-002 다른 사람 기억은 나오지 않는다', () => {
  it('B 가 A 의 기억을 물으면 "찾지 못했어요" · A 는 찾는다', async () => {
    await remember({ docId: 'card', text: '카드 결제일은 매월 25일입니다.', source: { title: '카드 안내' }, ownerId: 'owner', _deps: { embed: null } });
    const a = await A.handleAssistant({ text: '전에 읽은 결제일 뭐였지?', ownerId: 'owner' });
    expect(a.reply).toMatch(/25일/);
    const b = await A.handleAssistant({ text: '전에 읽은 결제일 뭐였지?', ownerId: 'p_200' });
    expect(b.reply).toMatch(/couldn't find that in memory/);
    expect(b.reply).not.toMatch(/25/);
    const direct = await recall({ query: '카드 결제일', ownerId: 'p_200', _deps: { embed: null, rerank: null } });
    expect(direct.results).toHaveLength(0);
  });

  it('같은 글을 두 사람이 읽어도 따로 저장된다 · 정리도 자기 것만', async () => {
    const r1 = await remember({ docId: 'd', text: '회의는 금요일 3시', facts: [{ text: '회의 시각', quote: '금요일 3시', verified: true }], ownerId: 'owner', _deps: { embed: null } });
    const r2 = await remember({ docId: 'd', text: '회의는 금요일 3시', facts: [{ text: '회의 시각', quote: '금요일 3시', verified: true }], ownerId: 'p_200', _deps: { embed: null } });
    expect(r1.added).toBeGreaterThan(0);
    expect(r2.added).toBe(r1.added);
    expect(T.memoryDigest({ ownerId: 'p_200', lang: 'en' }).text).toMatch(/verified facts only[\s\S]*금요일 3시/);
    expect(T.memoryDigest({ ownerId: 'p_999' }).facts).toBe(0);
  });

  it('받은 파일은 보낸 사람 것으로 — 사람은 코드가 채팅으로 찾는다', () => {
    const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-people-inbox-'));
    fs.writeFileSync(path.join(inbox, 'tg_200_1.txt'), 'hello');
    fs.writeFileSync(path.join(inbox, 'tg_200_1.txt.meta.json'), JSON.stringify({ source: 'telegram', chatId: '200', messageId: 1 }));
    const g = Goals.save({ id: 'g', text: 'read', workflows: [], inbox });
    const items = senseInbox(g, { has: () => false });
    expect(items[0].replyTo).toMatchObject({ chatId: '200', ownerId: 'p_200' });
  });
});

describe('SC-003 다른 사람의 [만들기] 는 누를 수 없다', () => {
  it('A 의 요청을 B 가 누르면 거부 · 아무것도 만들어지지 않는다', async () => {
    const ask = await A.handleAssistant({ text: '매일 7시에 운동하라고 알려줘', ownerId: 'owner', chatId: '100' });
    const denied = await A.confirmAssistant(ask.pendingId, true, { ownerId: 'p_200', _deps: { registrar } });
    expect(denied).toMatchObject({ ok: false, denied: true });
    expect(Workflows.all()).toHaveLength(0);
    // 텔레그램에서도 — 버튼 글은 그대로, 누른 사람에게만 알린다
    await cb(`as:${ask.pendingId}:yes`, '200');
    expect(sent.at(-1)).toMatchObject({ method: 'answerCallbackQuery', body: { text: 'That request belongs to someone else.' } });
    expect(Workflows.all()).toHaveLength(0);
    const ok = await A.confirmAssistant(ask.pendingId, true, { ownerId: 'owner', _deps: { registrar } });
    expect(ok.ok).toBe(true);
  });

  it('모드는 PC 주인만 바꾼다', async () => {
    await cb('md:off', '200');
    expect(Settings.get('telegram').mode).toBe('both');
    await cb('md:off', '100');
    expect(Settings.get('telegram').mode).toBe('off');
  });
});

describe('SC-004 영어 대표 문장 12개 — 규칙으로', () => {
  const ctx = { wake: '07:00' };
  const cases = [
    ['remind me to take my medicine every day at 8:30', { action: 'template', template: 'reminder', params: { time: '08:30', days: '매일', message: 'take my medicine' } }],
    ['Remind me to stretch on weekdays at 3pm', { action: 'template', template: 'reminder', params: { time: '15:00', days: '평일', message: 'stretch' } }],
    ['remind me to drink water', { action: 'template', template: 'reminder', params: { time: '07:00', days: '매일', message: 'drink water' } }],
    ['tell me when https://example.com/news changes', { action: 'template', template: 'page-watch', params: { url: 'https://example.com/news', every: '1시간마다' } }],
    ['watch https://example.com every 10 min and tell me if it changes', { action: 'template', template: 'page-watch', params: { url: 'https://example.com', every: '10분마다' } }],
    ['send me a morning brief on weekdays at 7', { action: 'template', template: 'morning-brief', params: { time: '07:00', days: '평일' } }],
    ['send me a digest of what I read every friday at 6pm', { action: 'template', template: 'memory-digest', params: { time: '18:00', days: '금요일' } }],
    ['what was the payment date I read earlier?', { action: 'recall' }],
    ['show templates', { action: 'templates' }],
    ['list my automations', { action: 'list' }],
    ['what did you do lately?', { action: 'status' }],
    ['run the order workflow', { action: 'run', workflow: 'order' }],
  ];
  let ok = 0;
  for (const [text, want] of cases) {
    it(text, () => {
      const got = A.parseCommand(text, ctx);
      expect(got).toMatchObject(want);
      ok++;
    });
  }
  it('12/12', () => expect(ok).toBe(12));
  it('help · 기억 질문의 군말 빼기', () => {
    expect(A.parseCommand('help')).toEqual({ action: 'help' });
    expect(A.recallQuery('what was the payment date I read earlier?')).toBe('payment date');
  });
});

describe('그 사람에 맞게', () => {
  it('시각 없는 한국어 알림은 일어나는 시각으로 제안한다', () => {
    expect(A.parseCommand('매일 약 먹으라고 알려줘', { wake: '06:40' })).toMatchObject({ template: 'reminder', params: { time: '06:40', message: '약 먹기' }, defaultedTime: true });
  });
  it('아침 브리핑 — 기본 시각은 일어나는 시각, 관심사로 먼저 거른다', () => {
    const list = T.listTemplates('en', 'p_200');
    const brief = list.find((x) => x.id === 'morning-brief');
    expect(brief.title).toBe('Morning brief');
    expect(brief.fields.find((f) => f.key === 'time').default).toBe('07:00');
    expect(brief.fields.find((f) => f.key === 'days').optionLabels).toContain('Weekdays');
    const r = T.createFromTemplate('morning-brief', {}, { registrar, ownerId: 'p_200' });
    const text = Workflows.get(r.workflowId).nodes.find((n) => n.data.kind === 'listText').data.params;
    expect(text).toMatchObject({ prefer: 'AI,football', max: '3' });
  });
  it('listText — 관심사가 든 항목만, 없으면 앞에서부터 + 안내', async () => {
    const items = [{ topic: '주식' }, { topic: 'AI 반도체' }, { topic: '날씨' }, { topic: '축구 결승' }];
    const run = (prefer) => NODE_TYPES.listText.run({ main: { items } }, { field: 'items', line: '• {topic}', prefer, max: '3', noMatch: '(관련 없음)', target: 'text' });
    expect((await run('ai,축구')).main.text).toBe('• AI 반도체\n• 축구 결승');
    expect((await run('야구')).main.text).toBe('• 주식\n• AI 반도체\n• 날씨\n(관련 없음)');
  });
  it('영어 사람에게 결과 답장도 영어로', () => {
    const txt = ch.formatResult({ status: 'success', statuses: { r: { output: { main: [{ reading: { sentences: ['Due on the 25th [L1]'], stats: { verified: 1, questions: 1, groundedRatio: 1 } } }] } } } }, 'en');
    expect(txt).toMatch(/What I read[\s\S]*verified 1\/1/);
  });
});

// 개인 비서 (specs/006-personal-assistant) — 골라서 쓰기 · 말로 시키기 · 알림
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-asst-'));
process.env.CONDUIT_EMBED = 'off';
process.env.CONDUIT_RERANK = 'off';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.TELEGRAM_BOT_TOKEN;

const T = await import('../../server/templates.js');
const A = await import('../../server/assistant.js');
const { Workflows, Memory, PendingActions, Settings } = await import('../../server/store.js');
const { NODE_TYPES } = await import('../../src/engine/nodeTypes.ts');
const ch = await import('../../server/telegramChannel.js');

const registered = [];
const registrar = (wf) => registered.push(wf.id);
const runs = [];
const fakeExec = async (wf) => { runs.push(wf.id); return { execution: { id: `ex${runs.length}`, status: 'success' } }; };

beforeEach(() => {
  for (const f of ['workflows.json', 'pending-actions.json', 'memory.json', 'settings.json', 'change-state.json']) fs.rmSync(path.join(process.env.CONDUIT_DATA_DIR, f), { force: true });
  registered.length = 0;
  runs.length = 0;
});

describe('SC-001 템플릿 — 올바른 워크플로와 예약을 만든다', () => {
  const cases = [
    ['reminder', { time: '08:30', days: '평일', message: '약 먹기' }, '30 8 * * 1-5', ['scheduleTrigger', 'telegram']],
    ['morning-brief', { time: '07:00', days: '매일' }, '0 7 * * *', ['scheduleTrigger', 'hotTopics', 'aggregate', 'listText', 'telegram']],
    ['page-watch', { url: 'https://example.com/a', every: '10분마다' }, '*/10 * * * *', ['scheduleTrigger', 'httpRequest', 'changeDetect', 'telegram']],
    ['memory-digest', { time: '18:00', days: '금요일' }, '0 18 * * 5', ['scheduleTrigger', 'memoryDigest', 'telegram']],
  ];
  for (const [id, params, cron, kinds] of cases) {
    it(`${id} → ${cron}`, () => {
      const r = T.createFromTemplate(id, params, { registrar });
      expect(r.ok).toBe(true);
      expect(r.cron).toBe(cron);
      const wf = Workflows.get(r.workflowId);
      expect(wf.active).toBe(true);
      expect(wf.nodes.map((n) => n.data.kind)).toEqual(kinds);
      for (const n of wf.nodes) expect(NODE_TYPES[n.data.kind]).toBeTruthy();       // 없는 노드를 쓰지 않는다
      for (const e of wf.edges) expect(wf.nodes.some((n) => n.id === e.source) && wf.nodes.some((n) => n.id === e.target)).toBe(true);
      expect(registered).toEqual([r.workflowId]);
    });
  }
  it('read-and-reply 는 쉬운 시작 준비와 같다', () => {
    const r = T.createFromTemplate('read-and-reply', {});
    expect(r.ok).toBe(true);
    expect(Workflows.get(r.workflowId).nodes.map((n) => n.data.kind)).toEqual(['manualTrigger', 'socraticRead', 'output']);
  });
  it('형식이 틀린 값은 만들지 않는다', () => {
    expect(T.createFromTemplate('reminder', { time: '25:00', days: '매일', message: '물' }, { registrar }).errors[0]).toMatch(/00:00 ~ 23:59/);
    expect(T.createFromTemplate('page-watch', { url: 'file:///C:/secret.txt', every: '10분마다' }, { registrar }).errors[0]).toMatch(/http/);
    expect(T.createFromTemplate('reminder', { time: '08:00', days: '가끔', message: '물' }, { registrar }).ok).toBe(false);
    expect(T.createFromTemplate('없는것', {}, { registrar }).ok).toBe(false);
    expect(Workflows.all()).toHaveLength(0);
  });
  it('크론식을 사람 말로', () => {
    expect(T.cronToKorean('30 8 * * 1-5')).toBe('평일 오전 8시 30분');
    expect(T.cronToKorean('0 21 * * *')).toBe('매일 오후 9시');
  });
});

describe('SC-002 말로 시키기 — 대표 문장 20개를 규칙으로 알아듣는다', () => {
  const S = [
    ['매일 8시 30분에 약 먹으라고 알려줘', { action: 'template', template: 'reminder', params: { time: '08:30', days: '매일', message: '약 먹기' } }],
    ['평일 아침 7시에 물 마시라고 알려줘', { template: 'reminder', params: { time: '07:00', days: '평일', message: '물 마시기' } }],
    ['오후 3시 반에 회의 있다고 알려줘', { template: 'reminder', params: { time: '15:30' } }],
    ['주말 10시에 운동하라고 알려줘', { template: 'reminder', params: { time: '10:00', days: '주말', message: '운동하기' } }],
    ['저녁 9시에 일기 쓰라고 알림 줘', { template: 'reminder', params: { time: '21:00', message: '일기 쓰기' } }],
    ['평일 아침 8시에 브리핑 보내줘', { template: 'morning-brief', params: { time: '08:00', days: '평일' } }],
    ['매일 인기 검색어 알려줘', { template: 'morning-brief' }],
    ['https://example.com/notice 바뀌면 알려줘', { template: 'page-watch', params: { url: 'https://example.com/notice', every: '1시간마다' } }],
    ['https://shop.com/item 10분마다 가격 바뀌면 알려줘', { template: 'page-watch', params: { every: '10분마다' } }],
    ['이번 주 읽은 것 정리해서 금요일 6시에 보내줘', { template: 'memory-digest', params: { time: '18:00', days: '금요일' } }],
    ['사진 보내면 읽고 답해줘', { template: 'read-and-reply' }],
    ['전에 읽은 결제일 뭐였지?', { action: 'recall' }],
    ['아까 본 회의 시간이 언제였더라', { action: 'recall' }],
    ['템플릿 보여줘', { action: 'templates' }],
    ['내 자동화 목록', { action: 'list' }],
    ['요즘 뭐 했어?', { action: 'status' }],
    ['주문 처리 자동화 돌려줘', { action: 'run', workflow: '주문 처리' }],
    ['도움말', { action: 'help' }],
    ['뭐 할 수 있어?', { action: 'help' }],
    ['핫이슈 쇼츠 실행해줘', { action: 'run', workflow: '핫이슈 쇼츠' }],
  ];
  for (const [text, want] of S) it(text, () => expect(A.parseCommand(text)).toMatchObject(want));
  it('모르는 말은 null (LLM 으로 넘긴다)', () => expect(A.parseCommand('오늘 기분이 어때')).toBeNull());
});

describe('SC-003 확인 없이 만들거나 내보내지 않는다', () => {
  it('알림은 [만들기] 를 눌러야 생긴다 · 두 번 눌러도 하나 · 취소하면 없음', async () => {
    const r = await A.handleAssistant({ text: '매일 8시 30분에 약 먹으라고 알려줘', _deps: { execute: fakeExec } });
    expect(r.buttons.map((b) => b.value)).toEqual([`as:${r.pendingId}:yes`, `as:${r.pendingId}:no`]);
    expect(Workflows.all()).toHaveLength(0);
    const c = await A.confirmAssistant(r.pendingId, true, { _deps: { registrar } });
    expect(c.reply).toMatch(/만들었어요: 할 일 알림 — 매일 오전 8시 30분/);
    expect((await A.confirmAssistant(r.pendingId, true, { _deps: { registrar } })).already).toBe(true);
    expect(Workflows.all()).toHaveLength(1);
    const r2 = await A.handleAssistant({ text: '평일 7시에 물 마시라고 알려줘' });
    await A.confirmAssistant(r2.pendingId, false);
    expect(Workflows.all()).toHaveLength(1);
  });

  it('밖으로 내보내는 자동화는 실행 전에 묻고, 아닌 것은 바로 실행한다', async () => {
    Workflows.save({ id: 'wf_post', name: '슬랙 공지', active: true, nodes: [{ id: 's', data: { kind: 'manualTrigger' } }, { id: 'x', data: { kind: 'slack' } }], edges: [] });
    Workflows.save({ id: 'wf_calc', name: '주문 처리', active: true, nodes: [{ id: 's', data: { kind: 'manualTrigger' } }], edges: [] });
    const a = await A.handleAssistant({ text: '슬랙 공지 돌려줘', _deps: { execute: fakeExec } });
    expect(a.buttons).toBeTruthy();
    expect(runs).toEqual([]);
    const b = await A.handleAssistant({ text: '주문 처리 자동화 돌려줘', _deps: { execute: fakeExec } });
    expect(b.reply).toMatch(/주문 처리.*success/);
    expect(runs).toEqual(['wf_calc']);
    await A.confirmAssistant(a.pendingId, true, { _deps: { execute: fakeExec } });
    expect(runs).toEqual(['wf_calc', 'wf_post']);
  });

  it('LLM 이 준 값도 똑같이 검증한다 — 틀린 시각·목록에 없는 동작은 거부', async () => {
    const bad = async () => ({ text: JSON.stringify({ action: 'template', template: 'reminder', params: { time: '31:00', days: '매일', message: '물' } }) });
    expect((await A.handleAssistant({ text: '물 좀 마시게 해 줘', _deps: { llm: bad } })).reply).toMatch(/만들 수 없어요/);
    const weird = async () => ({ text: JSON.stringify({ action: 'delete_everything' }) });
    expect((await A.handleAssistant({ text: '다 지워', _deps: { llm: weird } })).action).toBe('unknown');
    expect(PendingActions.all().filter((p) => p.status === 'pending')).toHaveLength(0);
  });
});

describe('SC-004 기억 질문 — 기억 원문만 답한다', () => {
  it('찾으면 원문 그대로 · 출처와 날짜, 없으면 없다고 한다', async () => {
    Memory.add([{ type: 'fact', kind: 'fact', key: 'k1', text: '결제일은? 매월 14일', quote: ['결제일은 매월 14일입니다'], docId: 'card', source: { title: '카드 안내', readAt: '2026-09-20T00:00:00Z' } }]);
    const r = await A.handleAssistant({ text: '전에 읽은 결제일 뭐였지?' });
    expect(r.reply).toMatch(/결제일은 매월 14일입니다/);
    expect(r.reply).toMatch(/카드 안내, 2026-09-20/);
    const none = await A.handleAssistant({ text: '전에 읽은 비행기 탑승구 뭐였지?' });
    expect(none.reply).toMatch(/찾지 못했어요/);
  });
});

describe('노드 — 목록을 글로 · 변경 감지 · 기억 모아 보기', () => {
  it('listText: 들어온 값만으로 문장을 만든다', async () => {
    const r = await NODE_TYPES.listText.run({ main: { items: [{ topic: '로또', headlines: [{ title: '1등 당첨', source: '서울경제' }] }] } },
      { field: 'items', header: '☀️', line: '• {topic} — {headlines.0.title} ({headlines.0.source})', target: 'text' });
    expect(r.main.text).toBe('☀️\n• 로또 — 1등 당첨 (서울경제)');
  });
  it('changeDetect: 처음은 기준만 · 같으면 same · 바뀌면 changed', () => {
    expect(T.changeDetect({ key: 'p', value: 'a' })).toMatchObject({ changed: false, first: true });
    expect(T.changeDetect({ key: 'p', value: 'a' }).changed).toBe(false);
    expect(T.changeDetect({ key: 'p', value: 'b' }).changed).toBe(true);
  });
  it('memoryDigest: 검증된 사실(fact)의 인용 원문만 모은다', () => {
    Memory.add([
      { type: 'fact', kind: 'fact', key: 'f1', text: '요약', quote: ['결제일은 매월 14일입니다'], docId: 'card', source: { title: '카드 안내' } },
      { type: 'source', kind: 'prose', key: 's1', text: '원문 조각', docId: 'card', source: { title: '카드 안내' } },
    ]);
    const r = T.memoryDigest({ days: 7 });
    expect(r.facts).toBe(1);
    expect(r.text).toMatch(/📄 카드 안내\n• 결제일은 매월 14일입니다/);
    expect(r.text).not.toMatch(/원문 조각/);
  });
});

describe('FR-005 휴대폰 알림', () => {
  it('예약 자동화가 실패하면 알리고, 성공은 설정이 all 일 때만 · 스스로 보내는 자동화는 겹쳐 보내지 않는다', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '1:x';
    Settings.set('telegram', { chatIds: ['100'], mode: 'both' });
    const sent = [];
    const send = async (m) => { sent.push(m.text); return { ok: true }; };
    const wf = { name: '브리핑', nodes: [{ data: { kind: 'telegram' } }] };
    await ch.notifyExecution({ execution: { status: 'error', statuses: { get: { status: 'error', error: '타임아웃' } } }, workflow: wf, trigger: 'schedule' }, { send });
    await ch.notifyExecution({ execution: { status: 'success', statuses: {} }, workflow: wf, trigger: 'schedule' }, { send });
    Settings.set('agent', { notify: 'all' });
    await ch.notifyExecution({ execution: { status: 'success', statuses: {} }, workflow: wf, trigger: 'schedule' }, { send });
    await ch.notifyExecution({ execution: { status: 'success', statuses: {} }, workflow: { name: '정리', nodes: [] }, trigger: 'schedule' }, { send });
    await ch.notifyExecution({ execution: { status: 'error', statuses: {} }, workflow: wf, trigger: 'manual' }, { send });
    Settings.set('agent', { notify: 'off' });
    await ch.notifyExecution({ execution: { status: 'error', statuses: {} }, workflow: wf, trigger: 'schedule' }, { send });
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(sent).toEqual([expect.stringMatching(/⚠️ 자동화 실패: 브리핑\nget: 타임아웃/), '✅ 정리 완료']);
  });
});

describe('기억 질문 다듬기 — 군말은 빼고 단어는 자르지 않는다', () => {
  const cases = [
    ['전에 읽은 결제일 뭐였지?', '결제일'],
    ['아까 본 회의 시간이 언제였더라', '회의 시간이'],
    ['지난번 청구서 부가세 얼마였지', '청구서 부가세'],
    ['기억해 둔 와이파이 이름 알려줘', '와이파이 이름'],
  ];
  for (const [q, want] of cases) it(q, () => expect(A.recallQuery(q)).toBe(want));
});

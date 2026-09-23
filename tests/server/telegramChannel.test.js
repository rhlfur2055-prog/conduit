// 텔레그램 양방향 (specs/005-telegram-two-way) — 텔레그램 API 는 가짜로 바꾼다
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-tgch-'));
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.TELEGRAM_BOT_TOKEN;
const ch = await import('../../server/telegramChannel.js');
const { runHeartbeat } = await import('../../server/heartbeat.js');
const { Settings, Goals, Workflows } = await import('../../server/store.js');

let inbox;
const sent = [];
const call = async (method, body) => {
  sent.push({ method, body });
  if (method === 'getFile') return { file_path: 'photos/file_1.jpg', file_size: 2048 };
  return { message_id: 999 };
};
const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('fake-jpeg').buffer });
const photo = (chatId = 100, id = 7) => ({ message_id: id, chat: { id: chatId }, from: { id: 1, first_name: '민수' }, photo: [{ file_id: 'small' }, { file_id: 'big' }] });
const text = (t, chatId = 100) => ({ message_id: 8, chat: { id: chatId }, from: { id: 1, first_name: '민수' }, text: t });
const replies = () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);

beforeEach(() => {
  for (const f of ['settings.json', 'goals.json', 'heartbeats.json', 'inbox-seen.json', 'workflows.json']) fs.rmSync(path.join(process.env.CONDUIT_DATA_DIR, f), { force: true });
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-tg-inbox-'));
  sent.length = 0;
  Workflows.save({ id: 'wf_read', name: '읽기', active: true, nodes: [{ id: 'start', data: { kind: 'manualTrigger' } }], edges: [] });
  Goals.save({ id: 'g1', text: '받은 것 읽기', workflows: ['wf_read'], inbox });
  Settings.set('telegram', { chatIds: ['100'], mode: 'both', goalId: 'g1' });
});

describe('받기 — 휴대폰 → PC', () => {
  it('허용 채팅의 사진을 받은편지함에 저장하고, 보낸 곳을 옆에 적고, 자동 확인을 바로 부른다', async () => {
    let woke = 0;
    const r = await ch.handleMessage(photo(), { call, allowed: true, chatId: '100', fetchImpl, token: 't', onReceived: () => { woke++; } });
    expect(r.saved).toBe(path.join(inbox, 'tg_100_7.jpg'));
    expect(fs.readFileSync(r.saved, 'utf8')).toBe('fake-jpeg');
    expect(JSON.parse(fs.readFileSync(`${r.saved}.meta.json`, 'utf8'))).toMatchObject({ source: 'telegram', chatId: '100', messageId: 7 });
    expect(sent.find((s) => s.method === 'getFile').body.file_id).toBe('big');          // 가장 큰 사진
    expect(replies()[0]).toMatch(/받았어요/);
    await new Promise((res) => setTimeout(res, 0));
    expect(woke).toBe(1);
  });

  it('글도 받는다 (.txt 로 저장)', async () => {
    const r = await ch.handleMessage(text('결제일은 매월 14일입니다.'), { call, allowed: true, chatId: '100' });
    expect(fs.readFileSync(r.saved, 'utf8')).toBe('결제일은 매월 14일입니다.');
  });

  it('SC-003 허용 안 된 채팅은 저장 0건 · 연결 요청으로 기록 · 안내는 한 번만', async () => {
    const r1 = await ch.handleMessage(photo(555), { call, allowed: false, chatId: '555', fetchImpl });
    const r2 = await ch.handleMessage(photo(555, 8), { call, allowed: false, chatId: '555', fetchImpl });
    expect([r1.ignored, r2.ignored]).toEqual(['not_allowed', 'not_allowed']);
    expect(fs.readdirSync(inbox)).toEqual([]);
    expect(ch.tgSettings().pendingChats).toMatchObject([{ chatId: '555', name: '민수' }]);
    expect(replies()).toHaveLength(1);
    ch.allowChat('555');
    expect(ch.tgSettings().chatIds).toContain('555');
    expect(ch.tgSettings().pendingChats).toEqual([]);
  });

  it('10MB 넘는 파일은 받지 않는다', async () => {
    const big = { ...photo(), photo: undefined, document: { file_id: 'd', mime_type: 'image/png', file_size: 11 * 1024 * 1024 } };
    const r = await ch.handleMessage(big, { call, allowed: true, chatId: '100', fetchImpl });
    expect(r.ignored).toBe('download');
    expect(fs.readdirSync(inbox)).toEqual([]);
  });
});

describe('SC-002 모드 — 사용자가 고른다', () => {
  it('받기만 · 둘 다: 받는다 / 보내기만 · 끄기: 받지 않고 이유를 알려 준다', async () => {
    const got = {};
    for (const mode of ['both', 'inbound', 'outbound', 'off']) {
      ch.setMode(mode);
      const r = await ch.handleMessage(text(`모드 ${mode}`), { call, allowed: true, chatId: '100' });
      got[mode] = r.saved ? 'saved' : r.ignored;
    }
    expect(got).toEqual({ both: 'saved', inbound: 'saved', outbound: 'mode', off: 'mode' });
    expect(replies().filter((t) => /지금은 받지 않아요/.test(t))).toHaveLength(2);
  });

  it('둘 다 · 보내기만: 답장한다 / 받기만 · 끄기: 답장하지 않는다 (허용 채팅에만)', async () => {
    const out = {};
    const send = async ({ chatId }) => ({ ok: true, chatId });
    for (const mode of ['both', 'inbound', 'outbound', 'off']) {
      ch.setMode(mode);
      const r = await ch.sendResult({ chatId: '100' }, { status: 'success', statuses: {} }, { send });
      out[mode] = r.ok ? 'sent' : r.skipped;
    }
    expect(out).toEqual({ both: 'sent', inbound: '보내기 꺼짐', outbound: 'sent', off: '보내기 꺼짐' });
    ch.setMode('both');
    expect((await ch.sendResult({ chatId: '999' }, {}, { send })).skipped).toBe('허용되지 않은 채팅');
  });

  it('텔레그램 /mode 버튼으로 바꾼다 · 연결 안 된 채팅은 못 바꾼다', async () => {
    await ch.handleCallback({ id: 'q', data: 'md:outbound', message: { message_id: 1 } }, { call, allowed: true, chatId: '100' });
    expect(ch.telegramMode()).toBe('outbound');
    await ch.handleCallback({ id: 'q', data: 'md:off', message: { message_id: 1 } }, { call, allowed: false, chatId: '555' });
    expect(ch.telegramMode()).toBe('outbound');
  });
});

describe('SC-001 끝까지 — 사진 보냄 → 저장 → 자동 확인 → 같은 채팅으로 답장, 사람 손 0', () => {
  it('받은 파일의 replyTo 는 코드가 붙이고, LLM 이 다른 채팅을 넣어도 버린다', async () => {
    await ch.handleMessage(photo(), { call, allowed: true, chatId: '100', fetchImpl });
    const runs = [];
    const notes = [];
    const exec = async (wf, { seed }) => {
      runs.push(seed.start.main);
      return { execution: { id: 'ex1', status: 'success', statuses: { read: { output: { main: [{ reading: { simulated: false, sentences: ['결제일은 14일이다 [L1]'], unanswered: [{ q: '연회비?' }], stats: { verified: 1, questions: 2, groundedRatio: 1 } } }] } } } } };
    };
    const llm = async () => ({ text: JSON.stringify({ actions: [{ goal: 'G1', action: 'run', workflow: 'W1', inputRef: 'I1', input: { image: path.join(inbox, 'tg_100_7.jpg'), title: 'tg_100_7.jpg', replyTo: { chatId: '666' } }, evidence: ['G1', 'I1'], confidence: 0.9 }] }) });
    const hb = await runHeartbeat({ _deps: { llm, execute: exec, notify: async (to, e) => { notes.push({ to, text: ch.formatResult(e) }); return { ok: true }; } } });
    expect(hb.results[0].verdict).toBe('run');
    expect(runs[0].replyTo).toMatchObject({ chatId: '100', messageId: 7 });
    expect(notes).toHaveLength(1);
    expect(notes[0].to.chatId).toBe('100');
    expect(notes[0].text).toMatch(/결제일은 14일이다/);
    expect(notes[0].text).toMatch(/문서에 없던 것: 연회비/);
  });

  it('formatResult — 키가 없어 건너뛴 경우와 승인 대기를 알려 준다', () => {
    expect(ch.formatResult({ status: 'success', statuses: { r: { output: { main: [{ reading: { simulated: true, note: 'ANTHROPIC_API_KEY 가 없어' } }] } } } })).toMatch(/건너뛰었어요/);
    expect(ch.formatResult({ status: 'waiting', statuses: {} })).toMatch(/승인을 기다려요/);
  });
});

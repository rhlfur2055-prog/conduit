// 텔레그램 어댑터 — 버튼 페이로드, 콜백 해석, 롱폴링 처리(승인·수정·거절·재시도·권한·/id·409). fetch 를 가짜로 바꿔 실제 API 는 부르지 않는다.
import { describe, it, expect } from 'vitest';
import { tgCall, telegramSend, parseCallback, buildCallback, approvalKeyboard, approvalText, sendApproval, markDecided, startPolling } from '../../server/telegram.js';

/** 메서드별 응답을 정해 두는 가짜 fetch. 호출 기록을 남긴다. { __error, __code } 로 실패를 흉내낸다. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body || '{}');
    calls.push({ method, body });
    const h = handlers[method];
    const result = typeof h === 'function' ? await h(body, calls) : (h ?? {});
    return {
      status: 200,
      json: async () => (result && result.__error ? { ok: false, description: result.__error, error_code: result.__code || 400 } : { ok: true, result }),
    };
  };
  fn.calls = calls;
  fn.of = (method) => calls.filter((c) => c.method === method);
  return fn;
}
const until = (pred, ms = 2000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => (pred() ? resolve() : Date.now() - t0 > ms ? reject(new Error('시간 초과')) : setTimeout(tick, 5));
  tick();
});

describe('버튼·콜백', () => {
  it('콜백 데이터를 만들고 해석한다 (64바이트 제한 안)', () => {
    const cb = buildCallback('ap_1a2b3c4d', 'approve');
    expect(cb.length).toBeLessThan(64);
    expect(parseCallback(cb)).toEqual({ approvalId: 'ap_1a2b3c4d', action: 'approve' });
    expect(parseCallback('ap:ap_1:edit')).toEqual({ approvalId: 'ap_1', action: 'edit' });
    expect(parseCallback('ap:ap_1:retry')).toEqual({ approvalId: 'ap_1', action: 'retry' });
    expect(parseCallback('ap:ap_1:delete')).toBeNull();
    expect(parseCallback('junk')).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
  });
  it('승인 키보드는 승인·수정·거절 세 버튼', () => {
    const kb = approvalKeyboard('ap_x');
    expect(kb.inline_keyboard[0].map((b) => b.callback_data)).toEqual(['ap:ap_x:approve', 'ap:ap_x:edit', 'ap:ap_x:reject']);
  });
  it('메시지 본문에 제목·워크플로·내용·승인 ID 가 들어가고, 긴 본문은 잘린다', () => {
    const t = approvalText({ title: '승인: 김민수', text: '시세 안내', workflowName: '문의 승인', approvalId: 'ap_9' });
    expect(t).toContain('승인: 김민수');
    expect(t).toContain('워크플로: 문의 승인');
    expect(t).toContain('시세 안내');
    expect(t).toContain('[ap_9]');
    const long = approvalText({ title: 'T', text: 'x'.repeat(5000), approvalId: 'ap_9' });
    expect(long.length).toBeLessThan(4096);
    expect(long).toContain('잘림');
  });
});

describe('API 호출', () => {
  it('실패 응답은 description 을 담은 오류로 던지고 토큰은 노출하지 않는다', async () => {
    const f = fakeFetch({ sendMessage: { __error: 'chat not found', __code: 400 } });
    const err = await tgCall('sendMessage', { chat_id: 1 }, { token: 'SECRET-TOKEN', fetchImpl: f }).catch((e) => e);
    expect(err.message).toContain('chat not found');
    expect(err.message).not.toContain('SECRET-TOKEN');
    expect(err.status).toBe(400);
  });
  it('토큰이 없으면 노드용 전송은 시뮬레이션', async () => {
    const r = await telegramSend({ chatId: '1', text: 'x' }, { token: '' });
    expect(r.simulated).toBe(true);
  });
  it('sendApproval 은 버튼을 붙여 보내고 messageId 를 돌려준다', async () => {
    const f = fakeFetch({ sendMessage: { message_id: 55, chat: { id: 123 } } });
    const r = await sendApproval({ chatId: '123', approvalId: 'ap_1', title: 'T', text: 'B' }, { token: 't', fetchImpl: f });
    expect(r).toEqual({ messageId: 55, chatId: '123' });
    expect(f.calls[0].body.reply_markup.inline_keyboard[0]).toHaveLength(3);
  });
  it('markDecided 는 메시지를 고치고, 실패하면 새로 보낸다', async () => {
    const f = fakeFetch({ editMessageText: { __error: 'message to edit not found' }, sendMessage: { message_id: 9 } });
    await markDecided({ chatId: '1', messageId: 2, approvalId: 'ap_1', title: 'T', text: 'B', decision: 'approve', by: '@a' }, { token: 't', fetchImpl: f });
    expect(f.calls.map((c) => c.method)).toEqual(['editMessageText', 'sendMessage']);
    expect(f.calls[1].body.text).toContain('승인됨');
    expect(f.calls[1].body.reply_markup).toBeUndefined();
  });
  it('재개가 실패했으면 "승인됐지만 실패"를 쓰고 🔁 다시 시도 버튼을 남긴다', async () => {
    const f = fakeFetch({ editMessageText: {} });
    await markDecided({ chatId: '1', messageId: 2, approvalId: 'ap_1', title: 'T', text: 'B', decision: 'approve', by: '@a', resumeOk: false, resumeError: 'Gmail 401' }, { token: 't', fetchImpl: f });
    const body = f.calls[0].body;
    expect(body.text).toContain('실패');
    expect(body.text).toContain('Gmail 401');
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('ap:ap_1:retry');
  });
});

describe('롱폴링', () => {
  const cbUpdate = (id, data, chatId = 123, from = { id: 77, username: 'dong' }) => ({ update_id: id, callback_query: { id: `q${id}`, data, from, message: { chat: { id: chatId }, message_id: 500 + id } } });
  const msgUpdate = (id, text, chatId = 123, extra = {}) => ({ update_id: id, message: { message_id: 600 + id, text, chat: { id: chatId }, from: { id: 77, first_name: '동근' }, ...extra } });

  /** 첫 폴링에만 updates 를 주고 그 뒤로는 빈 배열 */
  const pollOnce = (updates, extra = {}) => {
    let served = false;
    return fakeFetch({
      deleteWebhook: true,
      getUpdates: () => { if (served) return []; served = true; return updates; },
      answerCallbackQuery: true, sendMessage: { message_id: 1 }, ...extra,
    });
  };
  const start = (f, onDecision, opts = {}) => startPolling({ token: 't', allowedChatIds: [], fetchImpl: f, onDecision, log: () => {}, idleMs: 5, ...opts });

  it('기동 시 웹훅을 지우고 롱폴링으로 간다', async () => {
    const f = pollOnce([]);
    const p = start(f, async () => {});
    await until(() => f.of('getUpdates').length >= 1);
    p.stop();
    expect(f.calls[0].method).toBe('deleteWebhook');
  });

  it('승인 버튼 → 먼저 "처리 중" 응답 → onDecision(approve)', async () => {
    const f = pollOnce([cbUpdate(1, 'ap:ap_1:approve')]);
    const got = [];
    const p = start(f, async (d) => { got.push(d); return { ok: true, resumeStatus: 'done' }; });
    await until(() => got.length === 1 && f.of('getUpdates').length >= 2);
    p.stop();
    expect(got[0]).toMatchObject({ approvalId: 'ap_1', action: 'approve', by: '@dong', chatId: '123', userId: '77' });
    expect(f.of('answerCallbackQuery')[0].body.text).toBe('처리 중…');
    expect(f.of('sendMessage')).toHaveLength(0);                         // 성공 결과는 메시지 편집(markDecided)이 알린다
    expect(f.of('getUpdates')[1].body.offset).toBe(2);                    // 다음 폴링은 update_id+1 부터
  });

  it('결정이 거부되면(다른 채팅·이미 처리됨) 답장으로 알린다', async () => {
    const f = pollOnce([cbUpdate(1, 'ap:ap_1:approve')]);
    const p = start(f, async () => ({ ok: false, error: '요청을 보낸 채팅이 아닙니다' }));
    await until(() => f.of('sendMessage').length === 1);
    p.stop();
    expect(f.of('sendMessage')[0].body.text).toContain('채팅이 아닙니다');
  });

  it('허용되지 않은 채팅·사용자의 버튼은 무시한다', async () => {
    const f = pollOnce([cbUpdate(1, 'ap:ap_1:approve', 999), cbUpdate(2, 'ap:ap_1:approve', 123, { id: 5, username: 'stranger' })]);
    const got = [];
    const p = start(f, async (d) => { got.push(d); }, { allowedChatIds: ['123'], allowedUserIds: ['77'] });
    await until(() => f.of('answerCallbackQuery').length === 2);
    p.stop();
    expect(got).toHaveLength(0);
    expect(f.of('answerCallbackQuery').every((c) => c.body.text === '권한이 없습니다')).toBe(true);
  });

  it('✏️ 수정 → 안내에 [승인ID] 를 넣고, 그 안내에 대한 답장만 수정본으로 받는다', async () => {
    const f = pollOnce([
      cbUpdate(1, 'ap:ap_1:edit'),
      msgUpdate(2, '아무 말'),                                                                  // 답장이 아님 → 무시
      msgUpdate(3, '내일 연락드리겠습니다', 123, { reply_to_message: { message_id: 1, text: '수정할 내용을 이 메시지에 답장으로 보내주세요. [ap_1]' } }),
    ]);
    const got = [];
    const p = start(f, async (d) => { got.push(d); return { ok: true }; }, { allowedChatIds: ['123'] });
    await until(() => got.length === 1);
    p.stop();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ approvalId: 'ap_1', action: 'approve', editedText: '내일 연락드리겠습니다', by: '동근' });
    const prompt = f.of('sendMessage').find((c) => c.body.reply_markup?.force_reply);
    expect(prompt.body.text).toContain('[ap_1]');
  });

  it('🔁 다시 시도 → action:retry', async () => {
    const f = pollOnce([cbUpdate(1, 'ap:ap_1:retry')]);
    const got = [];
    const p = start(f, async (d) => { got.push(d); return { ok: true }; });
    await until(() => got.length === 1);
    p.stop();
    expect(got[0]).toMatchObject({ approvalId: 'ap_1', action: 'retry' });
  });

  it('/id 를 보내면 채팅 ID 와 사용자 ID 를 알려준다', async () => {
    const f = pollOnce([msgUpdate(1, '/id', 777)]);
    const p = start(f, async () => {});
    await until(() => f.of('sendMessage').length === 1);
    p.stop();
    expect(f.of('sendMessage')[0].body.text).toContain('777');
    expect(f.of('sendMessage')[0].body.text).toContain('77');
  });

  it('폴링 오류가 나도 죽지 않고 재시도하며, 409 는 한 번만 크게 알린다', async () => {
    let n = 0;
    const f = fakeFetch({ deleteWebhook: true, getUpdates: () => { n++; if (n <= 2) return { __error: 'Conflict', __code: 409 }; if (n === 3) return { __error: 'boom' }; return []; } });
    const logs = [];
    const p = startPolling({ token: 't', fetchImpl: f, onDecision: async () => {}, log: (m) => logs.push(m), retryMs: 5, idleMs: 5 });
    await until(() => n >= 4);
    p.stop();
    expect(logs.filter((l) => l.includes('409')).length).toBe(1);
    expect(logs.some((l) => l.includes('폴링 오류') && l.includes('boom'))).toBe(true);
  });
});

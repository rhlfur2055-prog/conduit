// 목표 + 하트비트 (specs/004-goals-heartbeat) — LLM 은 각본대로, 실행기는 가짜로 바꾼다
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-hb-'));
const { runHeartbeat, validate, gatherContext, ruleProposals, decidePending, hasSideEffects } = await import('../../server/heartbeat.js');
const { Goals, Workflows, Heartbeats, InboxSeen, PendingActions } = await import('../../server/store.js');

const n = (id, kind, params = {}) => ({ id, data: { kind, params } });
const READ = { id: 'wf_read', name: '화면 읽기', active: true, nodes: [n('hook', 'webhookTrigger'), n('read', 'socraticRead')], edges: [] };
const POST = { id: 'wf_post', name: '슬랙 알림', active: true, nodes: [n('hook', 'manualTrigger'), n('s', 'slack')], edges: [] };
const OTHER = { id: 'wf_other', name: '다른 워크플로', active: true, nodes: [n('hook', 'manualTrigger')], edges: [] };

let inbox;
const runs = [];
const fakeExec = async (wf, { seed, trigger }) => { runs.push({ wf: wf.id, seed, trigger }); return { execution: { id: `ex${runs.length}`, status: 'success' } }; };
const llmSays = (actions) => async () => ({ text: JSON.stringify({ actions }), usage: { input_tokens: 1, output_tokens: 1 } });
const noKey = async () => ({ text: '〔시뮬레이션〕', simulated: true });
const drop = (name, body = 'x') => { const p = path.join(inbox, name); fs.writeFileSync(p, body); return p; };

beforeEach(() => {
  for (const f of ['goals.json', 'heartbeats.json', 'inbox-seen.json', 'pending-actions.json', 'workflows.json']) fs.rmSync(path.join(process.env.CONDUIT_DATA_DIR, f), { force: true });
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-inbox-'));
  runs.length = 0;
  for (const w of [READ, POST, OTHER]) Workflows.save(w);
});

const goal = (extra = {}) => Goals.save({ id: 'g1', text: '받은편지함에 새 화면이 오면 읽는다', workflows: ['wf_read'], inbox, ...extra });

describe('규칙 모드 (키 없음) — 폴더에 넣으면 알아서 읽는다 (US1 · US5 · SC-004)', () => {
  it('새 파일마다 한 번 실행하고, 같은 파일은 다시 읽지 않는다 (SC-003)', async () => {
    goal();
    const a = drop('card.png');
    drop('notice.png');
    const hb1 = await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } });
    expect(hb1.mode).toBe('rule');
    expect(runs.map((r) => r.wf)).toEqual(['wf_read', 'wf_read']);
    expect(runs[0].seed.hook.main).toMatchObject({ image: a, title: 'card.png', _agent: { heartbeat: true } });
    expect(runs[0].trigger).toBe('agent');
    const hb2 = await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } });
    expect(runs).toHaveLength(2);
    expect(hb2.results.map((r) => r.verdict)).toEqual(['wait']);
  });

  it('할 일이 없으면 아무것도 실행하지 않는다 (US2)', async () => {
    goal();
    const hb = await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } });
    expect(runs).toHaveLength(0);
    expect(hb.results[0]).toMatchObject({ verdict: 'wait', reason: '새 입력도 주기도 없음' });
  });

  it('같은 이름이라도 새 파일(크기가 다름)이 오면 다시 읽는다', async () => {
    goal();
    drop('card.png', 'v1');
    await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } });
    drop('card.png', 'version 2 — 더 긴 내용');
    await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } });
    expect(runs).toHaveLength(2);
  });

  it('주기(cadenceMin)가 된 목표는 입력 없이도 실행하고, 주기 전에는 기다린다', async () => {
    Goals.save({ id: 'g2', text: '30분마다 점검', workflows: ['wf_other'], cadenceMin: 30 });
    const t0 = Date.now();
    await runHeartbeat({ now: t0, _deps: { llm: noKey, execute: fakeExec } });
    await runHeartbeat({ now: t0 + 10 * 60000, _deps: { llm: noKey, execute: fakeExec } });
    await runHeartbeat({ now: t0 + 31 * 60000, _deps: { llm: noKey, execute: fakeExec } });
    expect(runs.map((r) => r.wf)).toEqual(['wf_other', 'wf_other']);
  });

  it('활성 목표가 없으면 idle', async () => {
    expect((await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } })).mode).toBe('idle');
  });
});

describe('LLM 제안 검증 — 틀린 제안은 실행하지 않는다 (US3 · SC-002)', () => {
  it('허용 밖 워크플로 · 없는 근거 · 감지 안 된 경로 · 남의 입력 · 없는 목표 — 모두 거부, 실행 0건', async () => {
    goal();
    Goals.save({ id: 'g2', text: '다른 목표', workflows: ['wf_other'] });
    const p = drop('card.png');
    const hb = await runHeartbeat({
      _deps: {
        execute: fakeExec,
        llm: llmSays([
          { goal: 'G1', action: 'run', workflow: 'W2', inputRef: 'I1', input: { image: p }, evidence: ['G1', 'I1'], confidence: 0.9 },
          { goal: 'G1', action: 'run', workflow: 'W1', inputRef: 'I1', input: { image: p }, evidence: ['G1', 'I9'], confidence: 0.9 },
          { goal: 'G1', action: 'run', workflow: 'W1', input: { image: 'C:/Windows/System32/config/SAM' }, evidence: ['G1'], confidence: 0.9 },
          { goal: 'G2', action: 'run', workflow: 'W2', inputRef: 'I1', input: { image: p }, evidence: ['G2', 'I1'], confidence: 0.9 },
          { goal: 'G7', action: 'run', workflow: 'W1', evidence: ['G1'], confidence: 0.9 },
        ]),
      },
    });
    expect(runs).toHaveLength(0);
    expect(hb.results.map((r) => r.verdict)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
    expect(hb.results.map((r) => r.reason)).toEqual([
      expect.stringMatching(/허용되지 않은 워크플로/),
      expect.stringMatching(/없는 근거 I9/),
      expect.stringMatching(/감지되지 않은 경로/),
      expect.stringMatching(/입력이 아닌 I1/),
      expect.stringMatching(/없는 목표 G7/),
    ]);
  });

  it('파일 이름만 적어도 감지된 입력의 이름이 아니면 거부한다 (상대 경로로 서버 파일을 읽게 하지 않는다)', async () => {
    goal();
    const p = drop('card.png');
    const hb = await runHeartbeat({ _deps: { execute: fakeExec, llm: llmSays([
      { goal: 'G1', action: 'run', workflow: 'W1', inputRef: 'I1', input: { image: p, extra: '.env.json' }, evidence: ['G1', 'I1'], confidence: 0.9 },
    ]) } });
    expect(runs).toHaveLength(0);
    expect(hb.results[0].reason).toMatch(/감지되지 않은 경로 \.env\.json/);
  });

  it('맞는 제안은 실행하고, 같은 입력을 두 번 제안해도 한 번만 실행한다', async () => {
    goal();
    const p = drop('card.png');
    const ok = { goal: 'G1', action: 'run', workflow: 'W1', inputRef: 'I1', input: { image: p, title: 'card.png' }, evidence: ['G1', 'I1'], confidence: 0.9 };
    const hb = await runHeartbeat({ _deps: { execute: fakeExec, llm: llmSays([ok, ok]) } });
    expect(runs).toHaveLength(1);
    expect(hb.results.map((r) => r.verdict)).toEqual(['run', 'skipped']);
    expect(hb.results[0].execution).toEqual({ id: 'ex1', status: 'success' });
  });

  it('입력 없이 주기도 아닌데 실행하려 하면 건너뛴다 (쿨다운)', async () => {
    Goals.save({ id: 'g2', text: '점검', workflows: ['wf_other'], cadenceMin: 60 });
    const act = { goal: 'G1', action: 'run', workflow: 'W1', input: {}, evidence: ['G1'], confidence: 0.9 };
    await runHeartbeat({ _deps: { execute: fakeExec, llm: llmSays([act]) } });
    const hb = await runHeartbeat({ _deps: { execute: fakeExec, llm: llmSays([act]) } });
    expect(runs).toHaveLength(1);
    expect(hb.results[0]).toMatchObject({ verdict: 'skipped', reason: expect.stringMatching(/주기/) });
  });
});

describe('애매하면 사람에게 (US4)', () => {
  it('확신도 낮음 · 부작용 워크플로 → 실행하지 않고 승인 대기, 승인하면 실행 (한 번만)', async () => {
    Goals.save({ id: 'g1', text: '새 화면 읽기', workflows: ['wf_read'], inbox });
    Goals.save({ id: 'g2', text: '요약을 슬랙에 올린다', workflows: ['wf_post'], cadenceMin: 1 });
    const p = drop('card.png');
    const hb = await runHeartbeat({
      _deps: {
        execute: fakeExec,
        llm: llmSays([
          { goal: 'G1', action: 'run', workflow: 'W1', inputRef: 'I1', input: { image: p }, evidence: ['G1', 'I1'], confidence: 0.4 },
          { goal: 'G2', action: 'run', workflow: 'W2', input: {}, evidence: ['G2'], confidence: 0.95 },
        ]),
      },
    });
    expect(runs).toHaveLength(0);
    expect(hb.results.map((r) => r.verdict)).toEqual(['approval', 'approval']);
    expect(hb.results[0].reason).toMatch(/확신도 0.4/);
    expect(hb.results[1].reason).toMatch(/밖으로 내보내는/);
    const r = await decidePending(hb.results[1].pendingId, { approve: true, _deps: { execute: fakeExec } });
    expect(r).toMatchObject({ ok: true, status: 'approved' });
    expect(runs.map((x) => x.wf)).toEqual(['wf_post']);
    expect((await decidePending(hb.results[1].pendingId, { approve: true, _deps: { execute: fakeExec } })).already).toBe(true);
  });

  it('부작용 판정은 노드 종류로 한다', () => {
    expect(hasSideEffects(POST)).toBe(true);
    expect(hasSideEffects(READ)).toBe(false);
  });
});

describe('기록 — 다음 하트비트에 "최근 결정" 으로 들어간다 (FR-006)', () => {
  it('결정·이유가 다음 상황에 보인다', async () => {
    goal();
    await runHeartbeat({ _deps: { llm: noKey, execute: fakeExec } });
    const ctx = gatherContext({ heartbeats: Heartbeats.all() });
    expect(ctx.decisions[0]).toMatchObject({ verdict: 'wait' });
    expect(ruleProposals(ctx)[0].action).toBe('wait');
    expect(validate({ goal: 'G1', action: 'wait' }, ctx, { handled: new Set(), runsToday: 0, runsThisBeat: 0 }).verdict).toBe('wait');
    expect(InboxSeen.all()).toEqual({});
    expect(PendingActions.all()).toEqual([]);
  });
});

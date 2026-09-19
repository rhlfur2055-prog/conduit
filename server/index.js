// ============================================================
// Conduit 백엔드 — Express
//   • 워크플로 CRUD (/api/workflows)
//   • 서버 실행 (/api/run, /api/workflows/:id/run)
//   • 웹훅 수신 (/webhook/*)
//   • 크론 스케줄러 (스케줄 트리거 노드)
//   • 크리덴셜 암호화 저장 (/api/credentials)
//   • 실행 기록 (/api/executions)
// 실행 엔진은 프론트엔드와 동일한 소스를 재사용한다.
// ============================================================
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 장시간 실행 서버 보호 — 도구/라이브러리의 미처리 오류로 프로세스가 죽지 않게
process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

// .env 자동 로드 — 프로젝트 루트(.env) 우선, 없으면 server/.env
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, '..', '.env'), path.join(here, '.env')]) {
    try {
      process.loadEnvFile(p);
      console.log('[env] 로드됨:', p);
      break;
    } catch { /* 파일 없으면 다음 후보 */ }
  }
}

import { runFlow } from '../src/engine/executor.js';
import { Workflows, Executions, Credentials, ProcessedEvents, DLQ, readData, VerifiedComments } from './store.js';
import { verifySignature, idempotencyKey } from './webhookSecurity.js';
import { callLLM } from './llm.js';
import * as integrations from './integrations.js';
import { runAgent } from './agent.js';
import { mcpListTools, mcpCallTool } from './mcp.js';
import { renderDataShort, renderBrainQuiz, renderSpinTest } from './video.js';
import { renderMultiLang } from './render-multi.js';
import { speak } from './tts.js';
import { fetchRanking } from './rankdata.js';
import { fetchProducts as coupangProducts, fetchReport as coupangReport } from './coupang.js';
import { generatePost } from './blogpost.js';
import { publishPost as bloggerPublish } from './blogger.js';
import { fetchProducts as aliProducts } from './aliexpress.js';
import { fetchMerchants as linkpriceMerchants, makeDeeplinks as linkpriceDeeplink, fetchReport as linkpriceReport } from './linkprice.js';

// AI/연동 노드가 사용할 브리지를 전역에 주입 (서버에서만 실제 호출)
globalThis.__conduitLLM = callLLM;
globalThis.__conduitAgent = runAgent;
globalThis.__conduitTtsSpeak = speak; // 렌더 브리지가 문장별 TTS 세그먼트 생성에 사용
globalThis.__conduitData = readData;   // 코드 노드에서 server/data/*.json 을 읽을 때 사용
globalThis.__conduitIntegrations = {
  slack: integrations.slack,
  gmail: integrations.gmail,
  notion: integrations.notion,
  youtube: integrations.youtube,
  naver: integrations.naver,
  http: integrations.http,
  videoRender: renderDataShort,
  brainQuiz: renderBrainQuiz,
  multiLang: renderMultiLang,
  spinTest: renderSpinTest,
  youtubeUpload: integrations.youtubeUpload,
  verifiedComment: async (args) => VerifiedComments.add(args),
  tts: speak,
  rankData: fetchRanking,
  coupangProducts,
  coupangReport,
  blogPost: generatePost,
  bloggerPublish,
  aliProducts,
  linkpriceMerchants,
  linkpriceDeeplink,
  linkpriceReport,
  mcp: async ({ credential, tool, args }) => {
    if (!tool) return mcpListTools(credential);
    let parsed = {};
    try { parsed = args ? JSON.parse(args) : {}; } catch { /* 빈 인자로 진행 */ }
    return mcpCallTool(credential, tool, parsed);
  },
};

const app = express();
const PORT = process.env.PORT || 8787;
app.use(cors());
// 서명 검증을 위해 raw body 를 보존한다
app.use(express.json({
  limit: '4mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

/* ---------- Error Trigger 발동 ----------
   실패한 실행이 생기면, errorTrigger 노드를 가진 "다른" 활성 워크플로를 실행한다.
   에러 핸들러 자신의 실패(trigger='error')는 재발동하지 않는다(무한루프 방지). */
async function dispatchErrorWorkflows(failed) {
  const handlers = Workflows.all().filter(
    (w) =>
      w.active &&
      w.id !== failed.workflowId &&
      (w.nodes || []).some((n) => n.data.kind === 'errorTrigger')
  );
  for (const wf of handlers) {
    const seed = {};
    for (const n of wf.nodes || []) {
      if (n.data.kind === 'errorTrigger') seed[n.id] = { main: failed.payload };
    }
    try {
      await execute(wf, { seed, trigger: 'error' });
      console.log(`[error-trigger] "${wf.name}" 발동 (원인: ${failed.payload.workflowName})`);
    } catch (e) {
      console.warn(`[error-trigger] "${wf.name}" 실행 실패: ${e.message}`);
    }
  }
}

/* ---------- 실행 헬퍼 ---------- */
async function execute(workflow, { seed = {}, trigger = 'manual' } = {}) {
  const nodes = (workflow.nodes || []).map((n) => ({
    id: n.id,
    data: { kind: n.data.kind, params: n.data.params },
  }));
  const edges = workflow.edges || [];

  const logs = [];
  const statuses = {};
  const results = await runFlow(nodes, edges, {
    seed,
    onLog: (l) => logs.push(l),
    onStatus: (id, status, payload) => { statuses[id] = { status, ...(payload || {}) }; },
    onDeadLetter: (e) => DLQ.add({ ...e, workflowId: workflow.id, workflowName: workflow.name }),
  });

  const outputs = {};
  for (const [id, r] of results) outputs[id] = r.output;
  const hadError = Object.values(statuses).some((s) => s.status === 'error');

  const exec = Executions.add({
    workflowId: workflow.id || null,
    workflowName: workflow.name || '(임시)',
    trigger,
    status: hadError ? 'error' : 'success',
    logs,
    statuses,
  });

  // 실패 시 Error Trigger 워크플로 발동 (에러 핸들러 자신의 실패는 제외)
  if (hadError && trigger !== 'error') {
    const failedNodes = Object.entries(statuses)
      .filter(([, s]) => s.status === 'error')
      .map(([id, s]) => {
        const node = (workflow.nodes || []).find((n) => n.id === id);
        return { nodeId: id, nodeKind: node?.data?.kind || 'unknown', error: s.error || '알 수 없는 오류' };
      });
    const payload = {
      workflowId: workflow.id || null,
      workflowName: workflow.name || '(임시)',
      executionId: exec.id,
      trigger,
      failedAt: exec.at,
      errorNode: failedNodes[0]?.nodeKind || 'unknown',
      errorMessage: failedNodes[0]?.error || '알 수 없는 오류',
      failedNodes,
    };
    // 응답을 막지 않도록 비동기 발동
    dispatchErrorWorkflows({ workflowId: workflow.id || null, payload }).catch(() => {});
  }

  return { execution: exec, outputs, statuses, logs };
}

/* ---------- 스케줄러 ---------- */
const CRON_BY_INTERVAL = {
  '매분': '* * * * *',
  '10분마다': '*/10 * * * *',
  '매시': '0 * * * *',
  '매일 09:00': '0 9 * * *',
  '매주 월요일': '0 9 * * 1',
};
const scheduled = new Map(); // key: `${wfId}:${nodeId}` -> cron task

function clearSchedulesFor(wfId) {
  for (const [key, task] of scheduled) {
    if (key.startsWith(wfId + ':')) { task.stop(); scheduled.delete(key); }
  }
}
function registerSchedules(wf) {
  clearSchedulesFor(wf.id);
  if (!wf.active) return;
  for (const node of wf.nodes || []) {
    if (node.data.kind !== 'scheduleTrigger') continue;
    const expr = CRON_BY_INTERVAL[node.data.params?.interval] || null;
    if (!expr || !cron.validate(expr)) continue;
    const task = cron.schedule(expr, async () => {
      const fresh = Workflows.get(wf.id);
      if (!fresh || !fresh.active) return;
      const seed = { [node.id]: { main: { triggeredAt: new Date().toISOString(), interval: node.data.params.interval } } };
      await execute(fresh, { seed, trigger: 'schedule' });
      console.log(`[cron] ${wf.name} 실행 (${node.data.params.interval})`);
    });
    scheduled.set(`${wf.id}:${node.id}`, task);
  }
}
function registerAll() {
  for (const wf of Workflows.all()) registerSchedules(wf);
  console.log(`[cron] 활성 스케줄 ${scheduled.size}개 등록`);
}

/* ---------- 라우트: 워크플로 ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Conduit', time: new Date().toISOString() }));

app.get('/api/workflows', (_req, res) => {
  res.json(Workflows.all().map((w) => ({
    id: w.id, name: w.name, active: w.active,
    nodeCount: w.nodes.length, updatedAt: w.updatedAt,
  })));
});
app.get('/api/workflows/:id', (req, res) => {
  const wf = Workflows.get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(wf);
});
app.post('/api/workflows', (req, res) => {
  const saved = Workflows.save(req.body);
  registerSchedules(saved);
  res.json(saved);
});
app.delete('/api/workflows/:id', (req, res) => {
  clearSchedulesFor(req.params.id);
  Workflows.remove(req.params.id);
  res.json({ ok: true });
});

/* ---------- 라우트: 실행 ---------- */
app.post('/api/run', async (req, res) => {
  // 저장하지 않은 현재 캔버스 즉시 실행
  const result = await execute({ id: null, name: '(캔버스)', ...req.body }, { trigger: 'manual' });
  res.json(result);
});
app.post('/api/workflows/:id/run', async (req, res) => {
  const wf = Workflows.get(req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json(await execute(wf, { trigger: 'manual' }));
});

// SSE 스트리밍 실행 — 노드 상태/로그/에이전트 스텝을 실시간 전송
app.post('/api/run/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  const workflow = { id: null, name: '(캔버스)', ...req.body };
  const nodes = (workflow.nodes || []).map((n) => ({ id: n.id, data: { kind: n.data.kind, params: n.data.params } }));
  const edges = workflow.edges || [];

  const logs = [];
  const statuses = {};
  try {
    await runFlow(nodes, edges, {
      onStatus: (id, status, payload) => {
        statuses[id] = { status, ...(payload || {}) };
        send('status', { id, status, output: payload?.output, input: payload?.input, error: payload?.error });
      },
      onLog: (l) => { logs.push(l); send('log', l); },
      onAgentStep: (id, step) => send('agentStep', { id, step }),
      onItemProgress: (id, done, total) => send('progress', { id, done, total }),
    });
    const hadError = Object.values(statuses).some((s) => s.status === 'error');
    const exec = Executions.add({ workflowId: null, workflowName: workflow.name, trigger: 'manual', status: hadError ? 'error' : 'success', logs, statuses });
    if (hadError) {
      const failedNodes = Object.entries(statuses)
        .filter(([, s]) => s.status === 'error')
        .map(([id, s]) => {
          const node = (workflow.nodes || []).find((n) => n.id === id);
          return { nodeId: id, nodeKind: node?.data?.kind || 'unknown', error: s.error || '알 수 없는 오류' };
        });
      dispatchErrorWorkflows({
        workflowId: null,
        payload: {
          workflowId: null, workflowName: workflow.name, executionId: exec.id, trigger: 'manual',
          failedAt: exec.at, errorNode: failedNodes[0]?.nodeKind || 'unknown',
          errorMessage: failedNodes[0]?.error || '알 수 없는 오류', failedNodes,
        },
      }).catch(() => {});
    }
    send('done', {});
  } catch (e) {
    send('log', { kind: 'err', msg: '실행 오류: ' + e.message });
    send('done', {});
  }
  res.end();
});

/* ---------- 라우트: 실행 기록 ---------- */
app.get('/api/executions', (req, res) => {
  const { workflowId } = req.query;
  const list = workflowId ? Executions.forWorkflow(workflowId) : Executions.all();
  res.json(list.slice(0, 50));
});

/* ---------- 라우트: 크리덴셜 ---------- */
app.get('/api/credentials', (_req, res) => res.json(Credentials.listMasked()));
app.post('/api/credentials', (req, res) => res.json(Credentials.save(req.body)));
app.delete('/api/credentials/:id', (req, res) => { Credentials.remove(req.params.id); res.json({ ok: true }); });

/* ---------- 웹훅 수신 ---------- */
app.all('/webhook/:p(*)', async (req, res) => {
  const hookPath = '/' + req.params.p;
  const payload = req.method === 'GET' ? req.query : req.body;

  let matched = null;
  for (const wf of Workflows.all()) {
    if (!wf.active) continue;
    const node = (wf.nodes || []).find(
      (n) => n.data.kind === 'webhookTrigger' && n.data.params?.path === hookPath
    );
    if (node) { matched = { wf, node }; break; }
  }
  if (!matched) return res.status(404).json({ error: `활성 워크플로에 웹훅 ${hookPath} 없음` });

  // 1) 서명 검증 (노드 설정: signature=none|slack|github|stripe|generic, secretCred=크리덴셜 이름)
  const scheme = matched.node.data.params?.signature || 'none';
  const verdict = verifySignature(scheme, {
    headers: req.headers,
    rawBody: req.rawBody || '',
    credentialName: matched.node.data.params?.secretCred || '',
  });
  if (!verdict.ok) {
    console.warn(`[webhook] 서명 검증 실패 ${hookPath}: ${verdict.reason}`);
    return res.status(verdict.status).json({ error: verdict.reason });
  }

  // 2) 멱등성 게이트 — 같은 이벤트 재전송이면 실행하지 않음
  const key = idempotencyKey({ headers: req.headers, body: payload, rawBody: req.rawBody, path: hookPath });
  const claim = ProcessedEvents.claim(key, { source: 'webhook', eventType: hookPath });
  if (!claim.claimed) {
    return res.status(200).json({ received: true, deduped: true, reason: claim.reason, idempotencyKey: key });
  }

  // 3) 실행
  try {
    const seed = { [matched.node.id]: { main: payload } };
    const result = await execute(matched.wf, { seed, trigger: 'webhook' });
    ProcessedEvents.complete(key, result.execution.id);
    res.json({ received: true, workflow: matched.wf.name, executionId: result.execution.id, idempotencyKey: key });
  } catch (e) {
    ProcessedEvents.fail(key);
    DLQ.add({ workflowId: matched.wf.id, workflowName: matched.wf.name, nodeId: matched.node.id, nodeKind: 'webhookTrigger', payload, errorCode: 'EXEC', errorMsg: e.message });
    res.status(500).json({ error: e.message });
  }
});

/* ---------- MCP 도구 목록 (노드 패널 자동 표시용) ---------- */
app.get('/api/mcp/tools', async (_req, res) => {
  const servers = Credentials.all().filter((c) => c.type === 'mcp');
  const out = [];
  for (const s of servers) {
    try {
      const r = await mcpListTools(s.name);
      out.push({ server: s.name, tools: r.tools || [], error: r.simulated ? r.note : undefined });
    } catch (e) {
      out.push({ server: s.name, tools: [], error: e.message });
    }
  }
  res.json(out);
});

/* ---------- Conduit = MCP 서버 (Streamable HTTP · JSON 응답) ----------
   Claude Code 등록:  claude mcp add --transport http conduit http://localhost:8787/mcp
   저장된 워크플로가 MCP 도구(run_<id>)로 노출된다. */
app.post('/mcp', async (req, res) => {
  const m = req.body || {};
  const reply = (result) => res.json({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id: m.id, error: { code, message } });

  try {
    if (m.method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'conduit', version: '1.0.0' },
      });
    }
    if (String(m.method || '').startsWith('notifications/')) return res.status(202).end();

    if (m.method === 'tools/list') {
      const tools = Workflows.all().map((w) => ({
        name: 'run_' + w.id,
        description: `Conduit 워크플로 "${w.name}" 실행 (노드 ${w.nodes.length}개${w.active ? ' · 활성' : ''})`,
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'object', description: '트리거에 주입할 입력 데이터 (JSON)' } },
        },
      }));
      return reply({ tools });
    }

    if (m.method === 'tools/call') {
      const { name, arguments: args } = m.params || {};
      const wf = Workflows.get(String(name || '').replace(/^run_/, ''));
      if (!wf) return fail(-32602, `워크플로를 찾을 수 없습니다: ${name}`);

      const seed = {};
      for (const n of wf.nodes || []) {
        if (['manualTrigger', 'webhookTrigger', 'scheduleTrigger', 'errorTrigger'].includes(n.data.kind)) {
          seed[n.id] = { main: args?.input || {} };
        }
      }
      const result = await execute(wf, { seed, trigger: 'mcp' });

      // 출력 노드들의 결과를 모아 응답
      const outs = [];
      for (const n of wf.nodes || []) {
        if (n.data.kind === 'output') {
          const o = result.outputs[n.id]?.main;
          if (o !== undefined) outs.push(...(Array.isArray(o) ? o : [o]));
        }
      }
      return reply({
        content: [{ type: 'text', text: JSON.stringify(outs.length === 1 ? outs[0] : outs, null, 2) }],
        isError: result.execution.status !== 'success',
      });
    }

    return fail(-32601, '지원하지 않는 메서드: ' + m.method);
  } catch (e) {
    return fail(-32603, e.message);
  }
});
app.get('/mcp', (_req, res) => res.status(405).json({ error: 'POST JSON-RPC 요청만 지원합니다' }));

/* ---------- DLQ / 멱등성 조회 ---------- */
app.get('/api/dlq', (_req, res) => res.json(DLQ.all().slice(0, 100)));
app.post('/api/dlq/:id/replay', async (req, res) => {
  const rec = DLQ.all().find((r) => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const wf = rec.workflow_id ? Workflows.get(rec.workflow_id) : null;
  if (!wf) { DLQ.setStatus(rec.id, 'dropped'); return res.status(400).json({ error: '원본 워크플로를 찾을 수 없어 replay 불가' }); }
  const seed = {};
  for (const n of wf.nodes || []) {
    if (['manualTrigger', 'webhookTrigger', 'scheduleTrigger'].includes(n.data.kind)) seed[n.id] = { main: rec.payload || {} };
  }
  const result = await execute(wf, { seed, trigger: 'replay' });
  DLQ.setStatus(rec.id, 'replayed');
  res.json({ ok: true, executionId: result.execution.id });
});
app.delete('/api/dlq/:id', (req, res) => { DLQ.remove(req.params.id); res.json({ ok: true }); });
app.get('/api/idempotency', (_req, res) => res.json(ProcessedEvents.all().slice(-100).reverse()));

/* ---------- 채널 관제 대시보드 ---------- */
const WEEK_VIDEOS = [
  { id: 'gcmHlHI0ias', day: '일', name: '고양이 회전 착시' },
  { id: 'LA27Sm5cgTM', day: '월', name: '색각 숨은 숫자' },
  { id: '1lRyPFZgUqQ', day: '화', name: '집중력 반전' },
  { id: 'fbCpICUyjKk', day: '수', name: '청력 나이 (포맷 중단)' },
  // 목 '정신연령'(850ScUCEt2w)은 성과 부진으로 삭제됨 — 조회 시 404가 나므로 목록에서 제외
];
app.get('/api/channel/stats', async (_req, res) => {
  try {
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        refresh_token: process.env.YOUTUBE_REFRESH_TOKEN, grant_type: 'refresh_token',
      }),
    }).then((r) => r.json());
    if (!tok.access_token) return res.status(500).json({ error: 'YouTube 토큰 갱신 실패 (.env 확인)' });
    const H = { Authorization: `Bearer ${tok.access_token}` };
    const ids = WEEK_VIDEOS.map((v) => v.id).join(',');
    const [vids, ch] = await Promise.all([
      fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,status,snippet&id=${ids}`, { headers: H }).then((r) => r.json()),
      fetch('https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true', { headers: H }).then((r) => r.json()),
    ]);
    const videos = WEEK_VIDEOS.map((w) => {
      const it = (vids.items || []).find((x) => x.id === w.id);
      return it ? {
        ...w, title: it.snippet.title, privacy: it.status.privacyStatus, publishAt: it.status.publishAt || null,
        views: Number(it.statistics.viewCount || 0), likes: Number(it.statistics.likeCount || 0), comments: Number(it.statistics.commentCount || 0),
      } : { ...w, missing: true };
    });
    res.json({ channel: ch.items?.[0]?.statistics || {}, videos, at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/dashboard', (_req, res) =>
  res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html')));

/* ---------- 프로덕션: 빌드된 프론트엔드 서빙 (단일 컨테이너) ---------- */
const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA 폴백 — /api, /webhook 이 아닌 경로는 index.html
  app.get(/^\/(?!api|webhook).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  console.log('[static] 프론트엔드 dist 서빙 활성화');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Conduit 실행 중 → http://localhost:${PORT}`);
  registerAll();
});

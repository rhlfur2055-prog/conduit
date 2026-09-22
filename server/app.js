// ============================================================
// Express 앱 조립 — 미들웨어 → 공개 라우트 → 인증 → 보호 라우트 → 정적 파일
// listen 은 index.js 가 한다 (테스트는 이 app 을 import 해 임시 포트에 띄운다).
// ============================================================
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireApiKey, authMode } from './auth.js';
import { codeExecutionAllowed } from './policy.js';
import { workflows } from './routes/workflows.js';
import { webhooks } from './routes/webhooks.js';
import { mcpTools, mcpServer } from './routes/mcp.js';
import { dlq } from './routes/dlq.js';
import { channelApi, dashboardPage } from './routes/channel.js';
import { approvals } from './routes/approvals.js';

export function createApp() {
  const app = express();
  // 브라우저 교차 출처는 로컬 프론트(localhost·127.0.0.1)만 허용 — 아무 웹페이지의 스크립트가 로컬 서버를 부르지 못하게
  // (같은 서버가 dist 를 서빙하면 동일 출처라 CORS 가 필요 없다. 다른 호스트의 프론트는 CONDUIT_CORS_ORIGINS 에 쉼표로)
  const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
  const extraOrigins = () => String(process.env.CONDUIT_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || LOCAL_ORIGIN.test(origin) || extraOrigins().includes(origin)) }));
  // 서명 검증을 위해 raw body 를 보존한다
  app.use(express.json({
    limit: '4mb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  /* ---------- 공개 ---------- */
  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, name: 'Conduit', time: new Date().toISOString(), auth: authMode(), code: codeExecutionAllowed() ? 'on' : 'off' }));
  // 웹훅은 외부 서비스가 부르는 입구 — 노드별 HMAC 서명 검증 + 멱등성으로 보호
  app.use('/webhook', webhooks);
  app.use('/dashboard', dashboardPage);

  /* ---------- 인증 — 여기부터 /api/*, /mcp 는 키가 필요하다 ---------- */
  app.use(['/api', '/mcp'], requireApiKey());

  /* ---------- 보호 라우트 ---------- */
  app.use('/api', workflows);      // /api/workflows, /api/run, /api/executions, /api/credentials
  app.use('/api', dlq);            // /api/dlq, /api/idempotency
  app.use('/api', approvals);      // /api/approvals — 사람 승인 대기 목록·결정
  app.use('/api/mcp', mcpTools);   // /api/mcp/tools
  app.use('/api/channel', channelApi);
  app.use('/mcp', mcpServer);

  /* ---------- 프로덕션: 빌드된 프론트엔드 서빙 (단일 컨테이너) ---------- */
  const distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA 폴백 — /api, /webhook 이 아닌 경로는 index.html
    app.get(/^\/(?!api|webhook).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
    console.log('[static] 프론트엔드 dist 서빙 활성화');
  }

  return app;
}

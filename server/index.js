// ============================================================
// Conduit 백엔드 — 진입점
//   env.js      .env 로드 (가장 먼저)
//   bridges.js  서버 전용 기능을 실행 엔진에 주입
//   app.js      Express 앱 조립 (라우트는 routes/*)
//   runtime.js  워크플로 실행 · Error Trigger · 크론
// 실행 엔진(src/engine)은 프론트엔드와 동일한 소스를 재사용한다.
// ============================================================
import './env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installBridges } from './bridges.js';
import { createApp } from './app.js';
import { authMode } from './auth.js';
import { codeExecutionAllowed } from './policy.js';
import { registerAll } from './runtime.js';
import { startApprovalTimer, recoverAtBoot } from './approvals.js';
import { closeOcr } from './vision.js';
import { startHeartbeat, runHeartbeat } from './heartbeat.js';
import { startTelegram, telegramMode } from './telegramChannel.js';
import { applyHeartbeatSetting } from './quickstart.js';

// 직접 실행(node server/index.js)인지, 테스트 등에서 import 했는지
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// 장시간 실행 서버 보호 — 도구/라이브러리의 미처리 오류로 프로세스가 죽지 않게
// (import 한 쪽의 오류 처리를 가리지 않도록 직접 실행할 때만 등록)
if (isMain) {
  process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));
}

installBridges();
export const app = createApp();

if (isMain) {
  const PORT = process.env.PORT || 8787;
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n  Conduit 실행 중 → http://localhost:${PORT}`);
    console.log(authMode() === 'api-key'
      ? '  인증: API 키 필요 (CONDUIT_API_KEY)'
      : '  인증: 키 미설정 — 이 컴퓨터(127.0.0.1)에서 온 요청만 허용. 외부에 열려면 CONDUIT_API_KEY 를 설정하세요.');
    console.log(`  코드 실행: ${codeExecutionAllowed() ? '켜짐' : '꺼짐 (CONDUIT_ALLOW_CODE)'}`);
    registerAll();
    await recoverAtBoot().catch((e) => console.warn('[approval] 기동 정리 실패:', e.message));
    // 텔레그램 — 승인 버튼 + 휴대폰↔PC 주고받기 (롱폴링, 공개 URL 불필요). 토큰은 .env 또는 쉬운 시작 화면
    if (await startTelegram({ onReceived: () => runHeartbeat() })) {
      console.log(`  텔레그램: 연결됨 · 모드 ${telegramMode()}`);
    } else {
      console.log('  텔레그램: 꺼짐 (토큰 없음 — 쉬운 시작 화면에서 연결할 수 있다)');
    }
    startApprovalTimer();
    // 하트비트 — 목표를 보고 스스로 일을 시작한다 (specs/004)
    const hbEnv = startHeartbeat();
    const hbSet = hbEnv ? null : applyHeartbeatSetting();
    console.log(hbEnv ? `  자동 확인(하트비트): ${process.env.CONDUIT_HEARTBEAT}` : hbSet ? `  자동 확인(하트비트): ${hbSet} (쉬운 시작 설정)` : '  자동 확인(하트비트): 꺼짐');
  });

  // OCR 워커(tesseract.js)는 한 번 뜨면 프로세스를 붙잡고 있으므로 종료 시 정리한다
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await closeOcr();
      process.exit(0);
    });
  }
}

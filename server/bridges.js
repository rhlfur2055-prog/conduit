// ============================================================
// 서버 전용 기능 브리지 — 실행 엔진(src/engine)은 브라우저와 공용이라
// LLM·외부 연동·에이전트 같은 서버 기능을 globalThis 로 주입받는다.
// 브라우저에서는 이 주입이 없으므로 노드가 시뮬레이션 응답을 낸다.
// ============================================================
import { readData } from './store.js';
import { callLLM } from './llm.js';
import * as integrations from './integrations.js';
import { runAgent } from './agent.js';
import { mcpListTools, mcpCallTool } from './mcp.js';
import { fetchHotTopics } from './hottopics.js';
import { requestApproval } from './approvals.js';
import { telegramSend } from './telegram.js';
import { understandScreen } from './vision.js';
import { plateRecognize } from './plateRecognize.js';
import { socraticRead } from './socratic.js';
import { readText } from './ocrEnsemble.js';
import { recall as memoryRecall } from './memory/memory.js';
import { changeDetect, memoryDigest } from './templates.js';

export function installBridges() {
  globalThis.__conduitLLM = callLLM;
  globalThis.__conduitAgent = runAgent;
  globalThis.__conduitData = readData;   // 코드 노드에서 server/data/*.json 을 읽을 때 사용
  globalThis.__conduitIntegrations = {
    slack: integrations.slack,
    gmail: integrations.gmail,
    notion: integrations.notion,
    youtube: integrations.youtube,
    naver: integrations.naver,
    http: integrations.http,
    hotTopics: fetchHotTopics,
    approval: requestApproval,   // 사람 승인 대기 — 스냅샷 저장 + 텔레그램 버튼 메시지
    telegram: telegramSend,
    ocr: (a) => readText(a),
    screenUnderstand: understandScreen,
    plateRecognize,
    socraticRead,
    memoryRecall,
    changeDetect,
    memoryDigest,
    mcp: async ({ credential, tool, args }) => {
      if (!tool) return mcpListTools(credential);
      let parsed = {};
      try { parsed = args ? JSON.parse(args) : {}; } catch { /* 빈 인자로 진행 */ }
      return mcpCallTool(credential, tool, parsed);
    },
  };
}

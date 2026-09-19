// ============================================================
// 서버 전용 기능 브리지 — 실행 엔진(src/engine)은 브라우저와 공용이라
// LLM·외부 연동·에이전트 같은 서버 기능을 globalThis 로 주입받는다.
// 브라우저에서는 이 주입이 없으므로 노드가 시뮬레이션 응답을 낸다.
// ============================================================
import { readData, VerifiedComments } from './store.js';
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

export function installBridges() {
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
}

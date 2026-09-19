// ============================================================
// MCP 서버 — tools/list · tools/call 을 Conduit 서버로 전달한다.
// 도구 목록은 요청마다 Conduit 에서 새로 가져오므로, Conduit 에 워크플로를
// 저장하면 이 서버를 재시작하지 않아도 다음 tools/list 에 바로 나타난다.
// ============================================================
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * @param {ReturnType<import('./conduit.js').createConduitClient>} conduit
 * @param {{ name?: string, version?: string }} [info]
 */
export function createServer(conduit, { name = 'conduit-workflows', version = '0.0.0' } = {}) {
  const server = new Server({ name, version }, { capabilities: { tools: {} } });

  // 연결 불가·인증 실패는 예외로 던진다 → 클라이언트에 JSON-RPC 오류로 전달 (메시지에 해결 방법 포함)
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const r = await conduit.rpc('tools/list', {});
    return { tools: r?.tools || [] };
  });

  // 도구 실행 실패는 isError 결과로 돌려준다 — 모델이 읽고 다음 행동을 정할 수 있게
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: tool, arguments: args } = req.params;
    try {
      const r = await conduit.rpc('tools/call', { name: tool, arguments: args || {} });
      return { content: r?.content || [], isError: !!r?.isError };
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
  });

  return server;
}

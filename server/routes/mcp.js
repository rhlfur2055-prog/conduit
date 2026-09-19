// MCP — ① 연결된 외부 MCP 서버의 도구 목록(노드 패널용)  ② Conduit 자체가 MCP 서버(워크플로 → 도구)
import { Router } from 'express';
import { Workflows, Credentials } from '../store.js';
import { mcpListTools } from '../mcp.js';
import { execute } from '../runtime.js';

/* ---------- /api/mcp/tools — 외부 MCP 서버 도구 목록 (노드 패널 자동 표시용) ---------- */
export const mcpTools = Router();
mcpTools.get('/tools', async (_req, res) => {
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

/* ---------- /mcp — Conduit = MCP 서버 (Streamable HTTP · JSON 응답) ----------
   Claude Code 등록:  claude mcp add --transport http conduit http://localhost:8787/mcp
   저장된 워크플로가 MCP 도구(run_<id>)로 노출된다. */
export const mcpServer = Router();

const TRIGGER_KINDS = ['manualTrigger', 'webhookTrigger', 'scheduleTrigger', 'errorTrigger'];

mcpServer.post('/', async (req, res) => {
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
        if (TRIGGER_KINDS.includes(n.data.kind)) seed[n.id] = { main: args?.input || {} };
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
mcpServer.get('/', (_req, res) => res.status(405).json({ error: 'POST JSON-RPC 요청만 지원합니다' }));

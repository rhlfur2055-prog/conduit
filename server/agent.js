// ============================================================
// AI 에이전트 — Anthropic tool_use 루프.
// LLM 이 도구를 선택 → 서버가 실제로 실행 → 결과를 되먹임 → 반복.
// nodeTypes 의 aiAgent 노드가 globalThis.__conduitAgent 로 사용한다.
// ============================================================
import { getApiKey, getProvider } from './llm.js';
import * as integrations from './integrations.js';
import { Workflows } from './store.js';
import { runFlow } from '../src/engine/executor.ts';
import { mcpListTools, mcpCallTool } from './mcp.js';
import { codeExecutionAllowed, currentPolicy } from './policy.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 코드를 실행하는 도구 — 서버 정책상 코드 실행이 꺼져 있으면 LLM 에게 보여 주지도, 실행하지도 않는다
const CODE_TOOLS = new Set(['run_code']);

/** 요청된 도구 이름에서 존재하지 않거나 정책상 막힌 도구를 뺀다 */
export function agentToolNames(requested, { allowCode = true } = {}) {
  const all = Object.keys(TOOLS);
  const names = requested && requested.length ? requested : all;
  return names.filter((n) => TOOLS[n] && (allowCode || !CODE_TOOLS.has(n)));
}

// ---------- 서브워크플로 실행 (재귀 깊이 가드) ----------
let subDepth = 0;
function findWorkflow(ref) {
  const all = Workflows.all();
  return all.find((w) => w.id === ref) || all.find((w) => w.name === ref) || null;
}
export async function runSubworkflow(ref, input) {
  if (subDepth >= 2) return { error: '서브워크플로 중첩 한도(2)를 초과했습니다.' };
  const wf = findWorkflow(ref);
  if (!wf) return { error: `워크플로 '${ref}' 를 찾을 수 없습니다.` };
  subDepth++;
  try {
    const nodes = (wf.nodes || []).map((n) => ({ id: n.id, data: { kind: n.data.kind, params: n.data.params } }));
    const edges = wf.edges || [];
    // 트리거 노드에 입력 데이터를 주입
    const seed = {};
    for (const n of nodes) {
      if (['manualTrigger', 'webhookTrigger', 'scheduleTrigger'].includes(n.data.kind)) {
        seed[n.id] = { main: input || {} };
      }
    }
    const results = await runFlow(nodes, edges, { seed, policy: currentPolicy() });
    const outs = nodes
      .filter((n) => n.data.kind === 'output')
      .map((n) => results.get(n.id)?.output?.main)
      .filter((x) => x !== undefined);
    return { ok: true, workflow: wf.name, result: outs.length === 1 ? outs[0] : outs };
  } finally {
    subDepth--;
  }
}

// ---------- 도구 레지스트리 (실제 실행) ----------
const TOOLS = {
  run_code: {
    schema: {
      name: 'run_code',
      description: '주어진 JavaScript를 실행하고 return 값을 반환한다. 계산·데이터 변환·문자열 처리에 사용.',
      input_schema: { type: 'object', properties: { code: { type: 'string', description: 'return 문을 포함한 JS 코드' } }, required: ['code'] },
    },
    run: async ({ code }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { ${code} })()`);
      const r = await fn();
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  },
  http_get: {
    schema: {
      name: 'http_get',
      description: '공개 URL로 GET 요청을 보내고 응답 본문을 반환한다. 웹/공개 API 데이터 조회.',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    run: async ({ url }) => {
      const res = await fetch(url);
      const ct = res.headers.get('content-type') || '';
      const d = ct.includes('json') ? await res.json() : await res.text();
      const s = typeof d === 'string' ? d : JSON.stringify(d);
      return s.slice(0, 4000);
    },
  },
  http_auth: {
    schema: {
      name: 'http_auth',
      description: '인증이 필요한 API에 요청한다. 저장된 httpAuth 크리덴셜(Bearer 등)로 인증. GitHub/Stripe 등.',
      input_schema: {
        type: 'object',
        properties: { method: { type: 'string' }, url: { type: 'string' }, body: { type: 'string' } },
        required: ['url'],
      },
    },
    run: async (a, ctx) => {
      const r = await integrations.http({
        credential: ctx?.creds?.http || '', authType: 'bearer',
        method: a.method || 'GET', url: a.url, body: a.body,
      });
      return JSON.stringify(r).slice(0, 4000);
    },
  },
  youtube_search: {
    schema: {
      name: 'youtube_search',
      description: 'YouTube에서 동영상을 검색한다(크리덴셜 필요). 제목/채널/링크 목록 반환.',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
    },
    run: async (a, ctx) => JSON.stringify(await integrations.youtube({ credential: ctx?.creds?.youtube || '', query: a.query, maxResults: a.maxResults || 5 })),
  },
  naver_search: {
    schema: {
      name: 'naver_search',
      description: '네이버에서 뉴스/블로그 등을 검색한다(크리덴셜 필요).',
      input_schema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string' } }, required: ['query'] },
    },
    run: async (a, ctx) => JSON.stringify(await integrations.naver({ credential: ctx?.creds?.naver || '', query: a.query, type: a.type || 'news', display: 5 })),
  },
  slack_post: {
    schema: {
      name: 'slack_post',
      description: 'Slack 채널에 메시지를 보낸다(크리덴셜 필요).',
      input_schema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] },
    },
    run: async (a, ctx) => JSON.stringify(await integrations.slack({ credential: ctx?.creds?.slack || '', channel: a.channel, text: a.text })),
  },
  notion_create: {
    schema: {
      name: 'notion_create',
      description: 'Notion 데이터베이스에 페이지를 생성한다(크리덴셜 필요).',
      input_schema: { type: 'object', properties: { databaseId: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['databaseId', 'title'] },
    },
    run: async (a, ctx) => JSON.stringify(await integrations.notion({ credential: ctx?.creds?.notion || '', databaseId: a.databaseId, titleProp: 'Name', title: a.title, content: a.content })),
  },
  run_workflow: {
    schema: {
      name: 'run_workflow',
      description: '저장된 다른 워크플로를 도구로 실행한다. 이름 또는 ID로 지정하고 입력 데이터를 넘기면 그 워크플로가 실행되고 출력을 반환한다.',
      input_schema: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: '실행할 워크플로 이름 또는 ID' },
          input: { type: 'object', description: '트리거에 전달할 입력 데이터' },
        },
        required: ['workflow'],
      },
    },
    run: async (a) => JSON.stringify(await runSubworkflow(a.workflow, a.input || {})),
  },
  mcp_list_tools: {
    schema: {
      name: 'mcp_list_tools',
      description: '연결된 MCP 서버가 제공하는 도구 목록을 조회한다. mcp_call 전에 먼저 호출해 사용 가능한 도구를 확인하라.',
      input_schema: {
        type: 'object',
        properties: { server: { type: 'string', description: 'MCP 서버 크리덴셜 이름 (생략 시 기본)' } },
      },
    },
    run: async (a, ctx) => JSON.stringify(await mcpListTools(a.server || ctx?.creds?.mcp || '')),
  },
  mcp_call: {
    schema: {
      name: 'mcp_call',
      description: 'MCP 서버의 도구를 호출한다. 도구 이름과 인자는 mcp_list_tools 로 확인한 스키마를 따른다.',
      input_schema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP 서버 크리덴셜 이름 (생략 시 기본)' },
          tool: { type: 'string', description: '호출할 도구 이름' },
          args: { type: 'object', description: '도구 인자' },
        },
        required: ['tool'],
      },
    },
    run: async (a, ctx) => JSON.stringify(await mcpCallTool(a.server || ctx?.creds?.mcp || '', a.tool, a.args || {})),
  },
};

async function anthropic(messages, system, model, tools, key) {
  const res = await fetch(`${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || 'claude-sonnet-5', max_tokens: 1500, system: system || undefined, tools, messages }),
  });
  return res.json();
}

/**
 * @returns { text, steps: [{step, tool, input, output}], simulated? }
 */
export async function runAgent({ system, task, model, maxSteps = 4, toolNames, creds = {}, onStep }) {
  const key = getApiKey();
  const allowCode = codeExecutionAllowed();
  const names = agentToolNames(toolNames, { allowCode });
  const tools = names.map((n) => {
    if (n === 'run_workflow') {
      const list = Workflows.all().map((w) => `"${w.name}"`).join(', ');
      return { ...TOOLS[n].schema, description: `${TOOLS[n].schema.description} 사용 가능한 워크플로: ${list || '(없음)'}.` };
    }
    return TOOLS[n].schema;
  });

  if (!key) {
    const DEMO_INPUT = {
      run_code: { code: 'return 2 + 2;' },
      http_get: { url: 'https://api.github.com/zen' },
      http_auth: { method: 'GET', url: 'https://api.github.com/user' },
      youtube_search: { query: String(task || '').slice(0, 20) },
      naver_search: { query: String(task || '').slice(0, 20) },
      slack_post: { channel: '#general', text: '결과 공유' },
      notion_create: { databaseId: '…', title: '새 페이지' },
      run_workflow: { workflow: '웹훅 테스트', input: { amount: 5000 } },
      mcp_list_tools: { server: '' },
      mcp_call: { tool: 'echo', args: { text: 'hello' } },
    };
    const steps = names.slice(0, 3).map((t, idx) => ({
      step: idx + 1,
      tool: t,
      input: DEMO_INPUT[t] || {},
      output: `(예시) ${t} 결과 — Anthropic 키를 설정하면 실제 호출 결과가 들어갑니다.`,
    }));
    // 스트리밍 데모: 스텝을 지연을 두고 하나씩 흘려보낸다
    for (const s of steps) {
      if (onStep) { await sleep(700); onStep(s); }
    }
    const p = await getProvider();
    return {
      simulated: true,
      localMode: p?.kind === 'local',
      note: p?.kind === 'local' ? '내 PC 모델 모드 — 도구 호출(에이전트)은 아직 Claude 전용이라 예시로 대체했어요' : undefined,
      text: `〔예시〕 키가 설정되면 이 에이전트가 도구(${names.join(', ')})를 실제로 호출하며 "${String(task || '').slice(0, 50)}" 를 수행합니다. 아래는 타임라인 예시입니다.`,
      steps,
    };
  }

  const messages = [{ role: 'user', content: task || '' }];
  const steps = [];
  let finalText = '';

  for (let step = 0; step < Math.max(1, maxSteps); step++) {
    const data = await anthropic(messages, system, model, tools, key);
    if (data.error) return { error: data.error.message, steps };

    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) finalText = text;

    const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: data.content });

    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    const results = [];
    for (const tu of toolUses) {
      // 목록에서 뺐더라도 모델이 이름을 지어내 부를 수 있으므로 실행 직전에 한 번 더 막는다
      const tool = names.includes(tu.name) ? TOOLS[tu.name] : null;
      let out;
      try {
        out = tool ? await tool.run(tu.input || {}, { creds })
          : TOOLS[tu.name] ? `ERROR: 이 서버에서는 ${tu.name} 도구를 쓸 수 없습니다 (CONDUIT_ALLOW_CODE)`
          : `알 수 없는 도구: ${tu.name}`;
      } catch (e) {
        out = 'ERROR: ' + e.message;
      }
      const stepRec = { step: step + 1, tool: tu.name, input: tu.input, output: String(out).slice(0, 1200) };
      steps.push(stepRec);
      if (onStep) onStep(stepRec);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: finalText, steps };
}

export const AGENT_TOOLS = Object.keys(TOOLS);

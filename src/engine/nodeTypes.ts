// ============================================================
// 노드 타입 레지스트리 (확장판)
//   run(inputs, params, ctx) — params 는 실행 엔진이 표현식을 이미 해석해서 전달
//   inputs.<port> = 이전 노드의 출력 객체 (없으면 undefined)
//   반환: { <outputPort>: value }  (value 가 undefined 면 그 경로는 흐르지 않음)
// backend:true 인 노드는 실제 연동에 서버가 필요 → 지금은 시뮬레이션 결과를 낸다.
// ============================================================

import { toItems, stableKey } from './items.ts';
import type { Item, LLMArgs, LLMResult, NodeDefinition } from './types.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const getPath = (obj: unknown, path: unknown): unknown =>
  String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);

function compare(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case '==': return String(a) === String(b);
    case '!=': return String(a) !== String(b);
    case '>': return Number(a) > Number(b);
    case '<': return Number(a) < Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<=': return Number(a) <= Number(b);
    case 'contains': return String(a).includes(String(b));
    case 'isEmpty': return a === undefined || a === null || a === '';
    default: return false;
  }
}

function simpleHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// LLM 브리지: 서버가 globalThis.__conduitLLM 을 주입하면 실제 Claude 호출,
// 브라우저(주입 없음)에서는 시뮬레이션 결과를 낸다.
async function callLLM({ system, prompt, model, messages }: LLMArgs): Promise<LLMResult> {
  const bridge = globalThis.__conduitLLM;
  if (bridge) return bridge({ system, prompt, model, messages });
  return {
    text: `〔시뮬레이션〕 "${String(prompt || '').slice(0, 80)}" — 서버에서 실행하면 실제 Claude(${model || 'claude-sonnet-5'}) 응답이 나옵니다.`,
    simulated: true,
  };
}
const AI_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'];

// 통합 브리지: 서버가 globalThis.__conduitIntegrations 를 주입하면 실제 API 호출,
// 브라우저(주입 없음)에서는 "서버 필요" 안내를 낸다.
export async function callIntegration(name: string, args: Record<string, unknown>): Promise<any> {
  const bridge = globalThis.__conduitIntegrations;
  if (bridge && bridge[name]) return bridge[name](args);
  return { simulated: true, note: `${name} 연동은 서버 실행 + 크리덴셜이 필요합니다. 상단바 "서버 실행" 을 눌러주세요.` };
}

// 도구를 실제로 호출하는 에이전트 브리지 (서버에서 tool_use 루프 실행)
async function callAgent(args: Record<string, unknown>): Promise<any> {
  const bridge = globalThis.__conduitAgent;
  if (bridge) return bridge(args);
  return { simulated: true, text: '〔시뮬레이션〕 서버에서 실행하면 도구를 실제로 호출하는 에이전트가 동작합니다.', steps: [] };
}
const AGENT_TOOLS = ['run_code', 'http_get', 'http_auth', 'youtube_search', 'naver_search', 'slack_post', 'notion_create', 'run_workflow', 'mcp_list_tools', 'mcp_call'];

// "slack=내슬랙, notion=업무" → { slack:'내슬랙', notion:'업무' }
function parseCreds(str: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  String(str || '').split(',').forEach((pair) => {
    const [k, v] = pair.split('=');
    if (k && v) out[k.trim()] = v.trim();
  });
  return out;
}

const OPS = ['==', '!=', '>', '<', '>=', '<=', 'contains', 'isEmpty'];

export const NODE_TYPES: Record<string, NodeDefinition> = {
  /* ---------------- 트리거 ---------------- */
  manualTrigger: {
    title: '수동 트리거', icon: 'cursor', color: '#9a7b4f', category: '트리거',
    inputs: [], outputs: ['main'],
    defaults: { json: '{\n  "name": "world",\n  "count": 3\n}' },
    fields: [{ key: 'json', label: '시작 데이터 (JSON 객체 또는 배열)', type: 'textarea' }],
    summary: () => '수동 실행 시 데이터 발행',
    // 배열을 넣으면 여러 아이템이 흐른다
    run: async (_i, p) => ({ main: JSON.parse(p.json || '{}') }),
  },
  scheduleTrigger: {
    title: '스케줄 트리거', icon: 'clock', color: '#9a7b4f', category: '트리거', backend: true,
    inputs: [], outputs: ['main'],
    defaults: { interval: '매일 09:00', cron: '' },
    fields: [
      { key: 'interval', label: '실행 주기', type: 'select', options: ['매분', '10분마다', '매시', '매일 09:00', '매주 월요일', '직접 지정'] },
      { key: 'cron', label: '직접 지정할 때 — 분 시 일 월 요일 (예: 30 8 * * * = 매일 8시 30분, 0 9 * * 1-5 = 평일 9시)', type: 'text' },
    ],
    summary: (p) => (p.interval === '직접 지정' ? `주기: ${p.cron || '(비어 있음)'}` : `주기: ${p.interval}`),
    run: async (_i, p, ctx) => ({ main: { triggeredAt: ctx.$now, interval: p.interval === '직접 지정' ? p.cron : p.interval } }),
  },
  webhookTrigger: {
    title: 'Webhook 트리거', icon: 'globe', color: '#9a7b4f', category: '트리거', backend: true,
    inputs: [], outputs: ['main'],
    defaults: {
      path: '/hook/new-order',
      signature: 'none',
      secretCred: '',
      sample: '{\n  "event": "order.created",\n  "amount": 42000\n}',
    },
    fields: [
      { key: 'path', label: '경로 (서버 필요)', type: 'text' },
      { key: 'signature', label: 'HMAC 서명 검증', type: 'select', options: ['none', 'slack', 'github', 'stripe', 'generic'] },
      { key: 'secretCred', label: '시크릿 크리덴셜 이름 (type=webhook)', type: 'text' },
      { key: 'sample', label: '샘플 페이로드 (JSON)', type: 'textarea' },
    ],
    summary: (p) => `POST ${p.path}${p.signature && p.signature !== 'none' ? ` · ${p.signature} 검증` : ''}`,
    run: async (_i, p) => ({ main: JSON.parse(p.sample || '{}') }),
  },

  errorTrigger: {
    title: 'Error Trigger', icon: 'bolt', color: '#c0563f', category: '트리거', backend: true,
    inputs: [], outputs: ['main'],
    defaults: {
      sample: '{\n  "workflowName": "예시 워크플로",\n  "errorNode": "HTTP 요청",\n  "errorMessage": "fetch failed"\n}',
    },
    fields: [
      { key: 'sample', label: '샘플 에러 페이로드 (수동 실행 테스트용)', type: 'textarea' },
    ],
    summary: () => '다른 워크플로 실패 시 실행',
    // 실제 발동 시엔 서버가 에러 정보를 seed 로 주입한다. 수동 실행 시엔 샘플 사용.
    run: async (_i, p) => ({ main: JSON.parse(p.sample || '{}') }),
  },

  /* ---------------- 동작 ---------------- */
  httpRequest: {
    title: 'HTTP 요청', icon: 'globe', color: '#5f7fa3', category: '동작',
    sends: (p) => String(p.method || 'GET').toUpperCase() !== 'GET',     // GET 은 읽기, 나머지는 발송
    inputs: ['main'], outputs: ['main'],
    defaults: { method: 'GET', url: 'https://api.github.com/zen', body: '' },
    fields: [
      { key: 'method', label: '메서드', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'url', label: 'URL (표현식 지원)', type: 'text' },
      { key: 'body', label: '요청 본문 (JSON)', type: 'textarea' },
    ],
    summary: (p) => `${p.method} · ${p.url}`,
    run: async (_i, p) => {
      const opt: RequestInit = { method: p.method };
      if (p.method !== 'GET' && p.body) { opt.headers = { 'Content-Type': 'application/json' }; opt.body = p.body; }
      const res = await fetch(p.url, opt);
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      return { main: { status: res.status, data } };
    },
  },
  setFields: {
    title: '필드 설정 (Set)', icon: 'edit', color: '#4e8a7c', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { json: '{\n  "greeting": "Hello {{ $json.name }}"\n}' },
    fields: [{ key: 'json', label: '설정할 필드 (JSON · 표현식 지원)', type: 'textarea' }],
    summary: () => '필드를 병합/설정',
    run: async (i, p) => ({ main: { ...(i.main || {}), ...JSON.parse(p.json || '{}') } }),
  },
  code: {
    title: '코드 (JS)', icon: 'code', color: '#9c5f7d', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { code: '// input 사용, return 값이 출력\nreturn { ...input, doubled: (input.count || 0) * 2 };' },
    fields: [{ key: 'code', label: '함수 본문 — return 값이 출력', type: 'textarea' }],
    summary: () => 'JavaScript 실행',
    run: async (i, p) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function('input', p.code);
      return { main: await fn(i.main) };
    },
  },
  dateTime: {
    title: '날짜/시간', icon: 'clock', color: '#5f7fa3', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { field: 'timestamp', format: 'ISO' },
    fields: [
      { key: 'field', label: '저장할 필드명', type: 'text' },
      { key: 'format', label: '형식', type: 'select', options: ['ISO', '날짜', '시간', 'Unix(ms)'] },
    ],
    summary: (p) => `${p.field} = 현재시각(${p.format})`,
    run: async (i, p, ctx) => {
      const d = new Date(ctx.$now);
      const v = p.format === '날짜' ? d.toLocaleDateString()
        : p.format === '시간' ? d.toLocaleTimeString()
        : p.format === 'Unix(ms)' ? d.getTime()
        : d.toISOString();
      return { main: { ...(i.main || {}), [p.field]: v } };
    },
  },
  listText: {
    title: '목록을 글로', icon: 'list', color: '#4e8a7c', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { field: 'items', header: '', line: '• {title}', target: 'text' },
    fields: [
      { key: 'field', label: '목록 필드 경로 (예: items)', type: 'text' },
      { key: 'header', label: '첫 줄 (선택)', type: 'text' },
      { key: 'line', label: '항목마다 한 줄 — {필드경로} 로 값 넣기 (예: • {topic} — {headlines.0.title})', type: 'text' },
      { key: 'prefer', label: '이 낱말이 든 항목만 먼저 (쉼표, 선택)', type: 'text' },
      { key: 'max', label: '최대 줄 수 (0 = 전부)', type: 'text' },
      { key: 'noMatch', label: '맞는 항목이 없을 때 덧붙일 말 (선택)', type: 'text' },
      { key: 'target', label: '결과 저장 필드', type: 'text' },
    ],
    summary: (p) => `${p.field} → 글`,
    // LLM 없이 목록을 문장으로 — 들어온 값만 쓰므로 지어낼 자리가 없다. {…} 는 표현식({{ }})과 겹치지 않게 따로 쓴다
    run: async (i, p) => {
      const list = getPath(i.main, p.field);
      let arr = Array.isArray(list) ? list : [];
      let note = '';
      // 관심사 먼저 (specs/007) — 쉼표 낱말이 항목 어딘가에 있으면 그것만. 하나도 없으면 앞에서부터 + 안내
      const prefer = String(p.prefer || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (prefer.length) {
        const hit = arr.filter((it) => prefer.some((w) => JSON.stringify(it ?? '').toLowerCase().includes(w)));
        if (hit.length) arr = hit; else note = p.noMatch || '';
      }
      if (Number(p.max) > 0) arr = arr.slice(0, Number(p.max));
      const lines = arr.map((it) => String(p.line || '').replace(/\{([^{}]+)\}/g, (_m, path) => {
        const v = getPath(it, path.trim());
        return v === undefined || v === null ? '' : String(v);
      }).trim()).filter(Boolean);
      const text = [p.header, ...(lines.length ? lines : ['(항목 없음)']), note].filter(Boolean).join('\n');
      return { main: { ...(i.main || {}), [p.target || 'text']: text } };
    },
  },
  memoryDigest: {
    title: '기억 모아 보기 (검증된 사실)', icon: 'list', color: '#7c5cbf', category: 'AI', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { days: '7', target: 'text' },
    fields: [
      { key: 'days', label: '최근 며칠', type: 'select', options: ['1', '7', '30'] },
      { key: 'target', label: '결과 저장 필드', type: 'text' },
    ],
    summary: (p) => `최근 ${p.days}일 기억`,
    // 소크라테스식 읽기에서 인용 검증을 통과해 저장된 사실만 원문 그대로 모은다 (LLM 없음)
    run: async (i, p) => {
      const r = await callIntegration('memoryDigest', { days: Number(p.days) || 7, ownerId: p.owner || i.main?.ownerId || 'owner', lang: p.lang });
      return { main: { ...(i.main || {}), [p.target || 'text']: r.text, digest: r } };
    },
  },
  changeDetect: {
    title: '변경 감지 (지난번과 다르면)', icon: 'branch', color: '#b0813f', category: '흐름 제어', backend: true,
    inputs: ['main'], outputs: ['changed', 'same'],
    defaults: { key: 'page', field: 'data' },
    fields: [
      { key: 'key', label: '무엇을 지켜보나 (이름 — 같은 이름끼리 비교)', type: 'text' },
      { key: 'field', label: '비교할 필드 경로 (예: data)', type: 'text' },
    ],
    summary: (p) => `${p.key} 이 바뀌면`,
    // 지난 값의 해시를 서버에 저장한다. 처음 보는 값은 기준으로만 저장하고 same 으로 보낸다 (켜자마자 알림이 가지 않도록)
    run: async (i, p) => {
      const r = await callIntegration('changeDetect', { key: p.key, value: getPath(i.main, p.field) });
      const item = { ...(i.main || {}), change: r };
      return r.changed ? { changed: item, same: undefined } : { changed: undefined, same: item };
    },
  },
  hash: {
    title: '해시', icon: 'key', color: '#8b8579', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { field: 'name', target: 'hash' },
    fields: [
      { key: 'field', label: '해시할 필드 경로', type: 'text' },
      { key: 'target', label: '결과 저장 필드', type: 'text' },
    ],
    summary: (p) => `hash(${p.field}) → ${p.target}`,
    run: async (i, p) => ({ main: { ...(i.main || {}), [p.target]: simpleHash(String(getPath(i.main, p.field))) } }),
  },
  renameKey: {
    title: '키 이름 변경', icon: 'edit', color: '#4e8a7c', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { from: 'name', to: 'title' },
    fields: [
      { key: 'from', label: '기존 키', type: 'text' },
      { key: 'to', label: '새 키', type: 'text' },
    ],
    summary: (p) => `${p.from} → ${p.to}`,
    run: async (i, p) => {
      const obj = { ...(i.main || {}) };
      if (p.from in obj) { obj[p.to] = obj[p.from]; delete obj[p.from]; }
      return { main: obj };
    },
  },
  delay: {
    title: '대기 (Wait)', icon: 'clock', color: '#8b8579', category: '동작',
    inputs: ['main'], outputs: ['main'],
    defaults: { ms: '800' },
    fields: [{ key: 'ms', label: '대기 시간 (밀리초)', type: 'text' }],
    summary: (p) => `${p.ms}ms 대기`,
    run: async (i, p) => { await sleep(Number(p.ms) || 0); return { main: i.main }; },
  },

  /* ---------------- 흐름 제어 ---------------- */
  ifNode: {
    title: 'IF 조건', icon: 'branch', color: '#b0813f', category: '흐름 제어',
    inputs: ['main'], outputs: ['true', 'false'],
    defaults: { field: 'count', op: '>', value: '1' },
    fields: [
      { key: 'field', label: '필드 경로', type: 'text' },
      { key: 'op', label: '비교', type: 'select', options: OPS },
      { key: 'value', label: '값', type: 'text' },
    ],
    summary: (p) => `${p.field} ${p.op} ${p.value}`,
    run: async (i, p) => {
      const ok = compare(getPath(i.main, p.field), p.op, p.value);
      return ok ? { true: i.main, false: undefined } : { true: undefined, false: i.main };
    },
  },
  switchNode: {
    title: 'Switch (다중분기)', icon: 'branch', color: '#b0813f', category: '흐름 제어',
    inputs: ['main'], outputs: ['1', '2', '3', '기타'],
    defaults: { field: 'status', v1: 'A', v2: 'B', v3: 'C' },
    fields: [
      { key: 'field', label: '분기 기준 필드', type: 'text' },
      { key: 'v1', label: '출력1 값', type: 'text' },
      { key: 'v2', label: '출력2 값', type: 'text' },
      { key: 'v3', label: '출력3 값', type: 'text' },
    ],
    summary: (p) => `${p.field} → ${p.v1}/${p.v2}/${p.v3}`,
    run: async (i, p) => {
      const val = String(getPath(i.main, p.field));
      const out: Record<string, unknown> = { 1: undefined, 2: undefined, 3: undefined, 기타: undefined };
      if (val === p.v1) out['1'] = i.main;
      else if (val === p.v2) out['2'] = i.main;
      else if (val === p.v3) out['3'] = i.main;
      else out['기타'] = i.main;
      return out;
    },
  },
  filter: {
    title: '필터', icon: 'branch', color: '#b0813f', category: '흐름 제어',
    inputs: ['main'], outputs: ['main'],
    defaults: { field: 'count', op: '>', value: '0' },
    fields: [
      { key: 'field', label: '필드 경로', type: 'text' },
      { key: 'op', label: '비교', type: 'select', options: OPS },
      { key: 'value', label: '값', type: 'text' },
    ],
    summary: (p) => `통과: ${p.field} ${p.op} ${p.value}`,
    run: async (i, p) => ({ main: compare(getPath(i.main, p.field), p.op, p.value) ? i.main : undefined }),
  },
  merge: {
    title: '병합 (Merge)', icon: 'flow', color: '#8b8579', category: '흐름 제어',
    mode: 'batch',
    inputs: ['input1', 'input2'], outputs: ['main'],
    defaults: { strategy: 'append' },
    fields: [{ key: 'strategy', label: '병합 방식', type: 'select', options: ['append', 'combine(인덱스별 병합)'] }],
    summary: (p) => (p.strategy?.startsWith('combine') ? '인덱스별 필드 병합' : '두 입력 이어붙이기'),
    run: async (i, p) => {
      const a = i.input1 || [];
      const b = i.input2 || [];
      if (p.strategy?.startsWith('combine')) {
        const n = Math.max(a.length, b.length);
        return { main: Array.from({ length: n }, (_, k) => ({ ...(a[k] || {}), ...(b[k] || {}) })) };
      }
      return { main: [...a, ...b] };
    },
  },

  /* ---------------- 배열/아이템 처리 ---------------- */
  splitOut: {
    title: '배열 분해 (Split Out)', icon: 'list', color: '#4e8a7c', category: '배열',
    inputs: ['main'], outputs: ['main'],
    defaults: { fieldToSplitOut: 'items', include: 'selected', includeFields: '' },
    fields: [
      { key: 'fieldToSplitOut', label: '분해할 배열 필드 (dot 경로)', type: 'text' },
      { key: 'include', label: '부모 필드 포함', type: 'select', options: ['none', 'selected', 'all'] },
      { key: 'includeFields', label: '포함할 부모 필드 (쉼표, selected일 때)', type: 'text' },
    ],
    summary: (p) => `${p.fieldToSplitOut} → 아이템들`,
    run: async (i, p) => {
      const parent = i.main || {};
      const arr = toItems(getPath(parent, p.fieldToSplitOut));
      let base: Item = {};
      if (p.include === 'all') {
        base = { ...parent };
        delete base[String(p.fieldToSplitOut).split('.')[0]];
      } else if (p.include === 'selected' && p.includeFields) {
        for (const f of String(p.includeFields).split(',').map((s) => s.trim()).filter(Boolean)) {
          base[f.split('.').pop() ?? f] = getPath(parent, f);
        }
      }
      return { main: arr.map((el) => (el && typeof el === 'object' ? { ...base, ...(el as Item) } : { ...base, value: el })) };
    },
  },
  aggregate: {
    title: '집계 (Aggregate)', icon: 'flow', color: '#4e8a7c', category: '배열',
    mode: 'batch',
    inputs: ['main'], outputs: ['main'],
    defaults: { operation: 'toArray', field: '', target: 'items' },
    fields: [
      { key: 'operation', label: '연산', type: 'select', options: ['toArray', 'sum', 'avg', 'min', 'max', 'count', 'concat'] },
      { key: 'field', label: '대상 필드 (toArray/count 제외)', type: 'text' },
      { key: 'target', label: '결과 필드명', type: 'text' },
    ],
    summary: (p) => `${p.operation}(${p.field || '*'}) → ${p.target}`,
    run: async (i, p) => {
      const items: Item[] = i.main || [];
      const nums = () => items.map((it) => Number(getPath(it, p.field))).filter((n) => Number.isFinite(n));
      let value: unknown;
      switch (p.operation) {
        case 'sum': value = nums().reduce((a, b) => a + b, 0); break;
        case 'avg': { const n = nums(); value = n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0; break; }
        case 'min': value = Math.min(...nums()); break;
        case 'max': value = Math.max(...nums()); break;
        case 'count': value = items.length; break;
        case 'concat': value = items.map((it) => String(getPath(it, p.field) ?? '')).join(', '); break;
        default: value = items;
      }
      return { main: { [p.target || 'result']: value, _count: items.length } };
    },
  },
  limit: {
    title: '개수 제한 (Limit)', icon: 'list', color: '#8b8579', category: '배열',
    mode: 'batch',
    inputs: ['main'], outputs: ['main'],
    defaults: { maxItems: '10', keep: 'first' },
    fields: [
      { key: 'maxItems', label: '최대 개수', type: 'text' },
      { key: 'keep', label: '유지 위치', type: 'select', options: ['first', 'last'] },
    ],
    summary: (p) => `${p.keep} ${p.maxItems}건`,
    run: async (i, p) => {
      const items = i.main || [];
      const n = Math.max(0, Number(p.maxItems) || 0);
      return { main: p.keep === 'last' ? items.slice(-n) : items.slice(0, n) };
    },
  },
  sortItems: {
    title: '정렬 (Sort)', icon: 'list', color: '#8b8579', category: '배열',
    mode: 'batch',
    inputs: ['main'], outputs: ['main'],
    defaults: { field: 'name', order: 'asc', type: 'auto' },
    fields: [
      { key: 'field', label: '정렬 기준 필드', type: 'text' },
      { key: 'order', label: '순서', type: 'select', options: ['asc', 'desc'] },
      { key: 'type', label: '비교 타입', type: 'select', options: ['auto', 'number', 'string'] },
    ],
    summary: (p) => `${p.field} ${p.order}`,
    run: async (i, p) => {
      const items: Item[] = [...(i.main || [])];
      const dir = p.order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = getPath(a, p.field);
        const bv = getPath(b, p.field);
        const asNum = p.type === 'number' || (p.type === 'auto' && Number.isFinite(Number(av)) && Number.isFinite(Number(bv)));
        if (asNum) return (Number(av) - Number(bv)) * dir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
      });
      return { main: items };
    },
  },
  removeDuplicates: {
    title: '중복 제거', icon: 'list', color: '#8b8579', category: '배열',
    mode: 'batch',
    inputs: ['main'], outputs: ['main'],
    defaults: { field: '' },
    fields: [{ key: 'field', label: '기준 필드 (비우면 아이템 전체 비교)', type: 'text' }],
    summary: (p) => (p.field ? `${p.field} 기준` : '전체 비교'),
    run: async (i, p) => {
      const seen = new Set<string>();
      const out: Item[] = [];
      for (const it of i.main || []) {
        const key = p.field ? stableKey(getPath(it, p.field)) : stableKey(it);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
      return { main: out };
    },
  },
  ocr: {
    title: 'OCR (이미지 → 텍스트)', icon: 'globe', color: '#1a7f5a', category: 'AI', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { image: '{{ $json.image }}', engine: 'auto', lang: 'kor+eng', minConfidence: '60' },
    fields: [
      { key: 'image', label: '이미지 — 파일 경로 · data:URL · base64', type: 'text' },
      { key: 'engine', label: '엔진 — auto: Paddle 서버가 있으면 Paddle(실측 97%), 없으면 tesseract(67%)', type: 'select', options: ['auto', 'paddle', 'ensemble', 'tesseract'] },
      { key: 'lang', label: '언어 (tesseract)', type: 'select', options: ['kor+eng', 'kor', 'eng', 'jpn', 'chi_sim'] },
      { key: 'minConfidence', label: '최소 신뢰도 (0~100, tesseract) — 낮은 단어는 버린다', type: 'text' },
    ],
    summary: (p) => `OCR ${p.engine || 'auto'} · ${p.lang}`,
    // Paddle 서버(server/ocr/paddle_ocr_server.py)가 없으면 tesseract.js — 오프라인, API 키 불필요
    run: async (i, p) => {
      const r = await callIntegration('ocr', { image: p.image, engine: p.engine || 'auto', lang: p.lang, minConfidence: p.minConfidence });
      return { main: { ...(i.main || {}), ocr: r } };
    },
  },
  plateRecognize: {
    title: '번호판 인식 (YOLO11+PaddleOCR)', icon: 'globe', color: '#1a7f5a', category: 'AI', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { image: '{{ $json.image }}', baseUrl: '', minConfidence: '0.5', timeoutMs: '30000' },
    fields: [
      { key: 'image', label: '이미지 — 파일 경로 · data:URL · base64', type: 'text' },
      { key: 'baseUrl', label: '번호판 서버 주소 (비우면 http://localhost:5000)', type: 'text' },
      { key: 'minConfidence', label: '최소 신뢰도 (0~1)', type: 'text' },
      { key: 'timeoutMs', label: '타임아웃 (ms)', type: 'text' },
    ],
    summary: (p) => `번호판 인식 (신뢰도 ≥ ${p.minConfidence || 0})`,
    // 외부 yolo11 FastAPI 서버 호출. 서버가 없으면 시뮬레이션으로 떨어진다.
    run: async (i, p) => {
      const r = await callIntegration('plateRecognize', {
        image: p.image, baseUrl: p.baseUrl,
        minConfidence: p.minConfidence, timeoutMs: p.timeoutMs,
      });
      return { main: { ...(i.main || {}), plates: r } };
    },
  },
  screenUnderstand: {
    title: '화면 이해 (무슨 기능인지)', icon: 'sparkles', color: '#7c5cbf', category: 'AI', backend: true, llm: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { image: '{{ $json.image }}', lang: 'kor+eng', hint: '', withOcr: 'true' },
    fields: [
      { key: 'image', label: '이미지 — 파일 경로 · data:URL · base64', type: 'text' },
      { key: 'hint', label: '참고 설명 (선택) — 무엇을 찾는지', type: 'textarea' },
      { key: 'lang', label: 'OCR 언어', type: 'select', options: ['kor+eng', 'kor', 'eng', 'jpn', 'chi_sim'] },
      { key: 'withOcr', label: 'OCR 텍스트를 함께 전달 (작은 글씨 인식률↑)', type: 'select', options: ['true', 'false'] },
    ],
    summary: () => '화면을 보고 기능·동작을 구조화',
    // OCR 텍스트 + 이미지를 Claude vision 에 함께 넘겨 JSON 으로 받는다
    run: async (i, p) => {
      const r = await callIntegration('screenUnderstand', {
        image: p.image, lang: p.lang, hint: p.hint, withOcr: p.withOcr !== 'false',
      });
      return { main: { ...(i.main || {}), screen: r } };
    },
  },
  socraticRead: {
    title: '소크라테스식 읽기 (검증된 이해)', icon: 'sparkles', color: '#7c5cbf', category: 'AI', backend: true, llm: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { image: '{{ $json.image }}', text: '', focus: '', title: '', engine: 'auto', lang: 'kor+eng', rounds: '2', learn: 'true', memory: 'true', model: 'claude-sonnet-5' },
    fields: [
      { key: 'image', label: '이미지 — 파일 경로 · data:URL · base64 (비우면 텍스트를 읽는다)', type: 'text' },
      { key: 'text', label: '텍스트 (이미지가 없을 때)', type: 'textarea' },
      { key: 'focus', label: '특히 알고 싶은 것 (선택)', type: 'text' },
      { key: 'title', label: '제목 (기억에 출처로 남는다, 선택)', type: 'text' },
      { key: 'engine', label: 'OCR 엔진', type: 'select', options: ['auto', 'paddle', 'ensemble', 'tesseract'] },
      { key: 'lang', label: 'OCR 언어 (tesseract)', type: 'select', options: ['kor+eng', 'kor', 'eng', 'jpn', 'chi_sim'] },
      { key: 'rounds', label: '논박 라운드 — 반박된 답을 다시 묻는 횟수 포함', type: 'select', options: ['1', '2', '3', '4'] },
      { key: 'learn', label: '실수에서 배우기 (다음 읽기에 반영)', type: 'select', options: ['true', 'false'] },
      { key: 'memory', label: '장기 기억 — 전에 읽은 것과 연결하고, 검증된 것만 기억한다', type: 'select', options: ['true', 'false'] },
      { key: 'model', label: '모델', type: 'select', options: AI_MODELS },
    ],
    summary: (p) => `스스로 묻고 원문으로 검증 · ${p.rounds || 2}라운드`,
    // 답은 LLM 이, 인용 대조는 코드가 한다 — 원문에 없는 인용으로 만든 답은 이해에 들어가지 않는다
    run: async (i, p) => {
      const r = await callIntegration('socraticRead', {
        image: p.image, text: p.text, focus: p.focus, engine: p.engine || 'auto', lang: p.lang,
        rounds: Number(p.rounds) || 2, learn: p.learn !== 'false', memory: p.memory !== 'false', title: p.title, model: p.model,
        ownerId: i.main?.ownerId || 'owner', // 누구의 기억인가 — 받은 파일은 보낸 사람 것 (코드가 정한다, specs/007)
      });
      return { main: { ...(i.main || {}), reading: r } };
    },
  },
  stopError: {
    title: '중단 & 오류', icon: 'close', color: '#c0563f', category: '흐름 제어',
    inputs: ['main'], outputs: [],
    defaults: { message: '워크플로 중단됨' },
    fields: [{ key: 'message', label: '오류 메시지', type: 'text' }],
    summary: (p) => p.message,
    run: async (_i, p) => { throw new Error(p.message || '중단'); },
  },

  memoryRecall: {
    title: '기억 검색 (검증된 읽기 기억)', icon: 'search', color: '#7c5cbf', category: 'AI', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { query: '{{ $json.query }}', k: '5', types: 'source,fact' },
    fields: [
      { key: 'query', label: '찾을 내용 (표현식 지원)', type: 'text' },
      { key: 'k', label: '최대 개수', type: 'select', options: ['1', '3', '5', '10'] },
      { key: 'types', label: '종류 — source(원문 조각) · fact(검증된 사실)', type: 'select', options: ['source,fact', 'fact', 'source'] },
    ],
    summary: (p) => `기억 검색 · 최대 ${p.k || 5}개`,
    // 문턱을 못 넘으면 빈 결과 — 관련 없는 기억을 억지로 붙이지 않는다
    run: async (i, p) => {
      const r = await callIntegration('memoryRecall', { query: p.query, ownerId: i.main?.ownerId || 'owner', k: Number(p.k) || 5, types: String(p.types || '').split(',').map((t) => t.trim()).filter(Boolean) });
      return { main: { ...(i.main || {}), memory: r } };
    },
  },
  approvalRequest: {
    title: '사람 승인 대기', icon: 'check', color: '#b5651d', category: '흐름 제어', backend: true,
    inputs: ['main'], outputs: ['approved', 'rejected', 'expired'],
    defaults: {
      channel: 'telegram',
      chatId: '',
      title: '승인 요청: {{ $json.name }}',
      text: '{{ $json.draft }}',
      remindAfterMin: 60,
      expireAfterMin: 1440,
    },
    fields: [
      { key: 'channel', label: '승인 채널', type: 'select', options: ['telegram'] },
      { key: 'chatId', label: '채팅 ID (비우면 TELEGRAM_CHAT_ID)', type: 'text' },
      { key: 'title', label: '제목 (표현식 지원)', type: 'text' },
      { key: 'text', label: '승인받을 내용 (표현식 지원)', type: 'textarea' },
      { key: 'remindAfterMin', label: '리마인드까지 (분)', type: 'text' },
      { key: 'expireAfterMin', label: '만료까지 (분) — 지나면 expired 포트로 흐름', type: 'text' },
    ],
    summary: (p) => `${p.channel} 승인 · 만료 ${p.expireAfterMin}분`,
    // 서버: 스냅샷을 저장하고 메시지를 보낸 뒤 { __wait } 로 멈춘다. 결정이 오면 서버가 seed 로 재개한다.
    // 브라우저(브리지 없음): 대기 상태로만 표시하고 통과시키지 않는다.
    run: async (i, p, ctx) => {
      const item = i.main || {};
      const r = await callIntegration('approval', {
        channel: p.channel, chatId: p.chatId, title: p.title, text: p.text,
        remindAfterMin: p.remindAfterMin, expireAfterMin: p.expireAfterMin, item,
        _ctx: { results: ctx?.$results, flow: ctx?.$flow, meta: ctx?.$meta, nodeId: ctx?.$nodeId },
      });
      if (r?.waiting) return { __wait: { approvalId: r.approvalId, channel: r.channel } };
      // 브라우저(브리지 없음): 승인 없이 아래로 흘리지 않는다 — 캔버스 '실행'에서도 HTTP·코드 노드는 진짜로 돌기 때문
      if (r?.simulated) return { __wait: { approvalId: null, simulated: true, note: r.note } };
      if (r?.error) throw new Error(r.error);
      throw new Error('승인 요청 결과를 해석할 수 없습니다');
    },
  },

  /* ---------------- 연동 (실제 API · 서버 실행 + 크리덴셜 필요) ---------------- */
  slack: {
    title: 'Slack 메시지', icon: 'output', color: '#611f69', category: '연동', backend: true, sends: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { credential: '', channel: '#general', text: '{{ $json.name }} 이벤트 발생' },
    fields: [
      { key: 'credential', label: 'Slack 크리덴셜 이름 (비우면 첫 번째)', type: 'text' },
      { key: 'channel', label: '채널 (#general 또는 ID)', type: 'text' },
      { key: 'text', label: '메시지 (표현식 지원)', type: 'textarea' },
    ],
    summary: (p) => `Slack ${p.channel}`,
    run: async (i, p) => {
      const r = await callIntegration('slack', { credential: p.credential, channel: p.channel, text: p.text });
      return { main: { ...(i.main || {}), slack: r } };
    },
  },
  telegram: {
    title: '텔레그램 메시지', icon: 'output', color: '#2aabee', category: '연동', backend: true, sends: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { chatId: '', text: '{{ $json.name }} 이벤트 발생' },
    fields: [
      { key: 'chatId', label: '채팅 ID (비우면 TELEGRAM_CHAT_ID)', type: 'text' },
      { key: 'text', label: '메시지 (표현식 지원)', type: 'textarea' },
    ],
    summary: (p) => `텔레그램 ${p.chatId || '(기본 채팅)'}`,
    run: async (i, p) => {
      const r = await callIntegration('telegram', { chatId: p.chatId, text: p.text });
      if (r?.ok === false) throw new Error(`텔레그램 전송 실패: ${r.error}`);
      return { main: { ...(i.main || {}), telegram: r } };
    },
  },
  gmail: {
    title: 'Gmail 보내기', icon: 'output', color: '#c5221f', category: '연동', backend: true, sends: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { credential: '', to: 'user@example.com', subject: '알림: {{ $json.name }}', text: '본문을 입력하세요' },
    fields: [
      { key: 'credential', label: 'Gmail 크리덴셜 이름 (비우면 첫 번째)', type: 'text' },
      { key: 'to', label: '받는 사람', type: 'text' },
      { key: 'subject', label: '제목 (표현식 지원)', type: 'text' },
      { key: 'text', label: '본문 (표현식 지원)', type: 'textarea' },
    ],
    summary: (p) => `Gmail → ${p.to}`,
    run: async (i, p) => {
      const r = await callIntegration('gmail', { credential: p.credential, to: p.to, subject: p.subject, text: p.text });
      return { main: { ...(i.main || {}), gmail: r } };
    },
  },
  notion: {
    title: 'Notion 페이지 생성', icon: 'edit', color: '#111111', category: '연동', backend: true, sends: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { credential: '', databaseId: '', titleProp: 'Name', title: '{{ $json.name }}', content: '' },
    fields: [
      { key: 'credential', label: 'Notion 크리덴셜 이름 (비우면 첫 번째)', type: 'text' },
      { key: 'databaseId', label: '데이터베이스 ID', type: 'text' },
      { key: 'titleProp', label: '제목 속성 이름 (보통 Name)', type: 'text' },
      { key: 'title', label: '제목 (표현식 지원)', type: 'text' },
      { key: 'content', label: '본문 (선택)', type: 'textarea' },
    ],
    summary: (p) => `Notion ▸ ${p.title}`,
    run: async (i, p) => {
      const r = await callIntegration('notion', {
        credential: p.credential, databaseId: p.databaseId, titleProp: p.titleProp, title: p.title, content: p.content,
      });
      return { main: { ...(i.main || {}), notion: r } };
    },
  },
  youtube: {
    title: 'YouTube 검색', icon: 'globe', color: '#ff0000', category: '연동', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { credential: '', query: '{{ $json.topic }}', maxResults: '5' },
    fields: [
      { key: 'credential', label: 'YouTube 크리덴셜 이름 (비우면 첫 번째)', type: 'text' },
      { key: 'query', label: '검색어 (표현식 지원)', type: 'text' },
      { key: 'maxResults', label: '개수', type: 'select', options: ['3', '5', '10'] },
    ],
    summary: (p) => `YouTube: ${p.query}`,
    run: async (i, p) => {
      const r = await callIntegration('youtube', { credential: p.credential, query: p.query, maxResults: Number(p.maxResults) || 5 });
      return { main: { ...(i.main || {}), youtube: r } };
    },
  },
  naver: {
    title: 'Naver 검색', icon: 'globe', color: '#03c75a', category: '연동', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { credential: '', type: 'news', query: '{{ $json.topic }}', display: '5' },
    fields: [
      { key: 'credential', label: 'Naver 크리덴셜 이름 (비우면 첫 번째)', type: 'text' },
      { key: 'type', label: '검색 종류', type: 'select', options: ['news', 'blog', 'shop', 'webkr', 'image'] },
      { key: 'query', label: '검색어 (표현식 지원)', type: 'text' },
      { key: 'display', label: '개수', type: 'select', options: ['3', '5', '10'] },
    ],
    summary: (p) => `Naver(${p.type}): ${p.query}`,
    run: async (i, p) => {
      const r = await callIntegration('naver', { credential: p.credential, type: p.type, query: p.query, display: Number(p.display) || 5 });
      return { main: { ...(i.main || {}), naver: r } };
    },
  },
  hotTopics: {
    title: '핫이슈 수집 (Google 트렌드)', icon: 'globe', color: '#1a7f5a', category: '연동', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { region: 'KR', limit: '1', minTraffic: '100', koreanOnly: 'true', skipDays: '7' },
    fields: [
      { key: 'region', label: '지역 코드 (KR·US·JP…)', type: 'text' },
      { key: 'limit', label: '가져올 주제 수 — 주제마다 아이템 하나로 흐른다', type: 'select', options: ['1', '2', '3', '5'] },
      { key: 'minTraffic', label: '최소 검색량 (예: 100)', type: 'text' },
      { key: 'koreanOnly', label: '한글 주제만', type: 'select', options: ['true', 'false'] },
      { key: 'skipDays', label: '최근 N일 안에 쓴 주제 제외', type: 'text' },
    ],
    summary: (p) => `트렌드 ${p.region} 상위 ${p.limit}`,
    // 결과가 배열이면 엔진이 아이템 여러 개로 흘려보낸다 (주제 하나 = 아이템 하나)
    run: async (_i, p) => ({
      main: await callIntegration('hotTopics', {
        region: p.region, limit: Number(p.limit) || 1, minTraffic: Number(p.minTraffic) || 0,
        koreanOnly: p.koreanOnly !== 'false', skipDays: Number(p.skipDays) || 0,
      }),
    }),
  },
  mcpTool: {
    title: 'MCP 도구 호출', icon: 'bolt', color: '#7c5cbf', category: '연동', backend: true,
    sends: (p) => !!p.tool,                                                 // 도구 이름이 없으면 목록 조회 = 읽기
    inputs: ['main'], outputs: ['main'],
    defaults: { credential: '', tool: '', args: '{\n}' },
    fields: [
      { key: 'credential', label: 'MCP 서버 크리덴셜 이름 (type=mcp, 비우면 첫 번째)', type: 'text' },
      { key: 'tool', label: '도구 이름 (비우면 도구 목록 조회)', type: 'text' },
      { key: 'args', label: '인자 (JSON · 표현식 지원)', type: 'textarea' },
    ],
    summary: (p) => (p.tool ? `MCP · ${p.tool}` : 'MCP 도구 목록 조회'),
    run: async (i, p) => {
      const r = await callIntegration('mcp', { credential: p.credential, tool: p.tool, args: p.args });
      return { main: { ...(i.main || {}), mcp: r } };
    },
  },
  httpAuth: {
    title: 'HTTP 요청 (인증)', icon: 'key', color: '#5f7fa3', category: '연동', backend: true,
    sends: (p) => String(p.method || 'GET').toUpperCase() !== 'GET',
    inputs: ['main'], outputs: ['main'],
    defaults: {
      credential: '', authType: 'bearer', method: 'GET',
      url: 'https://api.github.com/user', headers: '', body: '',
    },
    fields: [
      { key: 'authType', label: '인증 방식', type: 'select', options: ['none', 'bearer', 'header', 'basic'] },
      { key: 'credential', label: '크리덴셜 이름 (type=httpAuth, 비우면 첫 번째)', type: 'text' },
      { key: 'method', label: '메서드', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'url', label: 'URL (표현식 지원)', type: 'text' },
      { key: 'headers', label: '추가 헤더 (JSON, 선택)', type: 'textarea' },
      { key: 'body', label: '요청 본문 (JSON, 선택)', type: 'textarea' },
    ],
    summary: (p) => `${p.method} ${p.url}`,
    run: async (i, p) => {
      const r = await callIntegration('http', {
        credential: p.credential, authType: p.authType, method: p.method,
        url: p.url, headers: p.headers, body: p.body,
      });
      return { main: { ...(i.main || {}), response: r } };
    },
  },

  /* ---------------- AI (n8n이 불편한 것들 · 서버 실행 권장) ---------------- */
  ai: {
    title: 'AI · Claude', icon: 'spark', color: '#cc785c', category: 'AI', backend: true, llm: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      model: 'claude-sonnet-5',
      system: '너는 간결하고 정확한 어시스턴트다.',
      prompt: '다음 데이터를 한 문장으로 요약해줘: {{ $json }}',
    },
    fields: [
      { key: 'model', label: '모델', type: 'select', options: AI_MODELS },
      { key: 'system', label: '시스템 프롬프트', type: 'textarea' },
      { key: 'prompt', label: '프롬프트 (표현식 지원)', type: 'textarea' },
    ],
    summary: (p) => `${p.model} 프롬프트`,
    run: async (i, p) => {
      const r = await callLLM({ system: p.system, prompt: p.prompt, model: p.model });
      return { main: { ...(i.main || {}), aiText: r.text, _ai: { model: r.model || p.model, provider: r.provider, simulated: !!r.simulated, usage: r.usage } } };
    },
  },
  aiExtract: {
    title: 'AI 구조화 추출', icon: 'spark', color: '#cc785c', category: 'AI', backend: true, llm: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { model: 'claude-sonnet-5', instruction: '이름과 금액을 추출해 JSON으로', target: 'extracted' },
    fields: [
      { key: 'model', label: '모델', type: 'select', options: AI_MODELS },
      { key: 'instruction', label: '추출 지시', type: 'textarea' },
      { key: 'target', label: '저장 필드', type: 'text' },
    ],
    summary: (p) => `→ ${p.target}`,
    run: async (i, p) => {
      const r = await callLLM({
        system: '오직 유효한 JSON만 출력한다. 설명 금지.',
        prompt: `${p.instruction}\n\n입력:\n${JSON.stringify(i.main)}`,
        model: p.model,
      });
      let parsed;
      try { parsed = JSON.parse(r.text); } catch { parsed = { raw: r.text }; }
      return { main: { ...(i.main || {}), [p.target]: parsed, _ai: { model: r.model || p.model, provider: r.provider, simulated: !!r.simulated, usage: r.usage } } };
    },
  },
  aiAgent: {
    title: 'AI 에이전트 (도구 사용)', icon: 'bolt', color: '#cc785c', category: 'AI', backend: true, llm: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      model: 'claude-sonnet-5',
      system: '너는 도구를 활용해 스스로 목표를 달성하는 에이전트다. 필요하면 도구를 호출하고, 끝나면 결과를 요약하라.',
      task: '{{ $json }} 을 바탕으로 목표를 수행하라.',
      tools: 'run_code, http_get',
      toolCreds: '',
      maxSteps: '4',
    },
    fields: [
      { key: 'model', label: '모델', type: 'select', options: AI_MODELS },
      { key: 'system', label: '시스템 프롬프트', type: 'textarea' },
      { key: 'task', label: '작업 (표현식 지원)', type: 'textarea' },
      { key: 'tools', label: `도구 (쉼표구분: ${AGENT_TOOLS.join(', ')})`, type: 'text' },
      { key: 'toolCreds', label: '도구 크리덴셜 (선택 · 예: slack=내슬랙, notion=업무, http=깃허브)', type: 'text' },
      { key: 'maxSteps', label: '최대 스텝', type: 'select', options: ['2', '4', '6', '8'] },
    ],
    summary: (p) => `도구: ${p.tools || '기본'}`,
    run: async (i, p, ctx) => {
      const toolNames = String(p.tools || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => AGENT_TOOLS.includes(s));
      const r = await callAgent({
        system: p.system,
        task: p.task,
        model: p.model,
        maxSteps: Number(p.maxSteps) || 4,
        toolNames,
        creds: parseCreds(p.toolCreds),
        onStep: ctx?.onAgentStep ? (step: unknown) => ctx.onAgentStep!(step) : undefined,
      });
      return {
        main: {
          ...(i.main || {}),
          agentResult: r.text,
          toolCalls: r.steps || [],
          _ai: { simulated: !!r.simulated, error: r.error },
        },
      };
    },
  },
  loopRefine: {
    title: '루프 엔지니어링', icon: 'flow', color: '#cc785c', category: 'AI', backend: true, llm: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      model: 'claude-sonnet-5',
      prompt: '{{ $json }} 에 대한 초안을 작성하라.',
      criterion: '더 정확하고 간결하게',
      iterations: '3',
    },
    fields: [
      { key: 'model', label: '모델', type: 'select', options: AI_MODELS },
      { key: 'prompt', label: '초기 프롬프트 (표현식 지원)', type: 'textarea' },
      { key: 'criterion', label: '개선 기준', type: 'text' },
      { key: 'iterations', label: '반복 횟수', type: 'select', options: ['1', '2', '3', '4', '5'] },
    ],
    summary: (p) => `${p.iterations}회 반복 개선`,
    run: async (i, p) => {
      const iters = Math.min(5, Math.max(1, Number(p.iterations) || 3));
      let out = '';
      const history: string[] = [];
      for (let k = 0; k < iters; k++) {
        const instr = k === 0 ? p.prompt : `다음 결과를 "${p.criterion}" 기준으로 개선하라:\n${out}`;
        const r = await callLLM({ prompt: instr, model: p.model });
        out = r.text;
        history.push(out);
      }
      return { main: { ...(i.main || {}), refined: out, passes: history.length } };
    },
  },

  /* ---------------- 영상 (로컬 Remotion 렌더 · 실제 MP4 생산) ---------------- */
  output: {
    title: '출력', icon: 'output', color: '#6d8b58', category: '출력',
    inputs: ['main'], outputs: [],
    defaults: {},
    fields: [],
    summary: () => '최종 결과 표시',
    run: async (i) => ({ main: i.main }),
  },
  noOp: {
    title: 'No-Op', icon: 'output', color: '#8b8579', category: '출력',
    inputs: ['main'], outputs: ['main'],
    defaults: {},
    fields: [],
    summary: () => '통과 (디버그용)',
    run: async (i) => ({ main: i.main }),
  },
};

// 카테고리 자동 구성 (등록 순서 유지)
export const PALETTE_GROUPS = (() => {
  const order = ['트리거', 'AI', '동작', '배열', '흐름 제어', '연동', '영상', '수익화', '출력'];
  const map: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(NODE_TYPES)) {
    (map[v.category] ||= []).push(k);
  }
  return order.filter((c) => map[c]).map((c) => ({ name: c, items: map[c] }));
})();

// 출력 맵에서 아이템 개수 (뱃지용) — 모든 포트 합산
export function itemCount(output: Record<string, unknown> | undefined | null): number {
  if (!output) return 0;
  const v = output.main ?? output.true ?? output.false ?? Object.values(output).find((x) => x !== undefined);
  return toItems(v).length;
}

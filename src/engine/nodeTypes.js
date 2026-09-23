// ============================================================
// 노드 타입 레지스트리 (확장판)
//   run(inputs, params, ctx) — params 는 실행 엔진이 표현식을 이미 해석해서 전달
//   inputs.<port> = 이전 노드의 출력 객체 (없으면 undefined)
//   반환: { <outputPort>: value }  (value 가 undefined 면 그 경로는 흐르지 않음)
// backend:true 인 노드는 실제 연동에 서버가 필요 → 지금은 시뮬레이션 결과를 낸다.
// ============================================================

import { toItems, stableKey } from './items.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const getPath = (obj, path) =>
  String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);

function compare(a, op, b) {
  switch (op) {
    case '==': return String(a) === String(b);
    case '!=': return String(a) !== String(b);
    case '>': return Number(a) > Number(b);
    case '<': return Number(a) < Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<=': return Number(a) <= Number(b);
    case 'contains': return String(a).includes(b);
    case 'isEmpty': return a === undefined || a === null || a === '';
    default: return false;
  }
}

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

// LLM 브리지: 서버가 globalThis.__conduitLLM 을 주입하면 실제 Claude 호출,
// 브라우저(주입 없음)에서는 시뮬레이션 결과를 낸다.
async function callLLM({ system, prompt, model, messages }) {
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
async function callIntegration(name, args) {
  const bridge = globalThis.__conduitIntegrations;
  if (bridge && bridge[name]) return bridge[name](args);
  return { simulated: true, note: `${name} 연동은 서버 실행 + 크리덴셜이 필요합니다. 상단바 "서버 실행" 을 눌러주세요.` };
}

// 도구를 실제로 호출하는 에이전트 브리지 (서버에서 tool_use 루프 실행)
async function callAgent(args) {
  const bridge = globalThis.__conduitAgent;
  if (bridge) return bridge(args);
  return { simulated: true, text: '〔시뮬레이션〕 서버에서 실행하면 도구를 실제로 호출하는 에이전트가 동작합니다.', steps: [] };
}
const AGENT_TOOLS = ['run_code', 'http_get', 'http_auth', 'youtube_search', 'naver_search', 'slack_post', 'notion_create', 'run_workflow', 'mcp_list_tools', 'mcp_call'];

// "slack=내슬랙, notion=업무" → { slack:'내슬랙', notion:'업무' }
function parseCreds(str) {
  const out = {};
  String(str || '').split(',').forEach((pair) => {
    const [k, v] = pair.split('=');
    if (k && v) out[k.trim()] = v.trim();
  });
  return out;
}

const OPS = ['==', '!=', '>', '<', '>=', '<=', 'contains', 'isEmpty'];

export const NODE_TYPES = {
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
    defaults: { interval: '매일 09:00' },
    fields: [{ key: 'interval', label: '실행 주기', type: 'select', options: ['매분', '10분마다', '매시', '매일 09:00', '매주 월요일'] }],
    summary: (p) => `주기: ${p.interval}`,
    run: async (_i, p, ctx) => ({ main: { triggeredAt: ctx.$now, interval: p.interval } }),
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
    inputs: ['main'], outputs: ['main'],
    defaults: { method: 'GET', url: 'https://api.github.com/zen', body: '' },
    fields: [
      { key: 'method', label: '메서드', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'url', label: 'URL (표현식 지원)', type: 'text' },
      { key: 'body', label: '요청 본문 (JSON)', type: 'textarea' },
    ],
    summary: (p) => `${p.method} · ${p.url}`,
    run: async (_i, p) => {
      const opt = { method: p.method };
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
      const out = { 1: undefined, 2: undefined, 3: undefined, 기타: undefined };
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
      let base = {};
      if (p.include === 'all') {
        base = { ...parent };
        delete base[String(p.fieldToSplitOut).split('.')[0]];
      } else if (p.include === 'selected' && p.includeFields) {
        for (const f of String(p.includeFields).split(',').map((s) => s.trim()).filter(Boolean)) {
          base[f.split('.').pop()] = getPath(parent, f);
        }
      }
      return { main: arr.map((el) => (el && typeof el === 'object' ? { ...base, ...el } : { ...base, value: el })) };
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
      const items = i.main || [];
      const nums = () => items.map((it) => Number(getPath(it, p.field))).filter((n) => Number.isFinite(n));
      let value;
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
      const items = [...(i.main || [])];
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
      const seen = new Set();
      const out = [];
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
    title: '화면 이해 (무슨 기능인지)', icon: 'sparkles', color: '#7c5cbf', category: 'AI', backend: true,
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
    title: '소크라테스식 읽기 (검증된 이해)', icon: 'sparkles', color: '#7c5cbf', category: 'AI', backend: true,
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
      const r = await callIntegration('memoryRecall', { query: p.query, k: Number(p.k) || 5, types: String(p.types || '').split(',').map((t) => t.trim()).filter(Boolean) });
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
    title: 'Slack 메시지', icon: 'output', color: '#611f69', category: '연동', backend: true,
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
    title: '텔레그램 메시지', icon: 'output', color: '#2aabee', category: '연동', backend: true,
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
    title: 'Gmail 보내기', icon: 'output', color: '#c5221f', category: '연동', backend: true,
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
    title: 'Notion 페이지 생성', icon: 'edit', color: '#111111', category: '연동', backend: true,
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
  rankData: {
    title: '실데이터 랭킹 (World Bank)', icon: 'globe', color: '#1a7f5a', category: '연동', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { indicator: 'fertility', top: '3', bottom: '0', include: 'us,cn,jp,kr', order: 'desc' },
    fields: [
      { key: 'indicator', label: '지표 (비우면 통과 — 수동 데이터 사용)', type: 'select', options: ['', 'fertility', 'gdpPerCapita', 'lifeExpectancy', 'population', 'internetUsers', 'unemployment'] },
      { key: 'top', label: '상위 N개국', type: 'select', options: ['1', '2', '3', '4', '5'] },
      { key: 'bottom', label: '최하위 N개국 (꼴찌 리빌용)', type: 'select', options: ['0', '1', '2'] },
      { key: 'include', label: '필수 포함 (ISO2 쉼표구분)', type: 'text' },
      { key: 'order', label: '정렬', type: 'select', options: ['desc', 'asc'] },
    ],
    summary: (p) => (p.indicator ? `WB · ${p.indicator} (실세계 순위)` : '통과 (수동 데이터)'),
    run: async (i, p) => {
      if (!p.indicator) return { main: i.main }; // 수동 데이터 주제는 그대로 통과
      const r = await callIntegration('rankData', {
        indicator: p.indicator, top: Number(p.top) || 3, bottom: Number(p.bottom) || 0, include: p.include, order: p.order,
      });
      return { main: { ...(i.main || {}), rank: r } };
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
    title: 'AI · Claude', icon: 'spark', color: '#cc785c', category: 'AI', backend: true,
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
      return { main: { ...(i.main || {}), aiText: r.text, _ai: { model: p.model, simulated: !!r.simulated, usage: r.usage } } };
    },
  },
  aiExtract: {
    title: 'AI 구조화 추출', icon: 'spark', color: '#cc785c', category: 'AI', backend: true,
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
      return { main: { ...(i.main || {}), [p.target]: parsed, _ai: { model: p.model, simulated: !!r.simulated, usage: r.usage } } };
    },
  },
  aiAgent: {
    title: 'AI 에이전트 (도구 사용)', icon: 'bolt', color: '#cc785c', category: 'AI', backend: true,
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
        onStep: ctx?.onAgentStep ? (step) => ctx.onAgentStep(step) : undefined,
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
    title: '루프 엔지니어링', icon: 'flow', color: '#cc785c', category: 'AI', backend: true,
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
      const history = [];
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
  tts: {
    title: 'TTS 내레이션 (무료)', icon: 'play', color: '#0e9f6e', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      text: '{{ $json.script }}',
      voice: '선희(여)',
    },
    fields: [
      { key: 'text', label: '내레이션 대본 (표현식 지원)', type: 'textarea' },
      { key: 'voice', label: '음성 (Edge 신경망 무료 · 오프라인은 시스템)', type: 'select', options: ['선희(여)', '인준(남)', '현수(남·멀티링궐)', '제니(영어·여)', '크리스토퍼(영어·남)', '시스템(오프라인)'] },
    ],
    summary: (p) => `무료 TTS · ${p.voice}`,
    run: async (i, p) => {
      const r = await callIntegration('tts', { text: p.text, voice: p.voice });
      return { main: { ...(i.main || {}), tts: r } };
    },
  },
  videoRender: {
    title: '쇼츠 렌더 (랭킹)', icon: 'play', color: '#dc2670', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      title: '{{ $json.title }}',
      subtitle: '',
      dataJson: '{{ $json.data }}',
      cta: '구독하고 다음 랭킹 받기',
      source: '',
      audioPath: '',
      composition: 'RankRace',
    },
    fields: [
      { key: 'composition', label: '스타일', type: 'select', options: ['RankRace', 'DataShort'] },
      { key: 'title', label: '제목 (표현식 지원)', type: 'text' },
      { key: 'subtitle', label: '부제 (선택)', type: 'text' },
      { key: 'dataJson', label: '랭킹 데이터 [{label,value,suffix?}] (표현식 지원)', type: 'textarea' },
      { key: 'cta', label: 'CTA 문구', type: 'text' },
      { key: 'source', label: '출처 표기 (선택)', type: 'text' },
      { key: 'audioPath', label: '내레이션 mp3 경로 (선택 · 예: {{ $json.tts.file }})', type: 'text' },
      { key: 'teaseText', label: '1위 직전 문구 (RankRace · 기본 "1위는...?")', type: 'text' },
    ],
    summary: (p) => `쇼츠: ${p.title}`,
    run: async (i, p) => {
      let data = p.dataJson;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = []; } }
      const r = await callIntegration('videoRender', {
        title: p.title, subtitle: p.subtitle, data, cta: p.cta, source: p.source, audioPath: p.audioPath,
        composition: p.composition, teaseText: p.teaseText,
      });
      return { main: { ...(i.main || {}), video: r } };
    },
  },
  spinTest: {
    title: '착시 테스트 렌더 (회전 실루엣)', icon: 'spark', color: '#111111', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      title: '{{ $json.title }}',
      subtitle: '{{ $json.subtitle }}',
      sectionsJson: '{{ $json.sections }}',
      voice: '선희(여)',
      secPerRev: '3',
    },
    fields: [
      { key: 'title', label: '훅 제목 (표현식 지원)', type: 'text' },
      { key: 'subtitle', label: '빨간 보조 훅', type: 'text' },
      { key: 'sectionsJson', label: '섹션 배열 [{band,sub?,accent?,narr?}] (표현식 지원)', type: 'textarea' },
      { key: 'voice', label: '내레이션 음성 (섹션별 1:1 싱크)', type: 'select', options: ['선희(여)', '인준(남)', '현수(남·멀티링궐)'] },
      { key: 'secPerRev', label: '1회전 시간(초)', type: 'select', options: ['2', '3', '4'] },
    ],
    summary: (p) => `착시: ${p.title}`,
    run: async (i, p) => {
      let sections = p.sectionsJson;
      if (typeof sections === 'string') { try { sections = JSON.parse(sections); } catch { sections = []; } }
      const r = await callIntegration('spinTest', {
        title: p.title, subtitle: p.subtitle, sections, voice: p.voice, secPerRev: p.secPerRev,
      });
      return { main: { ...(i.main || {}), video: r } };
    },
  },
  brainQuiz: {
    title: '두뇌퀴즈 렌더 (시니어)', icon: 'spark', color: '#e8630a', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      title: '{{ $json.title }}',
      roundsJson: '{{ $json.rounds }}',
      cta: '댓글로 알려주세요!',
      countdownSec: '5',
      voice: '인준(남)',
    },
    fields: [
      { key: 'title', label: '훅 제목 (표현식 지원)', type: 'text' },
      { key: 'roundsJson', label: '문제 배열 [{type:oddone|hidden|chosung,...}] (표현식 지원)', type: 'textarea' },
      { key: 'cta', label: 'CTA 문구', type: 'text' },
      { key: 'countdownSec', label: '문제당 카운트다운(초)', type: 'select', options: ['3', '5', '7'] },
      { key: 'voice', label: '내레이션 음성 (문장별 자동 생성·1:1 싱크)', type: 'select', options: ['인준(남)', '선희(여)', '현수(남·멀티링궐)'] },
    ],
    summary: (p) => `두뇌퀴즈: ${p.title}`,
    run: async (i, p) => {
      let rounds = p.roundsJson;
      if (typeof rounds === 'string') { try { rounds = JSON.parse(rounds); } catch { rounds = []; } }
      const r = await callIntegration('brainQuiz', {
        title: p.title, rounds, cta: p.cta, countdownSec: p.countdownSec, voice: p.voice,
      });
      return { main: { ...(i.main || {}), video: r } };
    },
  },
  multiLangShort: {
    title: '다국어 쇼츠 (올인원)', icon: 'globe', color: '#0ea5e9', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      format: 'colorVision',
      locales: 'ko,en',
      platesJson: '{{ $json.plates }}',
      playSec: '12',
    },
    fields: [
      { key: 'format', label: '포맷', type: 'select', options: ['colorVision', 'attention'] },
      { key: 'locales', label: '언어 (쉼표 구분 · ko/en/ja/es)', type: 'text' },
      { key: 'platesJson', label: '[색각] 판 배열 [{number,palette}] (표현식 지원)', type: 'textarea' },
      { key: 'playSec', label: '[집중력] 재생 길이(초)', type: 'text' },
    ],
    summary: (p) => `다국어 쇼츠: ${p.format} → ${p.locales}`,
    run: async (i, p) => {
      const locales = String(p.locales || 'ko,en').split(',').map((s) => s.trim()).filter(Boolean);
      const opts = { format: p.format, locales };
      if (p.format === 'colorVision') {
        let plates = p.platesJson;
        if (typeof plates === 'string') { try { plates = JSON.parse(plates); } catch { plates = []; } }
        opts.plates = plates;
      } else {
        opts.playSec = Number(p.playSec) || 12;
      }
      const r = await callIntegration('multiLang', opts);
      return { main: { ...(i.main || {}), multi: r } };
    },
  },
  issueShort: {
    title: '핫이슈 쇼츠 렌더 (헤드라인 3줄)', icon: 'play', color: '#e11d48', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      topic: '{{ $json.topic }}',
      traffic: '{{ $json.traffic }}',
      headlinesJson: '{{ $json.headlines }}',
      maxHeadlines: '3',
      voice: '선희(여)',
      cta: '자세한 내용은 설명란 출처 링크에서 확인하세요. 내일 아침 9시, 다음 핫이슈로 만나요.',
    },
    fields: [
      { key: 'topic', label: '주제 (표현식 지원)', type: 'text' },
      { key: 'traffic', label: '검색량 (표현식 · 없으면 비움)', type: 'text' },
      { key: 'headlinesJson', label: '헤드라인 배열 [{title,source,url}] (표현식 지원)', type: 'textarea' },
      { key: 'maxHeadlines', label: '읽을 헤드라인 수', type: 'select', options: ['2', '3', '4'] },
      { key: 'voice', label: '내레이션 음성 (문장별 1:1 싱크)', type: 'select', options: ['선희(여)', '인준(남)', '현수(남·멀티링궐)'] },
      { key: 'cta', label: '마무리 멘트', type: 'textarea' },
    ],
    summary: (p) => `핫이슈 쇼츠: ${p.topic}`,
    // 출력에 title/description/tags 를 얹어 두면 YouTube 업로드 노드 기본값이 그대로 물린다
    run: async (i, p) => {
      let headlines = p.headlinesJson;
      if (typeof headlines === 'string') { try { headlines = JSON.parse(headlines); } catch { headlines = []; } }
      const r = await callIntegration('issueShort', {
        topic: p.topic, traffic: p.traffic, headlines, maxHeadlines: Number(p.maxHeadlines) || 3, voice: p.voice, cta: p.cta,
      });
      return { main: { ...(i.main || {}), video: r, ...(r?.yt ? { title: r.yt.title, description: r.yt.description, tags: r.yt.tags } : {}) } };
    },
  },
  memeShort: {
    title: '한 줄 댓글 밈 쇼츠 렌더', icon: 'play', color: '#16a34a', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      episode: '{{ $json.episode }}',
      itemsJson: '{{ $json.memes }}',
      hook: '{{ $json.hook }}',
      titleLine1: '사진보다 웃긴',
      titleLine2: '댓글 한 줄',
      personaName: '오덤덤',
    },
    fields: [
      { key: 'episode', label: '몇 탄 (표현식 지원)', type: 'text' },
      { key: 'itemsJson', label: '밈 배열 [{kind,setupLines,emphasis,image,punch,credit,attribution}] 2~8개 (표현식 지원)', type: 'textarea' },
      { key: 'hook', label: '업로드 제목 앞부분 — 1번 밈 상황 한마디 (회차마다 달라야 한다)', type: 'text' },
      { key: 'titleLine1', label: '화면 상단 제목 1줄 (흰색)', type: 'text' },
      { key: 'titleLine2', label: '화면 상단 제목 2줄 (포인트색)', type: 'text' },
      { key: 'personaName', label: '댓글 다는 캐릭터 이름', type: 'text' },
    ],
    summary: (p) => `한 줄 댓글 밈 ${p.episode}탄`,
    // 사진은 미리 골라 둔 것만 받는다(image 경로) — 검색 결과에서 자동으로 고르지 않는다.
    // 출력에 title/description/tags 를 얹어 두면 YouTube 업로드 노드 기본값이 그대로 물린다
    run: async (i, p) => {
      let items = p.itemsJson;
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
      const r = await callIntegration('memeShort', {
        episode: Number(p.episode) || 1, items, hook: p.hook || undefined,
        titleLine1: p.titleLine1, titleLine2: p.titleLine2, persona: { name: p.personaName || '오덤덤' },
      });
      if (r?.ok === false) throw new Error(`밈 쇼츠 렌더 실패: ${r.error}`);
      return { main: { ...(i.main || {}), video: r, ...(r?.yt ? { title: r.yt.title, description: r.yt.description, tags: r.yt.tags } : {}) } };
    },
  },
  clipStory: {
    title: '실영상 쇼츠 렌더 (영상 하나 = 이야기 하나)', icon: 'play', color: '#5cc8ff', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      slug: '{{ $json.slug }}',
      uploadTitle: '{{ $json.uploadTitle }}',
      titleLine1: '{{ $json.titleLine1 }}',
      titleLine2: '{{ $json.titleLine2 }}',
      credit: '{{ $json.credit }}',
      attributionsJson: '{{ $json.attributions }}',
      beatsJson: '{{ $json.beats }}',
      tags: '',
      clipVolume: '0',
    },
    fields: [
      { key: 'slug', label: '파일 이름에 쓸 영문 약칭', type: 'text' },
      { key: 'uploadTitle', label: '업로드 제목 (제목 카드에도 뜬다)', type: 'text' },
      { key: 'titleLine1', label: '화면 상단 1줄 (흰색)', type: 'text' },
      { key: 'titleLine2', label: '화면 상단 2줄 (포인트색)', type: 'text' },
      { key: 'credit', label: '화면 출처 — 작품명·연도·라이선스', type: 'text' },
      { key: 'attributionsJson', label: '설명란 출처 배열 (표현식 지원)', type: 'textarea' },
      { key: 'beatsJson', label: '자막 배열 [{text,style,video,startSec,fit}] (표현식 지원)', type: 'textarea' },
      { key: 'tags', label: '태그 (쉼표구분)', type: 'text' },
      { key: 'clipVolume', label: '원본 소리 (같은 출처의 기록일 때만 0보다 크게)', type: 'text' },
    ],
    summary: (p) => `실영상 쇼츠: ${p.uploadTitle || p.slug}`,
    // 출력에 title/description/tags 를 얹어 두면 YouTube 업로드 노드 기본값이 그대로 물린다
    run: async (i, p) => {
      const parse = (v, fb) => { if (typeof v !== 'string') return v ?? fb; try { return JSON.parse(v); } catch { return fb; } };
      const r = await callIntegration('clipStory', {
        slug: p.slug, uploadTitle: p.uploadTitle, titleLine1: p.titleLine1, titleLine2: p.titleLine2,
        credit: p.credit, attributions: parse(p.attributionsJson, []), beats: parse(p.beatsJson, []),
        tags: String(p.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        clipVolume: Number(p.clipVolume) || 0,
      });
      if (r?.ok === false) throw new Error(`실영상 쇼츠 렌더 실패: ${r.error}`);
      return { main: { ...(i.main || {}), video: r, ...(r?.yt ? { title: r.yt.title, description: r.yt.description, tags: r.yt.tags } : {}) } };
    },
  },
  youtubeUpload: {
    title: 'YouTube 업로드', icon: 'globe', color: '#ff0000', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      filePath: '{{ $json.video.file }}',
      title: '{{ $json.title }}',
      description: '#Shorts',
      tags: '랭킹,shorts',
      privacyStatus: 'private',
      categoryId: '27 교육',
    },
    fields: [
      { key: 'filePath', label: 'MP4 경로 (표현식 지원)', type: 'text' },
      { key: 'title', label: '영상 제목 (표현식 지원)', type: 'text' },
      { key: 'description', label: '설명', type: 'textarea' },
      { key: 'tags', label: '태그 (쉼표구분)', type: 'text' },
      { key: 'privacyStatus', label: '공개 범위', type: 'select', options: ['private', 'unlisted', 'public'] },
      { key: 'categoryId', label: '카테고리', type: 'select', options: ['27 교육', '23 코미디', '24 엔터테인먼트'] },
    ],
    summary: (p) => `업로드 (${p.privacyStatus})`,
    run: async (i, p) => {
      const r = await callIntegration('youtubeUpload', {
        filePath: p.filePath, title: p.title, description: p.description, tags: p.tags, privacyStatus: p.privacyStatus,
        categoryId: String(p.categoryId || '27').split(' ')[0],
      });
      // 크리덴셜이 없으면 통합 함수가 simulated 를 돌려준다. 조용히 성공한 척하면 안 올라간 걸 모르고 지나치므로 여기서 끊는다
      if (r?.simulated) throw new Error(`YouTube 업로드를 건너뛰었습니다: ${r.note}`);
      if (r?.ok === false) throw new Error(`YouTube 업로드 실패: ${r.error}`);
      return { main: { ...(i.main || {}), upload: r } };
    },
  },
  verifiedComment: {
    title: '검증 댓글 예약', icon: 'spark', color: '#cc785c', category: '영상', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      videoId: '{{ $json.upload.videoId }}',
      template: 'colorvision',
      publishAt: '',
    },
    fields: [
      { key: 'videoId', label: '영상 ID (보통 업로드 결과)', type: 'text' },
      { key: 'template', label: '논문 템플릿', type: 'select', options: ['colorvision', 'attention', 'hearing', 'mindage', 'spintest'] },
      { key: 'publishAt', label: '공개 시각 ISO (비우면 지금 기준)', type: 'text' },
    ],
    summary: (p) => `검증 댓글 예약 (${p.template})`,
    // 큐에 넣기만 한다. 실제 게시는 검증 댓글 봇이 공개시각 +3분~+26시간 창에 수행.
    run: async (i, p) => {
      const r = await callIntegration('verifiedComment', {
        videoId: p.videoId, template: p.template, at: p.publishAt || undefined,
      });
      return { main: { ...(i.main || {}), verifiedComment: r } };
    },
  },

  /* ---------------- 수익화 (쿠팡파트너스 × 블로그 공장) ---------------- */
  coupangProducts: {
    title: '쿠팡 상품 조회', icon: 'search', color: '#c0392b', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { source: 'goldbox', category: '뷰티', keyword: '', limit: '10', minPrice: '10000', sort: 'rank' },
    fields: [
      { key: 'source', label: '소스', type: 'select', options: ['goldbox', 'best', 'search'] },
      { key: 'category', label: '카테고리 (best일 때) — 위쪽일수록 파트너스 요율이 높은 편', type: 'select', options: ['뷰티', '여성패션', '남성패션', '출산/유아동', '스포츠/레저', '반려동물용품', '헬스/건강식품', '완구/취미', '식품', '주방용품', '생활용품', '홈인테리어', '문구/오피스', '자동차용품', '도서/음반', '가전디지털'] },
      { key: 'keyword', label: '검색어 (search일 때 · 표현식 지원)', type: 'text' },
      { key: 'limit', label: '개수', type: 'select', options: ['5', '8', '10', '15', '20'] },
      { key: 'minPrice', label: '최소 가격 (객단가 필터 · 원)', type: 'text' },
      { key: 'sort', label: '정렬', type: 'select', options: ['rank', 'priceDesc'] },
    ],
    summary: (p) => `쿠팡 ${p.source}${p.source === 'best' ? `·${p.category}` : ''} (₩${p.minPrice}+)`,
    run: async (i, p) => {
      const r = await callIntegration('coupangProducts', {
        source: p.source, category: p.category, keyword: p.keyword,
        limit: p.limit, minPrice: p.minPrice, sort: p.sort,
      });
      return { main: { ...(i.main || {}), ...r } };
    },
  },
  coupangReport: {
    title: '쿠팡 실적 리포트 (객단가)', icon: 'list', color: '#c0392b', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { type: 'orders', days: '30' },
    fields: [
      { key: 'type', label: '리포트 종류', type: 'select', options: ['orders', 'clicks', 'commission'] },
      { key: 'days', label: '기간 (일)', type: 'select', options: ['7', '14', '30', '60', '90'] },
    ],
    summary: (p) => `실적 ${p.type} · ${p.days}일`,
    run: async (i, p) => {
      const r = await callIntegration('coupangReport', { type: p.type, days: p.days });
      return { main: { ...(i.main || {}), report: r } };
    },
  },
  blogPost: {
    title: '블로그 포스트 생성', icon: 'edit', color: '#2f6fed', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      productsPath: '{{ $json.products }}',
      keyword: '오늘의 특가',
      title: '',
      style: 'ranking',
      network: 'coupang',
      cta: '오늘 가격 확인하기',
      useLLM: 'auto',
    },
    fields: [
      { key: 'productsPath', label: '상품 배열 (표현식)', type: 'text' },
      { key: 'keyword', label: '주제 키워드 (제목·서론에 사용)', type: 'text' },
      { key: 'title', label: '제목 직접 지정 (비우면 자동)', type: 'text' },
      { key: 'style', label: '글 형식', type: 'select', options: ['ranking', 'review'] },
      { key: 'network', label: '제휴 채널 (공정위 문구 자동 선택)', type: 'select', options: ['coupang', 'ali', 'linkprice'] },
      { key: 'cta', label: '버튼 문구', type: 'text' },
      { key: 'useLLM', label: 'AI 서론/코멘트 (키 있을 때)', type: 'select', options: ['auto', 'off'] },
    ],
    summary: (p) => `포스트: ${p.keyword} (${p.style}·${p.network || 'coupang'})`,
    run: async (i, p) => {
      const r = await callIntegration('blogPost', {
        products: p.productsPath, keyword: p.keyword, title: p.title,
        style: p.style, network: p.network, cta: p.cta, useLLM: p.useLLM,
      });
      return { main: { ...(i.main || {}), post: r } };
    },
  },
  aliProducts: {
    title: '알리 상품 조회', icon: 'search', color: '#e43225', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { source: 'hot', keyword: '', limit: '8', minPrice: '5000', minCommission: '5' },
    fields: [
      { key: 'source', label: '소스 (hot=핫딜 추천)', type: 'select', options: ['hot', 'search'] },
      { key: 'keyword', label: '검색어 (search일 때 · 표현식 지원)', type: 'text' },
      { key: 'limit', label: '개수', type: 'select', options: ['5', '8', '10', '15'] },
      { key: 'minPrice', label: '최소 가격 (원)', type: 'text' },
      { key: 'minCommission', label: '최소 수수료 % (미등록 1% 함정 회피)', type: 'select', options: ['3', '5', '7'] },
    ],
    summary: (p) => `알리 ${p.source} (수수료 ${p.minCommission}%+)`,
    run: async (i, p) => {
      const r = await callIntegration('aliProducts', {
        source: p.source, keyword: p.keyword, limit: p.limit, minPrice: p.minPrice, minCommission: p.minCommission,
      });
      return { main: { ...(i.main || {}), ...r } };
    },
  },
  linkpriceMerchants: {
    title: '링크프라이스 머천트 조회', icon: 'list', color: '#0b8457', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { status: 'apr', type: 'cps' },
    fields: [
      { key: 'status', label: '범위 (apr=승인된 것만)', type: 'select', options: ['apr', 'all'] },
      { key: 'type', label: '유형', type: 'select', options: ['cps', 'cpa'] },
    ],
    summary: (p) => `머천트 ${p.status}/${p.type}`,
    run: async (i, p) => {
      const r = await callIntegration('linkpriceMerchants', { status: p.status, type: p.type });
      return { main: { ...(i.main || {}), ...r } };
    },
  },
  linkpriceDeeplink: {
    title: '링크프라이스 딥링크 변환', icon: 'key', color: '#0b8457', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { productsPath: '{{ $json.products }}', merchantId: 'gmarket' },
    fields: [
      { key: 'productsPath', label: '상품 배열 (url 필드 필수 · 표현식)', type: 'text' },
      { key: 'merchantId', label: '머천트 ID (머천트 조회로 확인, 예: gmarket)', type: 'text' },
    ],
    summary: (p) => `딥링크 → ${p.merchantId}`,
    run: async (i, p) => {
      const r = await callIntegration('linkpriceDeeplink', { products: p.productsPath, merchantId: p.merchantId });
      return { main: { ...(i.main || {}), ...r } };
    },
  },
  linkpriceReport: {
    title: '링크프라이스 실적 조회', icon: 'list', color: '#0b8457', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: { period: '' },
    fields: [
      { key: 'period', label: '기간 (YYYYMM 또는 YYYYMMDD · 비우면 이번 달)', type: 'text' },
    ],
    summary: (p) => `실적 ${p.period || '이번 달'}`,
    run: async (i, p) => {
      const r = await callIntegration('linkpriceReport', { period: p.period });
      return { main: { ...(i.main || {}), report: r } };
    },
  },
  bloggerPublish: {
    title: 'Blogger 발행', icon: 'globe', color: '#ff8f00', category: '수익화', backend: true,
    inputs: ['main'], outputs: ['main'],
    defaults: {
      blogId: '',
      title: '{{ $json.post.title }}',
      html: '{{ $json.post.html }}',
      labels: '{{ $json.post.tags }}',
      metaDescription: '{{ $json.post.metaDescription }}',
      isDraft: 'true',
    },
    fields: [
      { key: 'blogId', label: '블로그 ID (비우면 .env BLOGGER_BLOG_ID)', type: 'text' },
      { key: 'title', label: '제목 (표현식)', type: 'text' },
      { key: 'html', label: '본문 HTML (표현식)', type: 'textarea' },
      { key: 'labels', label: '라벨 (쉼표 또는 표현식)', type: 'text' },
      { key: 'metaDescription', label: '검색 설명 (비우면 서론에서 자동)', type: 'text' },
      { key: 'isDraft', label: '초안으로 저장', type: 'select', options: ['true', 'false'] },
    ],
    summary: (p) => `Blogger ${p.isDraft === 'false' ? '공개 발행' : '초안 저장'}`,
    run: async (i, p) => {
      const r = await callIntegration('bloggerPublish', {
        blogId: p.blogId, title: p.title, html: p.html, labels: p.labels, isDraft: p.isDraft,
        metaDescription: p.metaDescription, keyword: i.main?.keyword || '', network: i.main?.network || '',
      });
      return { main: { ...(i.main || {}), published: r } };
    },
  },

  /* ---------------- 출력 ---------------- */
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
  const map = {};
  for (const [k, v] of Object.entries(NODE_TYPES)) {
    (map[v.category] ||= []).push(k);
  }
  return order.filter((c) => map[c]).map((c) => ({ name: c, items: map[c] }));
})();

// 출력 맵에서 아이템 개수 (뱃지용) — 모든 포트 합산
export function itemCount(output) {
  if (!output) return 0;
  const v = output.main ?? output.true ?? output.false ?? Object.values(output).find((x) => x !== undefined);
  return toItems(v).length;
}

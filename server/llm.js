// ============================================================
// LLM 브리지 — 제공자 하나를 고르고, 같은 모양의 응답을 돌려준다.
//
//   왜: 키 입력을 꺼리는 사람이 많다. 키가 없어도 PC 에서 도는 모델(Ollama · LM Studio ·
//   llama.cpp 등 OpenAI 호환 서버)로 같은 노드가 동작해야 한다. 검증(인용·값 근거)은 코드가
//   하므로 모델이 바뀌어도 "지어낸 답이 통과" 하지는 않는다.
//
//   고르는 순서 (getProvider):
//     1. Anthropic 키(환경변수 ANTHROPIC_API_KEY · 크리덴셜 type=anthropic)  → 'anthropic'
//     2. 로컬 서버 주소(환경변수 CONDUIT_LLM_BASE_URL · 설정 llm.baseUrl)   → 'local'
//     3. 아무 설정이 없으면 Ollama 기본 주소를 한 번 두드려 본다(60초 캐시)   → 'local' (자동)
//     4. 없으면 시뮬레이션 응답 (노드는 항상 "동작" 한다)
//   설정 llm.provider 가 'anthropic' | 'local' 이면 그 순서를 무시하고 고정한다. 'off' 면 항상 시뮬레이션.
//
//   nodeTypes 의 AI 노드는 globalThis.__conduitLLM 을 통해 callLLM 을 쓴다.
// ============================================================
import { Credentials, Settings } from './store.js';

export const OLLAMA_DEFAULT = 'http://localhost:11434/v1';
export const DEFAULT_CLAUDE = 'claude-sonnet-5';
// 자동 감지 때 고르는 순서 — 생각(reasoning) 없이 바로 답하고 이미지도 보는 모델부터.
// qwen3 같은 추론 모델은 생각에 토큰을 다 쓰면 답이 비어 오고 10배쯤 느리다 → 맨 뒤.
const PREFERRED_LOCAL = ['gemma3', 'qwen2.5', 'llama3.2', 'llama3', 'exaone', 'mistral', 'qwen3'];
export const RECOMMENDED_LOCAL = 'gemma3:4b';

export function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const cred = Credentials.all().find((c) => c.type === 'anthropic');
  if (cred) {
    try {
      const d = Credentials.reveal(cred.id);
      return d.apiKey || d.key || null;
    } catch {
      return null;
    }
  }
  return null;
}

export const anthropicBase = () => (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
/** "http://host:11434" 처럼 /v1 이 빠진 주소도 받아 준다 */
export const normalizeBaseUrl = (u) => {
  const s = trimSlash(u);
  if (!s) return '';
  return /\/v\d+$/.test(s) ? s : `${s}/v1`;
};

/* ---------- 로컬 서버 감지 (Ollama · LM Studio 등) ---------- */
let probeCache = { at: 0, base: '', result: null };
const PROBE_TTL = 60_000;

/** OpenAI 호환 서버의 모델 목록. 못 붙으면 null. */
export async function probeLocal(baseUrl, { fetchImpl = fetch, timeoutMs = 1500, force = false } = {}) {
  const base = normalizeBaseUrl(baseUrl || OLLAMA_DEFAULT);
  const now = Date.now();
  if (!force && probeCache.base === base && now - probeCache.at < PROBE_TTL) return probeCache.result;
  let result = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetchImpl(`${base}/models`, { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) {
      const d = await r.json();
      const models = (d.data || []).map((m) => m.id).filter(Boolean);
      result = { base, models };
    }
  } catch {
    result = null;
  }
  probeCache = { at: now, base, result };
  return result;
}
export const resetProbeCache = () => { probeCache = { at: 0, base: '', result: null }; ollamaCache = new Map(); };

/* ---------- Ollama 인지 확인 ----------
   Ollama 의 OpenAI 호환 엔드포인트는 추론 모델의 생각을 content 에서 떼어 주지 않는다(비거나 섞여 온다).
   네이티브 /api/chat 은 생각을 thinking 필드로 분리해 주고, 이미지도 images 배열로 받는다. */
let ollamaCache = new Map();
export const originOf = (base) => String(base).replace(/\/v\d+$/, '');
export async function isOllama(base, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const origin = originOf(base);
  const hit = ollamaCache.get(origin);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.yes;
  let yes = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetchImpl(`${origin}/api/version`, { signal: ctl.signal });
    clearTimeout(t);
    yes = r.ok && !!(await r.json().catch(() => null))?.version;
  } catch { yes = false; }
  ollamaCache.set(origin, { at: Date.now(), yes });
  return yes;
}

export function pickLocalModel(models = []) {
  for (const pref of PREFERRED_LOCAL) {
    const hit = models.find((m) => m.toLowerCase().startsWith(pref));
    if (hit) return hit;
  }
  return models[0] || null;
}

/* ---------- 제공자 고르기 ---------- */
/**
 * @returns {Promise<
 *   { kind:'anthropic', key:string, model:string } |
 *   { kind:'local', base:string, model:string|null, auto:boolean } |
 *   null >}
 */
export async function getProvider({ fetchImpl = fetch } = {}) {
  const cfg = Settings.get('llm');
  const forced = cfg.provider;                       // 'anthropic' | 'local' | 'off' | undefined('auto')
  if (forced === 'off') return null;

  const key = getApiKey();
  if (forced !== 'local' && key) return { kind: 'anthropic', key, model: cfg.claudeModel || DEFAULT_CLAUDE };
  if (forced === 'anthropic') return null;

  const configured = normalizeBaseUrl(process.env.CONDUIT_LLM_BASE_URL || cfg.baseUrl);
  const model = process.env.CONDUIT_LLM_MODEL || cfg.model || null;
  if (configured) return { kind: 'local', base: configured, model, auto: false };

  // 아무 설정이 없다 — Ollama 가 켜져 있으면 그냥 쓴다 (사용자가 아무것도 안 해도 동작)
  // 테스트·CI 는 CONDUIT_LLM_AUTODETECT=off 로 끈다 (개발자 PC 의 Ollama 가 결과를 바꾸지 않게)
  if (/^(off|0|false)$/i.test(process.env.CONDUIT_LLM_AUTODETECT || '')) return null;
  const found = await probeLocal(OLLAMA_DEFAULT, { fetchImpl });
  if (found && found.models.length) return { kind: 'local', base: found.base, model: model || pickLocalModel(found.models), auto: true };
  return null;
}

/** 화면에 보여 줄 요약 — 비밀값 없음 */
export async function describeProvider({ fetchImpl = fetch } = {}) {
  const cfg = Settings.get('llm');
  const p = await getProvider({ fetchImpl });
  const localBase = normalizeBaseUrl(process.env.CONDUIT_LLM_BASE_URL || cfg.baseUrl || OLLAMA_DEFAULT);
  const local = await probeLocal(localBase, { fetchImpl });
  return {
    provider: p?.kind || 'none',
    setting: cfg.provider || 'auto',
    model: p?.model || null,
    claude: { connected: !!getApiKey(), model: cfg.claudeModel || DEFAULT_CLAUDE },
    local: {
      base: localBase, reachable: !!local, models: local?.models || [], auto: !!p?.auto,
      configured: !!(process.env.CONDUIT_LLM_BASE_URL || cfg.baseUrl),
    },
  };
}

/* ---------- 메시지 변환 (Anthropic 블록 → OpenAI 호환) ---------- */
function toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  const parts = [];
  for (const b of content || []) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64') {
      parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
  }
  // 텍스트만 있으면 문자열로 (모든 로컬 서버가 배열 content 를 받지는 않는다)
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}
export function toOpenAIMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: 'system', content: String(system) });
  for (const m of messages || []) out.push({ role: m.role, content: toOpenAIContent(m.content) });
  return out;
}

/* ---------- 호출 ---------- */
export function simulatedReply({ prompt, model }) {
  return {
    text: `〔시뮬레이션 · ${model || 'LLM'}〕 연결된 모델이 없어 실제 호출을 건너뜁니다. ` +
      `PC 에서 Ollama 를 켜 두거나(키 불필요), 설정에 Anthropic 키를 넣으면 실제 응답이 나옵니다.\n프롬프트: ${String(prompt || '').slice(0, 140)}`,
    simulated: true,
  };
}

async function callAnthropic({ key, model, system, messages, maxTokens }, fetchImpl) {
  const res = await fetchImpl(`${anthropicBase()}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: Number(maxTokens) || 1024, system: system || undefined, messages }),
  });
  const data = await res.json();
  if (data.error) return { text: `[Anthropic 오류] ${data.error.message}`, error: true, provider: 'anthropic', model };
  const text = (data.content || []).map((b) => b.text || '').join('');
  return { text, usage: data.usage, simulated: false, provider: 'anthropic', model };
}

/** 추론 모델이 답 앞에 붙이는 생각을 걷어낸다 — <think>…</think> 뿐 아니라 여는 태그 없이 </think> 만 오는 경우도 */
export function stripThinking(content) {
  let t = String(content || '');
  t = t.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  if (t.includes('</think>')) t = t.slice(t.lastIndexOf('</think>') + '</think>'.length);
  return t.trim();
}
/** Ollama 네이티브 — 이미지는 images 배열로, 생각은 thinking 필드로 분리돼 온다 */
function toOllamaMessages({ system, messages }) {
  const out = [];
  if (system) out.push({ role: 'system', content: String(system) });
  for (const m of messages || []) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const texts = []; const images = [];
    for (const b of m.content || []) {
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image' && b.source?.type === 'base64') images.push(b.source.data);
    }
    out.push({ role: m.role, content: texts.join('\n'), ...(images.length ? { images } : {}) });
  }
  return out;
}
async function callOllama({ base, model, system, messages, maxTokens }, fetchImpl) {
  const res = await fetchImpl(`${originOf(base)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, stream: false,
      options: { num_predict: Number(maxTokens) || 1024 },
      messages: toOllamaMessages({ system, messages }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || data.error || `${res.status} ${res.statusText}`;
    return { text: `[로컬 모델 오류 · ${model}] ${msg}`, error: true, provider: 'local', model };
  }
  const text = stripThinking(data.message?.content);
  if (!text && data.message?.thinking) {
    return { text: `[로컬 모델 오류 · ${model}] 생각(reasoning)에 토큰을 다 쓰고 답이 비었습니다. 추론 모델 대신 ${RECOMMENDED_LOCAL} 처럼 바로 답하는 모델을 권합니다 (ollama pull ${RECOMMENDED_LOCAL}).`, error: true, provider: 'local', model };
  }
  const usage = data.prompt_eval_count !== undefined
    ? { input_tokens: data.prompt_eval_count, output_tokens: data.eval_count } : undefined;
  return { text, usage, simulated: false, provider: 'local', model };
}

async function callLocal(args, fetchImpl) {
  if (await isOllama(args.base, { fetchImpl })) return callOllama(args, fetchImpl);
  return callOpenAICompat(args, fetchImpl);
}

async function callOpenAICompat({ base, model, system, messages, maxTokens }, fetchImpl) {
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CONDUIT_LLM_API_KEY || 'local'}` },
    body: JSON.stringify({
      model, max_tokens: Number(maxTokens) || 1024, stream: false,
      messages: toOpenAIMessages({ system, messages }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || data.error || `${res.status} ${res.statusText}`;
    return { text: `[로컬 모델 오류 · ${model}] ${msg}`, error: true, provider: 'local', model };
  }
  const choice = data.choices?.[0]?.message || {};
  // qwen3 류는 <think>…</think> 를 앞에 붙인다 — 답만 남긴다
  const text = stripThinking(choice.content);
  return { text, usage: data.usage, simulated: false, provider: 'local', model };
}

export async function callLLM({ system, prompt, model, messages, maxTokens = 1024 }, { fetchImpl = fetch } = {}) {
  const p = await getProvider({ fetchImpl });
  if (!p) return simulatedReply({ prompt, model });
  const msgs = messages || [{ role: 'user', content: prompt || '' }];
  try {
    if (p.kind === 'anthropic') {
      // 노드가 Claude 모델명을 골랐으면 그대로, 로컬 모델명이면 기본 Claude 로
      const m = model && /^claude/i.test(model) ? model : p.model;
      return await callAnthropic({ key: p.key, model: m, system, messages: msgs, maxTokens }, fetchImpl);
    }
    if (!p.model) return { text: '[로컬 모델 오류] 모델이 없습니다. `ollama pull gemma3:4b` 처럼 하나 받아 주세요.', error: true, provider: 'local' };
    // 노드가 claude-* 를 골랐어도 로컬 모드에서는 로컬 모델로 (사용자가 키를 안 넣은 선택을 존중)
    const m = model && !/^claude/i.test(model) ? model : p.model;
    return await callLocal({ base: p.base, model: m, system, messages: msgs, maxTokens }, fetchImpl);
  } catch (e) {
    return { text: `[호출 실패] ${e.message}`, error: true, provider: p.kind };
  }
}

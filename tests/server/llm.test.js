// LLM 제공자 선택 — 키 없이 PC 모델(OpenAI 호환)로 동작하고, 키가 있으면 Claude 가 우선한다.
// 실제 네트워크 없이 fetchImpl 로 가짜 서버를 끼운다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-llm-'));
process.env.CONDUIT_DATA_DIR = dataDir;
const { Settings } = await import('../../server/store.js');
const llm = await import('../../server/llm.js');
const { setLlm } = await import('../../server/quickstart.js');

const ENV = ['ANTHROPIC_API_KEY', 'CONDUIT_LLM_BASE_URL', 'CONDUIT_LLM_MODEL', 'ANTHROPIC_BASE_URL'];
const saved = {};
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}');
  delete process.env.CONDUIT_LLM_AUTODETECT; // 이 파일은 자동 감지 자체를 시험한다 (가짜 fetch 라 실제 Ollama 는 안 부른다)
  llm.resetProbeCache();
});
afterEach(() => { process.env.CONDUIT_LLM_AUTODETECT = 'off'; for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

/** 가짜 OpenAI 호환 서버 + 가짜 Anthropic — 어떤 주소로 뭘 보냈는지 기록한다 */
function fakeNet({ localModels = ['qwen3:4b', 'gemma3:4b'], localDown = false, ollama = false, thinkingOnly = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
    if (String(url).includes('/v1/models') && !String(url).includes('anthropic')) {
      if (localDown) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ data: localModels.map((id) => ({ id })) }) };
    }
    if (String(url).endsWith('/api/version')) {
      return ollama ? { ok: true, status: 200, json: async () => ({ version: '0.34.2' }) } : { ok: false, status: 404, json: async () => ({}) };
    }
    if (String(url).endsWith('/api/chat')) {
      const message = thinkingOnly ? { role: 'assistant', content: '', thinking: '생각만 하다 끝남' } : { role: 'assistant', content: '올라마 답' };
      return { ok: true, status: 200, json: async () => ({ message, prompt_eval_count: 5, eval_count: 2 }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '<think>속으로 고민</think>로컬 답' } }], usage: { total_tokens: 3 } }) };
    }
    if (String(url).endsWith('/v1/messages')) {
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '클로드 답' }], usage: { input_tokens: 1 } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

describe('getProvider — 고르는 순서', () => {
  it('아무 설정이 없고 Ollama 가 켜져 있으면 자동으로 로컬(선호 모델 우선)', async () => {
    const { fetchImpl } = fakeNet({ localModels: ['qwen3:4b', 'llama3:8b', 'gemma3:4b'] });
    const p = await llm.getProvider({ fetchImpl });
    expect(p).toMatchObject({ kind: 'local', base: 'http://localhost:11434/v1', model: 'gemma3:4b', auto: true }); // 추론 모델(qwen3)보다 바로 답하는 gemma3
  });
  it('아무 설정이 없고 Ollama 도 없으면 null → 시뮬레이션', async () => {
    const { fetchImpl } = fakeNet({ localDown: true });
    expect(await llm.getProvider({ fetchImpl })).toBeNull();
    const r = await llm.callLLM({ prompt: '안녕' }, { fetchImpl });
    expect(r.simulated).toBe(true);
    expect(r.text).toContain('Ollama');
  });
  it('Anthropic 키가 있으면 Ollama 가 켜져 있어도 Claude 가 우선', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const { fetchImpl, calls } = fakeNet();
    const p = await llm.getProvider({ fetchImpl });
    expect(p.kind).toBe('anthropic');
    const r = await llm.callLLM({ prompt: '안녕', system: 'S' }, { fetchImpl });
    expect(r).toMatchObject({ text: '클로드 답', provider: 'anthropic', simulated: false });
    expect(calls.some((c) => c.url.includes('/chat/completions'))).toBe(false);
  });
  it('설정 provider=local 이면 키가 있어도 로컬 — 사용자가 키를 안 쓰기로 한 선택을 존중', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    Settings.set('llm', { provider: 'local' });
    const { fetchImpl } = fakeNet();
    expect((await llm.getProvider({ fetchImpl })).kind).toBe('local');
  });
  it('설정 provider=off 면 항상 시뮬레이션', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    Settings.set('llm', { provider: 'off' });
    expect(await llm.getProvider({ fetchImpl: fakeNet().fetchImpl })).toBeNull();
  });
  it('CONDUIT_LLM_BASE_URL 이 있으면 자동 감지 없이 그 주소 (v1 이 빠져도 붙여 준다)', async () => {
    process.env.CONDUIT_LLM_BASE_URL = 'http://lmstudio:1234';
    process.env.CONDUIT_LLM_MODEL = 'my-model';
    const { fetchImpl, calls } = fakeNet();
    const p = await llm.getProvider({ fetchImpl });
    expect(p).toMatchObject({ kind: 'local', base: 'http://lmstudio:1234/v1', model: 'my-model', auto: false });
    expect(calls).toHaveLength(0); // 감지용 /models 호출 없음
  });
});

describe('callLLM — 로컬(OpenAI 호환) 호출', () => {
  it('system → system 메시지, 이미지 블록 → data URL, <think> 는 걷어낸다', async () => {
    const { fetchImpl, calls } = fakeNet();
    const r = await llm.callLLM({
      system: '너는 검증자',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: '읽어 줘' },
      ] }],
      maxTokens: 77,
    }, { fetchImpl });
    expect(r).toMatchObject({ text: '로컬 답', provider: 'local', model: 'gemma3:4b', simulated: false });
    const call = calls.find((c) => c.url.endsWith('/chat/completions'));
    expect(call.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(call.body.model).toBe('gemma3:4b');
    expect(call.body.max_tokens).toBe(77);
    expect(call.body.messages[0]).toEqual({ role: 'system', content: '너는 검증자' });
    expect(call.body.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: '읽어 줘' },
    ]);
  });
  it('텍스트만 있는 content 는 문자열로 보낸다 (배열을 못 받는 서버 대비)', async () => {
    const { fetchImpl, calls } = fakeNet();
    await llm.callLLM({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] }, { fetchImpl });
    expect(calls.at(-1).body.messages[0].content).toBe('a\nb');
  });
  it('노드가 claude-* 모델을 골랐어도 로컬 모드에서는 로컬 모델로 간다', async () => {
    const { fetchImpl, calls } = fakeNet();
    await llm.callLLM({ prompt: 'x', model: 'claude-sonnet-5' }, { fetchImpl });
    expect(calls.at(-1).body.model).toBe('gemma3:4b');
  });
  it('Ollama 면 네이티브 /api/chat 으로 images 배열 · num_predict 를 보낸다', async () => {
    const { fetchImpl, calls } = fakeNet({ ollama: true });
    const r = await llm.callLLM({
      system: 'S',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: '읽어 줘' },
      ] }],
      maxTokens: 300,
    }, { fetchImpl });
    expect(r).toMatchObject({ text: '올라마 답', provider: 'local', model: 'gemma3:4b', usage: { input_tokens: 5, output_tokens: 2 } });
    const call = calls.find((c) => c.url.endsWith('/api/chat'));
    expect(call.url).toBe('http://localhost:11434/api/chat');
    expect(call.body).toMatchObject({ model: 'gemma3:4b', stream: false, options: { num_predict: 300 } });
    expect(call.body.think).toBeUndefined();
    expect(call.body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: '읽어 줘', images: ['AAAA'] },
    ]);
    expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(false);
  });
  it('추론 모델이 생각만 하다 답이 비면 error + 권장 모델 안내', async () => {
    const { fetchImpl } = fakeNet({ ollama: true, thinkingOnly: true });
    const r = await llm.callLLM({ prompt: 'x' }, { fetchImpl });
    expect(r.error).toBe(true);
    expect(r.text).toContain('gemma3:4b');
  });
  it('서버 오류는 error 로 돌려주고 던지지 않는다', async () => {
    const fetchImpl = async (url) => String(url).includes('/models')
      ? { ok: true, json: async () => ({ data: [{ id: 'm' }] }) }
      : String(url).includes('/api/version') ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: false, status: 500, statusText: 'boom', json: async () => ({ error: { message: 'out of memory' } }) };
    const r = await llm.callLLM({ prompt: 'x' }, { fetchImpl });
    expect(r.error).toBe(true);
    expect(r.text).toContain('out of memory');
  });
});

describe('stripThinking', () => {
  it('닫는 태그만 온 생각도, 정상 블록도 걷어낸다', () => {
    expect(llm.stripThinking('생각생각\n</think>\n\n답')).toBe('답');
    expect(llm.stripThinking('<think>a</think>답')).toBe('답');
    expect(llm.stripThinking('그냥 답')).toBe('그냥 답');
  });
});

describe('setLlm — 화면에서 고르기', () => {
  it('local 을 고르면 서버를 두드려 보고 모델을 정해 저장한다', async () => {
    const { fetchImpl } = fakeNet({ localModels: ['qwen3:4b', 'gemma3:4b'] });
    const r = await setLlm({ provider: 'local' }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(Settings.get('llm')).toMatchObject({ provider: 'local', model: 'gemma3:4b' });
    expect(r.llm).toMatchObject({ provider: 'local', model: 'gemma3:4b', local: { reachable: true } });
  });
  it('Ollama 가 꺼져 있으면 설치 안내와 함께 거절', async () => {
    const r = await setLlm({ provider: 'local' }, { fetchImpl: fakeNet({ localDown: true }).fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Ollama/);
    expect(Settings.get('llm').provider).toBeUndefined();
  });
  it('연결은 되는데 모델이 없으면 pull 명령을 알려 준다', async () => {
    const r = await setLlm({ provider: 'local' }, { fetchImpl: fakeNet({ localModels: [] }).fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ollama pull');
  });
  it('anthropic 은 키가 있어야 고를 수 있다', async () => {
    const no = await setLlm({ provider: 'anthropic' }, { fetchImpl: fakeNet().fetchImpl });
    expect(no.ok).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const yes = await setLlm({ provider: 'anthropic' }, { fetchImpl: fakeNet().fetchImpl });
    expect(yes.ok).toBe(true);
    expect(yes.llm.provider).toBe('anthropic');
  });
  it('describeProvider 는 비밀값을 돌려주지 않는다', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-SECRET';
    const d = await llm.describeProvider({ fetchImpl: fakeNet().fetchImpl });
    expect(JSON.stringify(d)).not.toContain('SECRET');
    expect(d.claude.connected).toBe(true);
  });
});

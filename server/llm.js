// ============================================================
// LLM 브리지 — Anthropic Messages API 호출.
// API 키는 환경변수(ANTHROPIC_API_KEY) 또는 저장된 크리덴셜(type='anthropic')에서 읽는다.
// 키가 없으면 시뮬레이션 응답을 돌려준다(노드가 항상 "동작"하도록).
// nodeTypes 의 AI 노드는 globalThis.__conduitLLM 을 통해 이 함수를 사용한다.
// ============================================================
import { Credentials } from './store.js';

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

export async function callLLM({ system, prompt, model, messages }) {
  const key = getApiKey();
  const useModel = model || 'claude-sonnet-5';

  if (!key) {
    return {
      text: `〔시뮬레이션 · ${useModel}〕 API 키가 없어 실제 호출을 건너뜁니다. 크리덴셜에 anthropic 키를 저장하거나 ANTHROPIC_API_KEY 를 설정하면 실제 응답이 나옵니다.\n프롬프트: ${String(prompt || '').slice(0, 140)}`,
      simulated: true,
    };
  }

  const msgs = messages || [{ role: 'user', content: prompt || '' }];
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 1024,
        system: system || undefined,
        messages: msgs,
      }),
    });
    const data = await res.json();
    if (data.error) return { text: `[Anthropic 오류] ${data.error.message}`, error: true };
    const text = (data.content || []).map((b) => b.text || '').join('');
    return { text, usage: data.usage, simulated: false };
  } catch (e) {
    return { text: `[호출 실패] ${e.message}`, error: true };
  }
}

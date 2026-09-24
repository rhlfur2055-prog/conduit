// 백엔드 API 클라이언트 (Vite 프록시로 동일 출처 호출)
const json = (r) => r.json();

// 서버가 CONDUIT_API_KEY 로 보호될 때 쓰는 키 — 사이드바 "설정"에서 입력, 이 브라우저에만 저장
const KEY_STORAGE = 'conduit:apiKey';
export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* 저장소를 못 쓰면 이번 세션만 키 없이 동작 */ }
}

/** 저장된 키가 있으면 Authorization 헤더를 붙여 요청한다 */
export function authFetch(url, opts = {}) {
  const key = getApiKey();
  const headers = { ...(opts.headers || {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  return fetch(url, { ...opts, headers });
}

const post = (url, body) =>
  authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) =>
  authFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 2xx 가 아니면 서버의 error 메시지로 예외를 던진다.
// (에러 객체가 목록·워크플로 자리에 들어가 화면이 깨지지 않게 — 호출부의 catch 가 처리한다)
async function ok(r) {
  const body = await r.json().catch(() => ({}));
  if (r.ok) return body;
  const hint = r.status === 401 || r.status === 403 ? ' — 사이드바 "설정"에서 API 키를 확인하세요.' : '';
  throw new Error(`${body.error || r.statusText || '요청 실패'} (${r.status})${hint}`);
}

export const api = {
  health: () => fetch('/api/health').then(json),
  run: (workflow) => post('/api/run', workflow).then(ok),
  listWorkflows: () => authFetch('/api/workflows').then(ok),
  getWorkflow: (id) => authFetch('/api/workflows/' + id).then(ok),
  saveWorkflow: (wf) => post('/api/workflows', wf).then(ok),
  deleteWorkflow: (id) => authFetch('/api/workflows/' + id, { method: 'DELETE' }).then(ok),
  listExecutions: () => authFetch('/api/executions').then(ok),
  listCredentials: () => authFetch('/api/credentials').then(ok),
  saveCredential: (cred) => post('/api/credentials', cred).then(ok),
  deleteCredential: (id) => authFetch('/api/credentials/' + id, { method: 'DELETE' }).then(ok),
  listDlq: () => authFetch('/api/dlq').then(ok),
  // 재실행 실패(400 등)는 화면에서 body.error 를 그대로 보여 주므로 예외로 바꾸지 않는다
  replayDlq: (id) => authFetch('/api/dlq/' + id + '/replay', { method: 'POST' }).then(json),
  deleteDlq: (id) => authFetch('/api/dlq/' + id, { method: 'DELETE' }).then(ok),
  listMcpTools: () => authFetch('/api/mcp/tools').then(ok),

  // 쉬운 시작 (specs/005)
  agentStatus: () => authFetch('/api/agent/status').then(ok),
  agentActivity: () => authFetch('/api/agent/activity').then(ok),
  agentQuickstart: () => post('/api/agent/quickstart', {}).then(ok),
  agentClaudeKey: (apiKey) => post('/api/agent/claude-key', { apiKey }).then(ok),
  agentLlmSet: (patch) => put('/api/agent/llm', patch).then(ok),
  agentTelegramToken: (botToken) => post('/api/agent/telegram-token', { botToken }).then(ok),
  agentTelegramAllow: (chatId, asOwner) => post('/api/agent/telegram/allow', { chatId, ...(asOwner ? { asOwner: true } : {}) }).then(ok),
  agentTelegramRemove: (chatId) => post('/api/agent/telegram/remove', { chatId }).then(ok),
  agentTelegramSet: (patch) => put('/api/agent/telegram', patch).then(ok),
  agentHeartbeatEvery: (everyMin) => put('/api/agent/heartbeat', { everyMin }).then(ok),
  runHeartbeat: () => post('/api/heartbeat', {}).then(ok),
  decideApproval: (id, decision) => post(`/api/approvals/${id}/decide`, { decision }).then(ok),
  listTemplates: (lang) => authFetch(`/api/templates${lang ? `?lang=${lang}` : ''}`).then(ok),
  createTemplate: (id, params, lang) => post(`/api/templates/${id}`, { params, lang }).then(ok),
  assistant: (text, lang) => post('/api/assistant', { text, lang }).then(ok),
  people: () => authFetch('/api/people').then(ok),
  savePerson: (id, patch) => put(`/api/people/${id}`, patch).then(ok),
  assistantConfirm: (id, yes) => post(`/api/assistant/confirm/${id}`, { yes }).then(ok),
  agentNotify: (notify) => put('/api/agent/notify', { notify }).then(ok),
  decidePending: (id, approve) => post(`/api/heartbeat/pending/${id}/${approve ? 'approve' : 'reject'}`, {}).then(ok),
};

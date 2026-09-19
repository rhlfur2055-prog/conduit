// 백엔드 API 클라이언트 (Vite 프록시로 동일 출처 호출)
const json = (r) => r.json();

export const api = {
  health: () => fetch('/api/health').then(json),
  run: (workflow) =>
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    }).then(json),
  listWorkflows: () => fetch('/api/workflows').then(json),
  getWorkflow: (id) => fetch('/api/workflows/' + id).then(json),
  saveWorkflow: (wf) =>
    fetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wf),
    }).then(json),
  deleteWorkflow: (id) => fetch('/api/workflows/' + id, { method: 'DELETE' }).then(json),
  listExecutions: () => fetch('/api/executions').then(json),
  listCredentials: () => fetch('/api/credentials').then(json),
  saveCredential: (cred) =>
    fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    }).then(json),
  deleteCredential: (id) => fetch('/api/credentials/' + id, { method: 'DELETE' }).then(json),
  listDlq: () => fetch('/api/dlq').then(json),
  replayDlq: (id) => fetch('/api/dlq/' + id + '/replay', { method: 'POST' }).then(json),
  deleteDlq: (id) => fetch('/api/dlq/' + id, { method: 'DELETE' }).then(json),
  listMcpTools: () => fetch('/api/mcp/tools').then(json),
};

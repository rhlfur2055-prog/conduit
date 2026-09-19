// ============================================================
// Conduit HTTP 클라이언트 — Conduit 서버의 /mcp (JSON-RPC over HTTP) 를 호출한다.
// 이 패키지는 stdio ↔ HTTP 다리일 뿐, 도구 정의(어떤 워크플로가 어떤 도구인지)는
// Conduit 서버 한 곳에만 둔다.
// ============================================================

export class ConduitError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'ConduitError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.url]      Conduit 서버 주소 (기본 http://localhost:8787)
 * @param {string} [opts.apiKey]   서버의 CONDUIT_API_KEY 와 같은 값 (서버에 키가 설정된 경우)
 * @param {typeof fetch} [opts.fetchImpl]  테스트용 fetch 대체
 */
export function createConduitClient({ url = 'http://localhost:8787', apiKey = '', fetchImpl = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  let nextId = 1;

  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      const why = e?.cause?.code || e?.code || e?.message || String(e);
      throw new ConduitError(
        `Conduit 서버에 연결할 수 없습니다: ${base} (${why}). 서버가 켜져 있는지, CONDUIT_URL 이 맞는지 확인하세요.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      const b = await res.json().catch(() => ({}));
      throw new ConduitError(
        `Conduit 인증 실패 (${res.status}): ${b.error || ''} CONDUIT_API_KEY 를 서버의 키와 같은 값으로 설정하세요.`.replace(/\s+/g, ' ').trim(),
        { status: res.status },
      );
    }
    if (!res.ok) throw new ConduitError(`Conduit 응답 오류 (${res.status})`, { status: res.status });
    return res.json();
  }

  /** Conduit /mcp 에 JSON-RPC 요청을 보내고 result 를 돌려준다 (error 면 예외) */
  async function rpc(method, params = {}) {
    const msg = await post('/mcp', { jsonrpc: '2.0', id: nextId++, method, params });
    if (msg.error) throw new ConduitError(msg.error.message || 'Conduit 오류', { code: msg.error.code });
    return msg.result;
  }

  /** /api/health — 인증 없이 열려 있어 연결·인증 방식 확인용 */
  async function health() {
    const res = await fetchImpl(`${base}/api/health`);
    if (!res.ok) throw new ConduitError(`헬스체크 실패 (${res.status})`, { status: res.status });
    return res.json();
  }

  return { base, rpc, health };
}

// ============================================================
// 재시도 정책 — 노드 카테고리별 상한/백오프/제외 코드
// 엔진과 UI가 공유한다.
// ============================================================

export const RETRY_PROFILES = {
  http:    { maxRetries: 3, baseMs: 1000, factor: 2, capMs: 30000 },
  llm:     { maxRetries: 5, baseMs: 2000, factor: 2, capMs: 60000 },
  email:   { maxRetries: 2, baseMs: 1500, factor: 2, capMs: 15000 },
  webhook: { maxRetries: 4, baseMs: 1000, factor: 2, capMs: 30000 },
  none:    { maxRetries: 0, baseMs: 0,    factor: 1, capMs: 0 },
};

// 노드 kind → 프로필
const KIND_PROFILE = {
  httpRequest: 'http', httpAuth: 'http',
  slack: 'http', notion: 'http', youtube: 'http', naver: 'http', hotTopics: 'http',
  gmail: 'email', sendEmail: 'email',
  ai: 'llm', aiAgent: 'llm', aiExtract: 'llm', loopRefine: 'llm',
  manualTrigger: 'none', webhookTrigger: 'none', scheduleTrigger: 'none',
  stopError: 'none',
};

export function profileFor(kind) {
  return RETRY_PROFILES[KIND_PROFILE[kind] || 'none'];
}

// 재시도하면 안 되는(영구) 에러 — 4xx 로직 오류·인증 오류
const PERMANENT = [400, 401, 403, 404, 422, 550];
// 재시도해도 되는(일시) 에러
const TRANSIENT_CODES = [408, 425, 429, 500, 502, 503, 504, 529];
const TRANSIENT_NET = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'fetch failed'];

/** 에러 메시지/코드에서 재시도 가능 여부 판정 */
export function isRetryable(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status ?? Number((msg.match(/\b(\d{3})\b/) || [])[1]);

  if (PERMANENT.includes(status)) return false;
  if (TRANSIENT_CODES.includes(status)) return true;
  if (TRANSIENT_NET.some((n) => msg.includes(n))) return true;
  // JSON 파싱 오류 등 결정적 실패는 재시도 무의미
  if (/JSON|SyntaxError|is not a function|undefined/i.test(msg)) return false;
  return false;
}

/** 지수 백오프 + ±20% 지터 */
export function backoffMs(attempt, p) {
  const raw = Math.min(p.capMs, p.baseMs * Math.pow(p.factor, attempt));
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

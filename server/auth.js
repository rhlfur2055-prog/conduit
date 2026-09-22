// ============================================================
// API 인증 — /api/* 와 /mcp 를 보호한다.
//
//   CONDUIT_API_KEY 가 설정돼 있으면: 요청에 키가 있어야 통과 (없거나 틀리면 401)
//     Authorization: Bearer <키>   또는   X-API-Key: <키>
//   설정돼 있지 않으면: 이 컴퓨터(127.0.0.1)에서 온 요청만 통과 (그 외 403)
//
// 코드 노드는 임의 JavaScript 를 실행하므로, 인증 없이 외부에 열리면
// 누구나 서버에서 코드를 실행할 수 있다. 그래서 키가 없을 때의 기본값을
// "전부 허용"이 아니라 "로컬만 허용"으로 둔다.
// ============================================================
import crypto from 'node:crypto';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 로컬 전용 모드에서 허용하는 Host 헤더 — 공격자 도메인이 127.0.0.1 로 풀리는 DNS 리바인딩은 Host 가 달라서 걸린다
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * 이 컴퓨터에서 직접 온 요청인가.
 * 같은 서버의 리버스 프록시(Nginx 등)를 거치면 주소가 127.0.0.1 로 보이므로,
 * X-Forwarded-For 가 붙은 요청은 로컬로 치지 않는다.
 */
export function isLoopback(req) {
  if (req.headers?.['x-forwarded-for']) return false;
  return LOOPBACK.has(req.socket?.remoteAddress);
}

/** Authorization: Bearer <키> 우선, 없으면 X-API-Key */
export function extractKey(req) {
  const auth = req.headers?.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return String(req.headers?.['x-api-key'] || '').trim();
}

/** 길이·내용에 따라 걸리는 시간이 달라지지 않는 비교 (타이밍 공격 방지) */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 현재 인증 방식 — 헬스체크 응답에서 프론트가 키 입력이 필요한지 판단하는 데 쓴다 */
export function authMode(getKey = () => process.env.CONDUIT_API_KEY) {
  return getKey() ? 'api-key' : 'local-only';
}

/**
 * Express 미들웨어. 키는 요청마다 읽으므로 서버 재시작 없이 환경변수 변경이 반영된다.
 * @param {{ getKey?: () => string | undefined }} [opts]
 */
export function requireApiKey({ getKey = () => process.env.CONDUIT_API_KEY } = {}) {
  return (req, res, next) => {
    const expected = getKey();

    if (!expected) {
      const host = String(req.headers?.host || '');
      if (isLoopback(req) && (!host || LOCAL_HOST.test(host))) return next();
      return res.status(403).json({
        error: 'CONDUIT_API_KEY 가 설정되지 않아 이 컴퓨터(127.0.0.1)에서 온 요청만 허용됩니다.',
      });
    }

    const given = extractKey(req);
    if (given && safeEqual(given, expected)) return next();

    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({
      error: 'API 키가 필요합니다. Authorization: Bearer <키> 또는 X-API-Key 헤더로 보내세요.',
    });
  };
}

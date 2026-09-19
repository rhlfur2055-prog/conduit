// ============================================================
// 웹훅 서명 검증 — raw body 기준 HMAC, 상수시간 비교, 리플레이 윈도우
// 시크릿은 크리덴셜(AES-256-GCM)에 type='webhook' 으로 저장.
// ============================================================
import crypto from 'node:crypto';
import { Credentials } from './store.js';

const REPLAY_WINDOW_SEC = 300; // ±5분

function getSecret(name) {
  const list = Credentials.all().filter((c) => c.type === 'webhook');
  const c = name ? list.find((x) => x.name === name) : list[0];
  if (!c) return null;
  try {
    const d = Credentials.reveal(c.id);
    return d.secret || d.token || null;
  } catch {
    return null;
  }
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const hmac = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

/**
 * @param {'none'|'slack'|'github'|'stripe'|'generic'} scheme
 * @returns {{ok:true} | {ok:false, status:number, reason:string}}
 */
export function verifySignature(scheme, { headers, rawBody, credentialName }) {
  if (!scheme || scheme === 'none') return { ok: true };

  const secret = getSecret(credentialName);
  if (!secret) return { ok: false, status: 401, reason: 'webhook 시크릿 크리덴셜이 없습니다' };

  const now = Math.floor(Date.now() / 1000);

  if (scheme === 'slack') {
    const sig = headers['x-slack-signature'];
    const ts = Number(headers['x-slack-request-timestamp']);
    if (!sig || !ts) return { ok: false, status: 401, reason: '서명 헤더 누락' };
    if (Math.abs(now - ts) > REPLAY_WINDOW_SEC) return { ok: false, status: 403, reason: '타임스탬프 윈도우 초과(리플레이)' };
    const expected = 'v0=' + hmac(secret, `v0:${ts}:${rawBody}`);
    return timingSafeEq(sig, expected) ? { ok: true } : { ok: false, status: 401, reason: '서명 불일치' };
  }

  if (scheme === 'github') {
    const sig = headers['x-hub-signature-256'];
    if (!sig) return { ok: false, status: 401, reason: '서명 헤더 누락' };
    const expected = 'sha256=' + hmac(secret, rawBody);
    return timingSafeEq(sig, expected) ? { ok: true } : { ok: false, status: 401, reason: '서명 불일치' };
  }

  if (scheme === 'stripe') {
    const header = headers['stripe-signature'] || '';
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())));
    const ts = Number(parts.t);
    const v1 = parts.v1;
    if (!ts || !v1) return { ok: false, status: 400, reason: '서명 헤더 형식 오류' };
    if (Math.abs(now - ts) > REPLAY_WINDOW_SEC) return { ok: false, status: 403, reason: '타임스탬프 윈도우 초과(리플레이)' };
    const expected = hmac(secret, `${ts}.${rawBody}`);
    return timingSafeEq(v1, expected) ? { ok: true } : { ok: false, status: 401, reason: '서명 불일치' };
  }

  // generic: X-Signature: sha256=<hex>  또는 <hex>
  const raw = headers['x-signature'] || headers['x-hub-signature'] || '';
  if (!raw) return { ok: false, status: 401, reason: '서명 헤더 누락' };
  const provided = raw.includes('=') ? raw.split('=').pop() : raw;
  return timingSafeEq(provided, hmac(secret, rawBody))
    ? { ok: true }
    : { ok: false, status: 401, reason: '서명 불일치' };
}

/** 멱등 키: provider 이벤트 id 우선, 없으면 body 해시 (시간 미포함) */
export function idempotencyKey({ headers, body, rawBody, path }) {
  const providerId =
    headers['x-github-delivery'] ||
    headers['stripe-idempotency-key'] ||
    headers['x-idempotency-key'] ||
    body?.event_id ||
    body?.id ||
    body?.data?.id ||
    null;
  if (providerId) return `${path}:${providerId}`;
  return `${path}:${crypto.createHash('sha256').update(String(rawBody || '')).digest('hex').slice(0, 32)}`;
}

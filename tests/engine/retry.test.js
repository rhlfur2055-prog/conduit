import { describe, it, expect, afterEach, vi } from 'vitest';
import { RETRY_PROFILES, profileFor, isRetryable, backoffMs } from '../../src/engine/retry.ts';

afterEach(() => vi.restoreAllMocks());

describe('profileFor — 노드 종류별 재시도 정책', () => {
  it('카테고리 매핑', () => {
    expect(profileFor('httpRequest')).toBe(RETRY_PROFILES.http);
    expect(profileFor('aiAgent')).toBe(RETRY_PROFILES.llm);
    expect(profileFor('gmail')).toBe(RETRY_PROFILES.email);
  });

  it('모르는 노드는 재시도하지 않는다', () => {
    expect(profileFor('code')).toBe(RETRY_PROFILES.none);
    expect(profileFor('nope')).toBe(RETRY_PROFILES.none);
  });
});

describe('isRetryable — 일시 오류만 재시도', () => {
  it('429·5xx 는 재시도', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it('4xx 로직·인증 오류는 재시도하지 않는다', () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryable({ status })).toBe(false);
  });

  it('상태 코드가 메시지에만 있어도 판정한다', () => {
    expect(isRetryable(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(isRetryable(new Error('HTTP 404 Not Found'))).toBe(false);
  });

  it('네트워크 오류는 재시도', () => {
    expect(isRetryable(new Error('read ECONNRESET'))).toBe(true);
    expect(isRetryable(new Error('fetch failed'))).toBe(true);
  });

  it('JSON 파싱처럼 결정적인 실패나 알 수 없는 오류는 재시도하지 않는다', () => {
    expect(isRetryable(new SyntaxError('Unexpected token < in JSON'))).toBe(false);
    expect(isRetryable(new Error('something odd'))).toBe(false);
  });
});

describe('backoffMs — 지수 백오프 + ±20% 지터', () => {
  it('지터가 0 이면 base × factor^attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffMs(0, RETRY_PROFILES.http)).toBe(1000);
    expect(backoffMs(1, RETRY_PROFILES.http)).toBe(2000);
    expect(backoffMs(2, RETRY_PROFILES.http)).toBe(4000);
  });

  it('상한(capMs)을 넘지 않는다', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(backoffMs(10, RETRY_PROFILES.http)).toBe(30000);
  });

  it('지터는 ±20% 범위', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(backoffMs(0, RETRY_PROFILES.http)).toBe(1200);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffMs(0, RETRY_PROFILES.http)).toBe(800);
  });

  it('none 프로필은 대기 없음', () => {
    expect(backoffMs(3, RETRY_PROFILES.none)).toBe(0);
  });
});

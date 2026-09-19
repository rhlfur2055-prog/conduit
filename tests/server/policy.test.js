import { describe, it, expect } from 'vitest';
import { codeExecutionAllowed } from '../../server/policy.js';
import { agentToolNames } from '../../server/agent.js';

describe('codeExecutionAllowed — 서버에서 사용자 코드를 돌릴지', () => {
  it('키가 없으면(로컬 전용 서버) 기본 켜짐', () => {
    expect(codeExecutionAllowed({})).toBe(true);
  });

  it('키가 있으면(외부에 연 서버) 기본 꺼짐', () => {
    expect(codeExecutionAllowed({ CONDUIT_API_KEY: 'k' })).toBe(false);
  });

  it('CONDUIT_ALLOW_CODE 로 직접 지정하면 그 값을 따른다', () => {
    expect(codeExecutionAllowed({ CONDUIT_API_KEY: 'k', CONDUIT_ALLOW_CODE: 'true' })).toBe(true);
    expect(codeExecutionAllowed({ CONDUIT_API_KEY: 'k', CONDUIT_ALLOW_CODE: '1' })).toBe(true);
    expect(codeExecutionAllowed({ CONDUIT_ALLOW_CODE: 'false' })).toBe(false);
    expect(codeExecutionAllowed({ CONDUIT_ALLOW_CODE: ' FALSE ' })).toBe(false);
  });

  it('알 수 없는 값이면 기본 규칙', () => {
    expect(codeExecutionAllowed({ CONDUIT_ALLOW_CODE: 'maybe' })).toBe(true);
    expect(codeExecutionAllowed({ CONDUIT_API_KEY: 'k', CONDUIT_ALLOW_CODE: 'maybe' })).toBe(false);
  });
});

describe('agentToolNames — 에이전트에게 보여 줄 도구', () => {
  it('코드 실행이 꺼지면 run_code 를 뺀다', () => {
    expect(agentToolNames(['run_code', 'http_get'], { allowCode: false })).toEqual(['http_get']);
    expect(agentToolNames([], { allowCode: false })).not.toContain('run_code');
  });

  it('켜져 있으면 그대로, 없는 도구 이름은 뺀다', () => {
    expect(agentToolNames(['run_code', 'http_get', 'nope'], { allowCode: true })).toEqual(['run_code', 'http_get']);
    expect(agentToolNames(undefined, { allowCode: true })).toContain('run_code');
  });
});

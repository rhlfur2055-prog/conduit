// ============================================================
// 실행 정책 — 서버에서 임의 코드 실행을 허용할지.
//
// 서버에서 사용자 JS 가 실행되는 입구는 세 곳이다:
//   ① 코드 노드  ② {{ }} 표현식  ③ AI 에이전트의 run_code 도구
// 셋 중 하나만 막으면 나머지로 똑같은 일을 할 수 있으므로, 스위치 하나로 함께 끈다.
//
//   CONDUIT_ALLOW_CODE=true|false 로 직접 지정할 수 있고,
//   지정하지 않으면 CONDUIT_API_KEY 가 있을 때(= 외부에 연 서버) 꺼진다.
// ============================================================

/** @param {Record<string, string | undefined>} [env] */
export function codeExecutionAllowed(env = process.env) {
  const v = String(env.CONDUIT_ALLOW_CODE ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return !env.CONDUIT_API_KEY;
}

/** runFlow 에 넘길 정책 객체 — 요청마다 새로 읽어 재시작 없이 반영된다 */
export function currentPolicy(env = process.env) {
  return { allowCode: codeExecutionAllowed(env) };
}

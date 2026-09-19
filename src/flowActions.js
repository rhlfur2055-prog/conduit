import { createContext } from 'react';

// 커스텀 노드에서 실행/삭제/복제 등 캔버스 액션을 호출하기 위한 컨텍스트.
// 노드 data 에 함수를 넣지 않고 컨텍스트로 주입해 직렬화(저장)를 깨끗하게 유지한다.
export const FlowActions = createContext({
  run: () => {},
  remove: () => {},
  duplicate: () => {},
});

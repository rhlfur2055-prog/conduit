// ============================================================
// 자동 승인 게이트 — "AI 가 만든 값이 밖으로 나가는 경로에는 승인이 있어야 한다" 를 그래프로 판정한다.
//
//   승인 노드를 캔버스에 놓는 것은 사용자의 선택이다. 놓지 않으면 AI 초안이 그대로 나간다.
//   이 모듈은 그 선택을 정책으로 바꾼다: 발송 노드(sends) 로 들어오는 경로 위에 모델 출력 노드(llm) 가 있고,
//   그 사이에 승인 노드(approvalRequest) 나 이미 승인된 게이트가 없으면 "보호되지 않은 경로" 다.
//   실행기는 그 발송 노드 앞에서 스스로 멈추고 사람에게 묻는다. 데이터에 표시를 달아 추적하는 방식이 아니라
//   그래프를 보는 방식이라, 코드 노드가 필드를 지워도 판정이 흔들리지 않고 저장 시점에 미리 경고할 수도 있다.
// ============================================================

import { NODE_TYPES } from './nodeTypes.ts';
import type { FlowEdge, FlowNode, NodeDefinition, NodeParams } from './types.ts';

export type GateMode = 'auto' | 'off';

/** 발송 노드 판정 — 정의의 sends 가 함수면 해석된 params 로 정한다 (GET 요청은 발송이 아니다) */
export function nodeSends(def: NodeDefinition | undefined, params: NodeParams | undefined): boolean {
  if (!def?.sends) return false;
  return typeof def.sends === 'function' ? def.sends(params ?? {}) : true;
}

export interface UnguardedPath {
  /** 발송 노드 id */
  target: string;
  /** 경로 위의 모델 출력 노드 id (여러 개면 전부) */
  sources: string[];
}

/**
 * 발송 노드 target 으로 들어오는 경로를 거꾸로 따라가며 모델 출력 노드를 찾는다.
 * 승인 노드(approvalRequest)와 이미 승인된 게이트(guarded)는 경로를 끊는다.
 */
export function unguardedSources(
  target: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
  guarded: ReadonlySet<string> = new Set(),
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const found = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of edges) {
      if (e.target !== id) continue;
      const src = e.source;
      if (seen.has(src)) continue;
      seen.add(src);
      const kind = byId.get(src)?.data.kind;
      if (!kind) continue;
      if (kind === 'approvalRequest' || guarded.has(src)) continue;   // 여기서 끊긴다 — 그 위쪽은 이미 사람이 본 것
      if (NODE_TYPES[kind]?.llm) found.add(src);
      stack.push(src);
    }
  }
  return [...found];
}

/**
 * 워크플로 전체를 훑어 보호되지 않은 발송 노드를 나열한다. 저장 시점의 경고(lint)와 실행기의 판정이 같은 함수를 쓴다.
 * params 는 저장된 값(표현식 해석 전)이라, sends 가 함수인 노드는 method 같은 정적인 필드만 본다.
 */
export function analyzeGates(nodes: FlowNode[], edges: FlowEdge[], guarded: ReadonlySet<string> = new Set()): UnguardedPath[] {
  const out: UnguardedPath[] = [];
  for (const n of nodes) {
    const def = NODE_TYPES[n.data.kind];
    if (!nodeSends(def, n.data.params)) continue;
    if (guarded.has(n.id)) continue;
    const sources = unguardedSources(n.id, nodes, edges, guarded);
    if (sources.length) out.push({ target: n.id, sources });
  }
  return out;
}

// ============================================================
// 엔진 코어의 데이터 모양 — 브라우저(미리 보기)와 서버(실제 실행)가 같은 타입을 본다.
//
//   Item        노드 사이를 흐르는 한 건. n8n 처럼 평범한 객체다.
//   PortOutputs 노드 출력 = 포트 이름 → 아이템 배열 (undefined 면 그 경로로 흐르지 않음)
//   NodeResult  실행 엔진이 노드마다 남기는 결과 (승인 대기 스냅샷의 재료)
//
// 서버 JS 에서는 `/** @type {import('../src/engine/types.ts').NodeResult} */` 로 가져다 쓴다.
// ============================================================

/** 노드 사이를 흐르는 아이템 하나. 필드 값은 노드가 정하므로 unknown. */
export type Item = Record<string, unknown>;

/** 포트 하나의 값. 빈 배열은 엔진이 undefined 로 바꾼다 (= 흐르지 않음). */
export type PortValue = Item[] | undefined;

/** 노드 출력: 포트 이름 → 아이템 배열 */
export type PortOutputs = Record<string, PortValue>;

/** 노드 설정값. 표현식({{ }})은 엔진이 run 전에 해석해서 넘긴다. */
export type NodeParams = Record<string, any>;

/**
 * 노드 run 에 들어오는 입력. 포트 이름 → 값.
 *   아이템 모드(기본): 포트마다 아이템 하나
 *   배치 모드(mode:'batch'): 포트마다 아이템 배열
 * 모드에 따라 모양이 달라서 any — 노드 구현이 자기 모드를 알고 읽는다.
 */
export type NodeInputs = Record<string, any>;

/** 노드 run 의 반환: 포트 이름 → 아이템 | 아이템 배열 | undefined. `__wait` 는 승인 대기 신호. */
export type NodeOutput = Record<string, unknown>;

/** 캔버스의 노드 (React Flow 노드와 호환) */
export interface FlowNode {
  id: string;
  data: { kind: string; params?: NodeParams; [key: string]: unknown };
  [key: string]: unknown;
}

/** 캔버스의 연결선 */
export interface FlowEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
}

export type FieldType = 'text' | 'textarea' | 'select';

/** 인스펙터에 그려지는 설정 칸 하나 */
export interface NodeField {
  key: string;
  label: string;
  type: FieldType;
  options?: readonly string[];
}

/** 노드 run 이 받는 실행 문맥 — 표현식의 $json/$items 와 같은 값 */
export interface NodeContext {
  $json: Item;
  $items: Item[];
  $index: number;
  /** 실행 시작 시각(ISO) — 한 실행 안에서는 모든 노드가 같은 값을 본다 */
  $now: string;
  $results: Map<string, NodeResult>;
  $flow: { nodes: FlowNode[]; edges: FlowEdge[] };
  $meta: Record<string, unknown>;
  $nodeId: string;
  /** 서버에서 코드 실행이 꺼져 있으면 표현식은 데이터 경로만 허용 */
  safeExpressions: boolean;
  onAgentStep?: (step: unknown) => void;
}

/** 노드 타입 정의 — NODE_TYPES 레지스트리의 값 */
export interface NodeDefinition {
  title: string;
  icon?: string;
  color?: string;
  category: string;
  /** 실제 연동에 서버가 필요한 노드. 브라우저에서는 시뮬레이션 결과를 낸다. */
  backend?: boolean;
  /** 'batch' 면 아이템 배열 전체를 한 번에 받는다 (Merge/Aggregate/Sort…). 기본은 아이템마다 반복. */
  mode?: 'item' | 'batch';
  inputs: string[];
  outputs: string[];
  defaults: NodeParams;
  fields: NodeField[];
  summary?: (params: NodeParams) => string;
  run: (inputs: NodeInputs, params: NodeParams, ctx: NodeContext) => Promise<NodeOutput | undefined>;
}

/** 노드 실행이 끝난 뒤의 상태 */
export type RunStatus = 'done' | 'skip' | 'error' | 'failedContinue' | 'waiting';

/** 화면에 보이는 상태 — 실행 중·재시도 중 포함 */
export type NodeStatus = RunStatus | 'running' | 'retrying';

/** 승인 대기 신호. 노드가 { __wait: WaitRequest } 를 내면 엔진이 그 노드에서 멈춘다. */
export interface WaitRequest {
  approvalId: string | null;
  channel?: string;
  simulated?: boolean;
  note?: string;
}

/** 엔진이 노드마다 남기는 결과. 승인 대기 스냅샷은 이 Map 을 그대로 저장한다. */
export interface NodeResult {
  status: RunStatus;
  output: PortOutputs;
  input: Item[] | undefined;
  attempts?: number;
  failedItems?: number;
  wait?: WaitRequest[];
}

/** 실패한 아이템 하나가 DLQ 로 갈 때의 기록 */
export interface DeadLetter {
  nodeId: string;
  nodeKind: string;
  nodeTitle: string;
  /** 아이템 모드에서만 — 몇 번째 아이템이었나 */
  itemKey?: string;
  payload: unknown;
  errorCode: string | number;
  errorMsg: string;
  attempts: number;
}

export type LogKind = 'info' | 'ok' | 'err' | 'skip';

export interface LogEntry {
  kind: LogKind;
  msg: string;
}

/** onStatus 콜백에 함께 오는 상세 */
export interface StatusDetail {
  output?: PortOutputs;
  input?: Item[];
  error?: string;
  wait?: WaitRequest[];
}

/** 외부 주입(웹훅 페이로드·승인 재개): 노드 id → 포트 → 값. 주입된 노드는 실행하지 않는다. */
export type Seed = Record<string, Record<string, unknown> | undefined>;

export interface RunFlowOptions {
  onStatus?: (nodeId: string, status: NodeStatus, detail?: StatusDetail) => void;
  onLog?: (entry: LogEntry) => void;
  seed?: Seed;
  onAgentStep?: (nodeId: string, step: unknown) => void;
  onDeadLetter?: (entry: DeadLetter) => void;
  onItemProgress?: (nodeId: string, completed: number, total: number) => void;
  /** 서버가 넘기는 실행 정책. 브라우저(내 컴퓨터)에서는 생략 → 전부 허용. */
  policy?: { allowCode?: boolean };
  /** 실행 메타(workflowId 등) — 노드 ctx.$meta 로 전달 */
  meta?: Record<string, unknown>;
}

/** 재시도 정책 — 노드 카테고리별 상한/백오프 */
export interface RetryProfile {
  maxRetries: number;
  baseMs: number;
  factor: number;
  capMs: number;
}

/** 노드가 던지는 오류. status 는 HTTP 코드처럼 재시도 여부 판정에 쓰이고, __attempts 는 엔진이 채운다. */
export type RunError = Error & { status?: number | string; __attempts?: number };

/** 표현식 해석 문맥 — NodeContext 의 부분집합 */
export interface ExprContext {
  $json?: Item;
  $items?: Item[];
  $index?: number;
  $now?: string;
  safeExpressions?: boolean;
}

// ---- 서버가 globalThis 로 주입하는 브리지 ----
// 브라우저에는 없으므로 전부 optional. 없으면 노드는 시뮬레이션 결과를 낸다.

export interface LLMArgs {
  system?: string;
  prompt?: string;
  model?: string;
  messages?: unknown[];
}

export interface LLMResult {
  text: string;
  model?: string;
  provider?: string;
  simulated?: boolean;
  usage?: unknown;
}

export type IntegrationBridge = Record<string, (args: any) => Promise<any>>;

declare global {
  // eslint-disable-next-line no-var
  var __conduitLLM: ((args: LLMArgs) => Promise<LLMResult>) | undefined;
  // eslint-disable-next-line no-var
  var __conduitIntegrations: IntegrationBridge | undefined;
  // eslint-disable-next-line no-var
  var __conduitAgent: ((args: any) => Promise<any>) | undefined;
}

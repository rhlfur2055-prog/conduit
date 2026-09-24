// ============================================================
// 실행 엔진 — 위상 정렬 → 노드별 실행. 표현식 해석 + 입/출력 캡처(NDV).
// ============================================================

import { NODE_TYPES, callIntegration } from './nodeTypes.ts';
import { nodeSends, unguardedSources } from './gates.ts';
import { resolveParams } from './expr.ts';
import { profileFor, isRetryable, backoffMs } from './retry.ts';
import { toItems, emptyToUndefined, firstItem, countItems, chunk } from './items.ts';
import type {
  FlowNode, FlowEdge, Item, NodeContext, NodeInputs, NodeOutput, NodeResult,
  PortOutputs, RunError, RunFlowOptions, RunStatus, WaitRequest,
} from './types.ts';

/** 자동 게이트가 사람에게 보여 줄 본문 — AI 노드가 남긴 대표 필드가 있으면 그것, 없으면 아이템 전체(잘라서) */
const AI_TEXT_FIELDS = ['draft', 'aiText', 'agentResult', 'refined', 'text', 'extracted', 'reading', 'screen'];
function gatePreview(items: Item[]): string {
  const first = items[0] ?? {};
  for (const f of AI_TEXT_FIELDS) {
    const v = first[f];
    if (v === undefined || v === null || v === '') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return items.length > 1 ? `${s}\n\n(외 ${items.length - 1}건)` : s;
  }
  const s = JSON.stringify(first);
  return (items.length > 1 ? `${s}\n\n(외 ${items.length - 1}건)` : s).slice(0, 1500);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function topoSort(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => { indeg.set(n.id, 0); adj.set(n.id, []); });
  edges.forEach((e) => {
    if (adj.has(e.source) && indeg.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      indeg.set(e.target, indeg.get(e.target)! + 1);
    }
  });
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: FlowNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(nodes.find((n) => n.id === id)!);
    for (const to of adj.get(id)!) {
      indeg.set(to, indeg.get(to)! - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  if (order.length !== nodes.length) throw new Error('cycle');
  return order;
}

const truncate = (s: string, n: number) => (s && s.length > n ? s.slice(0, n) + '…' : s);
const nowISO = () => new Date().toISOString();

// 사용자 JS 를 그대로 실행하는 노드 — 정책상 코드 실행이 꺼져 있으면 돌리지 않는다
const CODE_NODES = new Set(['code']);

/** 아이템 하나의 실행 결과 — 성공이면 출력, 실패면 오류와 그 아이템 */
type Settled =
  | { ok: true; output: NodeOutput | undefined }
  | { ok: false; err: RunError; item: Item; index: number };

/**
 * 워크플로 실행. 노드마다 NodeResult 를 남긴 Map 을 돌려준다.
 * 승인 대기(waiting)에서 멈춘 실행은 그 Map 을 스냅샷으로 저장했다가 seed 로 주입해 재개한다.
 */
export async function runFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  {
    onStatus = () => {}, onLog = () => {}, seed = {}, onAgentStep = () => {},
    onDeadLetter = () => {}, onItemProgress = () => {}, policy = {}, meta = {}, gates = {},
  }: RunFlowOptions = {},
): Promise<Map<string, NodeResult>> {
  const allowCode = policy.allowCode !== false;
  const gateMode = policy.aiGate ?? 'auto';
  // 이 실행에서 이미 사람이 승인한 발송 노드 — 그 아래 경로는 다시 묻지 않는다
  const guarded = new Set(Object.keys(gates.approved ?? {}));
  const results = new Map<string, NodeResult>();
  onLog({ kind: 'info', msg: '워크플로 실행 시작…' });

  let order: FlowNode[];
  try {
    order = topoSort(nodes, edges);
  } catch {
    onLog({ kind: 'err', msg: '순환 연결이 있어 실행할 수 없어요.' });
    return results;
  }

  const started = nowISO();
  const blocked = new Set<string>();   // 사람 승인 대기 중인 노드와 그 아래 노드들

  for (const node of order) {
    const def = NODE_TYPES[node.data.kind];
    if (!def) continue;

    // 외부 주입(웹훅/스케줄 페이로드) — 실행하지 않고 주어진 출력을 사용
    if (seed && seed[node.id] !== undefined) {
      const raw = seed[node.id];
      const output: PortOutputs = {};
      for (const [port, value] of Object.entries(raw || {})) output[port] = emptyToUndefined(toItems<Item>(value as Item | Item[]));
      results.set(node.id, { status: 'done', output, input: undefined });
      onStatus(node.id, 'done', { output, input: undefined, injected: true });
      onLog({ kind: 'ok', msg: `● ${def.title} — ${countItems(output.main)}건 주입` });
      continue;
    }

    // 승인 대기 노드 아래는 전부 건너뛴다 — 입력이 여럿인 노드(Merge 등)가 반쪽 입력으로 돌면 안 된다
    if (edges.some((e) => e.target === node.id && blocked.has(e.source))) {
      blocked.add(node.id);
      results.set(node.id, { status: 'skip', output: {}, input: undefined });
      onStatus(node.id, 'skip');
      onLog({ kind: 'skip', msg: `⤵ ${def.title} — 건너뜀 (승인 대기 중)` });
      continue;
    }

    // 입력 수집 — 모든 포트 값은 아이템 배열로 정규화된다
    const inputs: Record<string, Item[]> = {};
    let hasIncoming = false;
    let gotData = false;
    for (const port of def.inputs) {
      const edge = edges.find((e) => e.target === node.id && (e.targetHandle || 'main') === port);
      if (edge) {
        hasIncoming = true;
        const val = results.get(edge.source)?.output?.[edge.sourceHandle || 'main'];
        const items = toItems(val);
        if (items.length) { inputs[port] = items; gotData = true; }
      }
    }

    if (hasIncoming && !gotData) {
      results.set(node.id, { status: 'skip', output: {}, input: undefined });
      onStatus(node.id, 'skip');
      onLog({ kind: 'skip', msg: `⤵ ${def.title} — 건너뜀 (입력 없음)` });
      continue;
    }

    // ---- 자동 승인 게이트: AI 출력이 승인 없이 발송 노드로 흘러들면 여기서 멈춘다 (정책 · src/engine/gates.ts) ----
    const rejectedGate = gates.rejected?.[node.id];
    if (rejectedGate) {
      results.set(node.id, { status: 'skip', output: {}, input: undefined });
      onStatus(node.id, 'skip');
      onLog({ kind: 'skip', msg: `⤵ ${def.title} — 자동 게이트에서 ${rejectedGate.decision === 'expired' ? '만료' : '거절'}됨${rejectedGate.by ? ` (${rejectedGate.by})` : ''} · 보내지 않음` });
      continue;
    }
    const approvedGate = gates.approved?.[node.id];
    if (approvedGate) {
      // 승인된 발송: 들어오는 아이템마다 approval 을 달아 준다 (승인 노드가 하는 것과 같은 모양)
      for (const port of Object.keys(inputs)) inputs[port] = inputs[port].map((it) => ({ ...it, approval: approvedGate }));
    } else if (gateMode !== 'off' && nodeSends(def, node.data.params)) {
      const sources = unguardedSources(node.id, nodes, edges, guarded);
      if (sources.length) {
        const items: Item[] = inputs.main ?? inputs.input1 ?? Object.values(inputs)[0] ?? [{}];
        const sourceTitles = sources.map((id) => NODE_TYPES[nodes.find((n) => n.id === id)?.data.kind ?? '']?.title ?? id).join(', ');
        const r = await callIntegration('approval', {
          channel: 'telegram', chatId: '', title: `자동 승인: ${def.title}`, text: gatePreview(items),
          item: { items }, gate: 'auto',
          _ctx: { results, flow: { nodes, edges }, meta, nodeId: node.id },
        });
        let wait: WaitRequest | null = null;
        if (r?.waiting) wait = { approvalId: r.approvalId, channel: r.channel, gate: 'auto' };
        else if (r?.simulated) wait = { approvalId: null, simulated: true, note: r.note, gate: 'auto' };
        if (wait) {
          blocked.add(node.id);
          results.set(node.id, { status: 'waiting', output: {}, input: items, attempts: 0, wait: [wait] });
          onStatus(node.id, 'waiting', { input: items, wait: [wait] });
          onLog({ kind: 'skip', msg: `⏸ ${def.title} — 자동 승인 게이트: ${sourceTitles} 의 출력이 밖으로 나가기 전에 사람이 봅니다 (${wait.approvalId || '시뮬레이션'})` });
          continue;
        }
        const msg = `AI 출력이 밖으로 나가는 경로에는 승인이 필요합니다 (${sourceTitles} → ${def.title}). ${r?.error || '승인 채널이 없습니다'} — 승인 채널을 연결하거나 CONDUIT_AI_GATE=off`;
        results.set(node.id, { status: 'error', output: {}, input: items, attempts: 0 });
        onStatus(node.id, 'error', { error: msg, input: items });
        onLog({ kind: 'err', msg: `✖ ${def.title} 차단: ${msg}` });
        continue;
      }
    }

    // 주 입력 아이템들 (트리거는 입력이 없으므로 더미 1개로 1회 실행)
    const primaryItems: Item[] = inputs.main ?? inputs.input1 ?? Object.values(inputs)[0] ?? [{}];

    if (!allowCode && CODE_NODES.has(node.data.kind)) {
      const msg = '이 서버에서는 코드 실행이 꺼져 있습니다 (CONDUIT_ALLOW_CODE)';
      results.set(node.id, { status: 'error', output: {}, input: primaryItems, attempts: 0 });
      onStatus(node.id, 'error', { error: msg, input: primaryItems });
      onLog({ kind: 'err', msg: `✖ ${def.title} 차단: ${msg}` });
      continue;
    }

    onStatus(node.id, 'running');

    // 노드 설정 오버라이드
    const profile = { ...profileFor(node.data.kind) };
    const overrideRetries = Number(node.data.params?._retries);
    if (Number.isFinite(overrideRetries)) profile.maxRetries = overrideRetries;
    const continueOnFail = node.data.params?._continueOnFail === true || node.data.params?._continueOnFail === 'true';
    const batchSize = Math.max(0, Number(node.data.params?._batchSize) || 0);
    const batchDelay = Math.max(0, Number(node.data.params?._batchDelayMs) || 0);

    const makeCtx = (item: Item, index: number): NodeContext => ({
      $json: item ?? {}, $items: primaryItems, $index: index, $now: started,
      $results: results, $flow: { nodes, edges }, $meta: meta, $nodeId: node.id,
      safeExpressions: !allowCode,
      onAgentStep: (step) => onAgentStep(node.id, step),
    });

    /** 재시도를 감싼 단일 실행 */
    const runWithRetry = async (runInputs: NodeInputs, ctx: NodeContext): Promise<{ output: NodeOutput | undefined; attempts: number }> => {
      let attempt = 0;
      for (;;) {
        try {
          const resolved = resolveParams(node.data.params, ctx);
          return { output: await def.run(runInputs, resolved, ctx), attempts: attempt + 1 };
        } catch (e) {
          const err = e as RunError;
          if (attempt >= profile.maxRetries || !isRetryable(err)) {
            err.__attempts = attempt + 1;
            throw err;
          }
          const wait = backoffMs(attempt, profile);
          attempt++;
          onLog({ kind: 'skip', msg: `↻ ${def.title} 재시도 ${attempt}/${profile.maxRetries} (${wait}ms 후) — ${err.message}` });
          onStatus(node.id, 'retrying');
          await sleep(wait);
        }
      }
    };

    const outputs: Record<string, Item[]> = {};          // port -> items[]
    const addOut = (port: string, value: unknown) => {
      if (value === undefined || value === null) return;
      (outputs[port] ||= []).push(...toItems<Item>(value as Item | Item[]));
    };

    let nodeError: RunError | undefined;   // 노드 전체를 실패시킬 오류
    let failedItems = 0;
    let totalAttempts = 0;

    try {
      if (def.mode === 'batch') {
        // ---- 배치 모드: 배열 전체를 한 번에 받는 노드 (Aggregate/Merge/Sort…) ----
        const ctx = makeCtx(primaryItems[0] ?? {}, 0);
        const { output, attempts } = await runWithRetry(inputs, ctx);
        totalAttempts = attempts;
        for (const [port, value] of Object.entries(output || {})) addOut(port, value);
      } else {
        // ---- 아이템 모드(기본): 아이템마다 반복 실행 ----
        const chunks = chunk(primaryItems, batchSize);
        let completedCount = 0;
        const totalCount = primaryItems.length;
        const reportProgress = () => {
          completedCount++;
          if (totalCount > 1) onItemProgress(node.id, completedCount, totalCount);
        };
        for (let c = 0; c < chunks.length; c++) {
          if (c > 0 && batchDelay) await sleep(batchDelay);

          const runOne = async (item: Item, index: number) => {
            // 이 아이템만 담은 입력 (다중 입력 포트는 인덱스 매칭, 없으면 첫 아이템)
            const oneInputs: NodeInputs = {};
            for (const [port, arr] of Object.entries(inputs)) {
              oneInputs[port] = port === 'main' ? item : (arr[index] ?? arr[0]);
            }
            if (!def.inputs.length) oneInputs.main = undefined; // 트리거
            else if (inputs.main) oneInputs.main = item;

            const { output, attempts } = await runWithRetry(oneInputs, makeCtx(item, index));
            totalAttempts += attempts;
            return output;
          };

          const runners = chunks[c].map((item, i) => {
            const index = c * (batchSize || primaryItems.length) + i;
            return async (): Promise<Settled> => {
              try {
                const output = await runOne(item, index);
                reportProgress();
                return { ok: true, output };
              } catch (err) {
                reportProgress();
                return { ok: false, err: err as RunError, item, index };
              }
            };
          });

          // 청크 내부는 병렬(batchSize>1), 기본은 순차
          const settled: Settled[] = batchSize > 1
            ? await Promise.all(runners.map((r) => r()))
            : await runners.reduce(async (accP, r) => { const acc = await accP; acc.push(await r()); return acc; }, Promise.resolve([] as Settled[]));

          for (const s of settled) {
            if (s.ok) {
              for (const [port, value] of Object.entries(s.output || {})) addOut(port, value);
            } else {
              failedItems++;
              onDeadLetter({
                nodeId: node.id, nodeKind: node.data.kind, nodeTitle: def.title,
                itemKey: String(s.index), payload: s.item,
                errorCode: s.err.status || 'ERR', errorMsg: s.err.message,
                attempts: s.err.__attempts || 1,
              });
              if (continueOnFail) {
                // 아이템 단위 격리: 실패한 아이템만 에러 정보를 달고 계속 흐른다
                addOut('main', { ...(s.item || {}), _error: { node: def.title, message: s.err.message } });
              } else {
                nodeError = s.err;
                break;
              }
            }
          }
          if (nodeError) break;
        }
      }
    } catch (e) {
      // 배치 모드 실패
      const err = e as RunError;
      nodeError = err;
      onDeadLetter({
        nodeId: node.id, nodeKind: node.data.kind, nodeTitle: def.title,
        payload: primaryItems, errorCode: err.status || 'ERR', errorMsg: err.message,
        attempts: err.__attempts || 1,
      });
      if (continueOnFail) {
        nodeError = undefined;
        addOut('main', { _error: { node: def.title, message: err.message } });
        failedItems++;
      }
    }

    // 사람 승인 대기: 노드가 { __wait: {...} } 를 내면 여기서 멈춘다. 출력을 비워 두므로 아래 노드는
    // "입력 없음"으로 건너뛰고, 이 노드와 무관한 가지는 계속 흐른다. 재개는 seed 로 이 노드의 출력을 주입해 다시 실행한다.
    if (!nodeError && outputs.__wait?.length) {
      const waits = outputs.__wait as unknown as WaitRequest[];
      blocked.add(node.id);
      results.set(node.id, { status: 'waiting', output: {}, input: primaryItems, attempts: totalAttempts, wait: waits });
      onStatus(node.id, 'waiting', { input: primaryItems, wait: waits });
      onLog({ kind: 'skip', msg: `⏸ ${def.title} — 사람 승인 대기 (${waits.map((w) => w.approvalId || '?').join(', ')})` });
      continue;
    }

    if (nodeError) {
      results.set(node.id, { status: 'error', output: {}, input: primaryItems, attempts: nodeError.__attempts || 1 });
      onStatus(node.id, 'error', { error: nodeError.message, input: primaryItems });
      onLog({ kind: 'err', msg: `✖ ${def.title} 오류: ${nodeError.message}` });
    } else {
      // 빈 포트는 undefined 로 (해당 경로로 데이터가 흐르지 않음)
      // 선언된 출력 포트 + 실제 수집된 포트(출력 노드처럼 선언 없이 main 을 내는 경우 포함)
      const output: PortOutputs = {};
      const ports = new Set([...def.outputs, ...Object.keys(outputs)]);
      for (const port of ports) output[port] = emptyToUndefined(outputs[port] || []);

      const status: RunStatus = failedItems > 0 ? 'failedContinue' : 'done';
      results.set(node.id, { status, output, input: primaryItems, attempts: totalAttempts, failedItems });
      onStatus(node.id, status, { output, input: primaryItems });

      const shown = output.main ?? Object.values(output).find((v) => v !== undefined);
      const mainCount = countItems(shown);
      const inCount = primaryItems.length;
      const preview = truncate(JSON.stringify(firstItem(shown)) ?? '', 48);
      onLog({
        kind: failedItems ? 'err' : 'ok',
        msg: `${failedItems ? '⚠' : '✔'} ${def.title} — ${inCount}건 입력 → ${mainCount}건 출력` +
             (failedItems ? ` (실패 ${failedItems}건 격리)` : '') + (preview ? ` · ${preview}` : ''),
      });
    }
  }

  onLog({ kind: 'info', msg: '실행 완료.' });
  return results;
}

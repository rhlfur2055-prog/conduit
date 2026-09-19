// ============================================================
// 실행 엔진 — 위상 정렬 → 노드별 실행. 표현식 해석 + 입/출력 캡처(NDV).
// ============================================================

import { NODE_TYPES } from './nodeTypes.js';
import { resolveParams } from './expr.js';
import { profileFor, isRetryable, backoffMs } from './retry.js';
import { toItems, emptyToUndefined, firstItem, countItems, chunk } from './items.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function topoSort(nodes, edges) {
  const indeg = new Map();
  const adj = new Map();
  nodes.forEach((n) => { indeg.set(n.id, 0); adj.set(n.id, []); });
  edges.forEach((e) => {
    if (adj.has(e.source) && indeg.has(e.target)) {
      adj.get(e.source).push(e.target);
      indeg.set(e.target, indeg.get(e.target) + 1);
    }
  });
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(nodes.find((n) => n.id === id));
    for (const to of adj.get(id)) {
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  if (order.length !== nodes.length) throw new Error('cycle');
  return order;
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s);
const nowISO = () => new Date().toISOString();

/**
 * @returns Map<nodeId, { status, output, input }>
 */
export async function runFlow(nodes, edges, { onStatus = () => {}, onLog = () => {}, seed = {}, onAgentStep = () => {}, onDeadLetter = () => {}, onItemProgress = () => {} } = {}) {
  const results = new Map();
  onLog({ kind: 'info', msg: '워크플로 실행 시작…' });

  let order;
  try {
    order = topoSort(nodes, edges);
  } catch {
    onLog({ kind: 'err', msg: '순환 연결이 있어 실행할 수 없어요.' });
    return results;
  }

  const started = nowISO();

  for (const node of order) {
    const def = NODE_TYPES[node.data.kind];
    if (!def) continue;

    // 외부 주입(웹훅/스케줄 페이로드) — 실행하지 않고 주어진 출력을 사용
    if (seed && seed[node.id] !== undefined) {
      const raw = seed[node.id];
      const output = {};
      for (const [port, value] of Object.entries(raw || {})) output[port] = emptyToUndefined(toItems(value));
      results.set(node.id, { status: 'done', output, input: undefined });
      onStatus(node.id, 'done', { output, input: undefined });
      onLog({ kind: 'ok', msg: `● ${def.title} — ${countItems(output.main)}건 주입` });
      continue;
    }

    // 입력 수집 — 모든 포트 값은 아이템 배열로 정규화된다
    const inputs = {};
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

    // 주 입력 아이템들 (트리거는 입력이 없으므로 더미 1개로 1회 실행)
    const primaryItems = inputs.main ?? inputs.input1 ?? Object.values(inputs)[0] ?? [{}];
    onStatus(node.id, 'running');

    // 노드 설정 오버라이드
    const profile = { ...profileFor(node.data.kind) };
    const overrideRetries = Number(node.data.params?._retries);
    if (Number.isFinite(overrideRetries)) profile.maxRetries = overrideRetries;
    const continueOnFail = node.data.params?._continueOnFail === true || node.data.params?._continueOnFail === 'true';
    const batchSize = Math.max(0, Number(node.data.params?._batchSize) || 0);
    const batchDelay = Math.max(0, Number(node.data.params?._batchDelayMs) || 0);

    /** 재시도를 감싼 단일 실행 */
    const runWithRetry = async (runInputs, ctx) => {
      let attempt = 0;
      for (;;) {
        try {
          const resolved = resolveParams(node.data.params, ctx);
          return { output: await def.run(runInputs, resolved, ctx), attempts: attempt + 1 };
        } catch (err) {
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

    const outputs = {};          // port -> items[]
    const addOut = (port, value) => {
      if (value === undefined || value === null) return;
      (outputs[port] ||= []).push(...toItems(value));
    };

    let nodeError;               // 노드 전체를 실패시킬 오류
    let failedItems = 0;
    let totalAttempts = 0;

    try {
      if (def.mode === 'batch') {
        // ---- 배치 모드: 배열 전체를 한 번에 받는 노드 (Aggregate/Merge/Sort…) ----
        const ctx = {
          $json: primaryItems[0] ?? {}, $items: primaryItems, $index: 0, $now: started,
          onAgentStep: (step) => onAgentStep(node.id, step),
        };
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

          const runOne = async (item, index) => {
            // 이 아이템만 담은 입력 (다중 입력 포트는 인덱스 매칭, 없으면 첫 아이템)
            const oneInputs = {};
            for (const [port, arr] of Object.entries(inputs)) {
              oneInputs[port] = port === 'main' ? item : (arr[index] ?? arr[0]);
            }
            if (!def.inputs.length) oneInputs.main = undefined; // 트리거
            else if (inputs.main) oneInputs.main = item;

            const ctx = {
              $json: item ?? {}, $items: primaryItems, $index: index, $now: started,
              onAgentStep: (step) => onAgentStep(node.id, step),
            };
            const { output, attempts } = await runWithRetry(oneInputs, ctx);
            totalAttempts += attempts;
            return output;
          };

          const runners = chunks[c].map((item, i) => {
            const index = c * (batchSize || primaryItems.length) + i;
            return async () => {
              try {
                const output = await runOne(item, index);
                reportProgress();
                return { ok: true, output };
              } catch (err) {
                reportProgress();
                return { ok: false, err, item, index };
              }
            };
          });

          // 청크 내부는 병렬(batchSize>1), 기본은 순차
          const settled = batchSize > 1
            ? await Promise.all(runners.map((r) => r()))
            : await runners.reduce(async (accP, r) => { const acc = await accP; acc.push(await r()); return acc; }, Promise.resolve([]));

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
    } catch (err) {
      // 배치 모드 실패
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

    if (nodeError) {
      results.set(node.id, { status: 'error', output: {}, input: primaryItems, attempts: nodeError.__attempts || 1 });
      onStatus(node.id, 'error', { error: nodeError.message, input: primaryItems });
      onLog({ kind: 'err', msg: `✖ ${def.title} 오류: ${nodeError.message}` });
    } else {
      // 빈 포트는 undefined 로 (해당 경로로 데이터가 흐르지 않음)
      // 선언된 출력 포트 + 실제 수집된 포트(출력 노드처럼 선언 없이 main 을 내는 경우 포함)
      const output = {};
      const ports = new Set([...def.outputs, ...Object.keys(outputs)]);
      for (const port of ports) output[port] = emptyToUndefined(outputs[port] || []);

      const status = failedItems > 0 ? 'failedContinue' : 'done';
      results.set(node.id, { status, output, input: primaryItems, attempts: totalAttempts, failedItems });
      onStatus(node.id, status, { output, input: primaryItems });

      const mainCount = countItems(output.main ?? Object.values(output).find((v) => v !== undefined));
      const inCount = primaryItems.length;
      const preview = truncate(JSON.stringify(firstItem(output.main ?? Object.values(output).find((v) => v !== undefined))) ?? '', 48);
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

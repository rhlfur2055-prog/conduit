// 웹훅 수신 — 외부 서비스가 부르는 공개 입구. API 키 대신 노드별 서명 검증 + 멱등성으로 보호한다.
import { Router } from 'express';
import { Workflows, ProcessedEvents, DLQ } from '../store.js';
import { verifySignature, idempotencyKey } from '../webhookSecurity.js';
import { execute } from '../runtime.js';

export const webhooks = Router();

webhooks.all('/:p(*)', async (req, res) => {
  const hookPath = '/' + req.params.p;
  const payload = req.method === 'GET' ? req.query : req.body;

  let matched = null;
  for (const wf of Workflows.all()) {
    if (!wf.active) continue;
    const node = (wf.nodes || []).find(
      (n) => n.data.kind === 'webhookTrigger' && n.data.params?.path === hookPath
    );
    if (node) { matched = { wf, node }; break; }
  }
  if (!matched) return res.status(404).json({ error: `활성 워크플로에 웹훅 ${hookPath} 없음` });

  // 1) 서명 검증 (노드 설정: signature=none|slack|github|stripe|generic, secretCred=크리덴셜 이름)
  const scheme = matched.node.data.params?.signature || 'none';
  const verdict = verifySignature(scheme, {
    headers: req.headers,
    rawBody: req.rawBody || '',
    credentialName: matched.node.data.params?.secretCred || '',
  });
  if (!verdict.ok) {
    console.warn(`[webhook] 서명 검증 실패 ${hookPath}: ${verdict.reason}`);
    return res.status(verdict.status).json({ error: verdict.reason });
  }

  // 2) 멱등성 게이트 — 같은 이벤트 재전송이면 실행하지 않음
  const key = idempotencyKey({ headers: req.headers, body: payload, rawBody: req.rawBody, path: hookPath });
  const claim = ProcessedEvents.claim(key, { source: 'webhook', eventType: hookPath });
  if (!claim.claimed) {
    return res.status(200).json({ received: true, deduped: true, reason: claim.reason, idempotencyKey: key });
  }

  // 3) 실행
  try {
    const seed = { [matched.node.id]: { main: payload } };
    const result = await execute(matched.wf, { seed, trigger: 'webhook' });
    ProcessedEvents.complete(key, result.execution.id);
    res.json({ received: true, workflow: matched.wf.name, executionId: result.execution.id, idempotencyKey: key });
  } catch (e) {
    ProcessedEvents.fail(key);
    DLQ.add({ workflowId: matched.wf.id, workflowName: matched.wf.name, nodeId: matched.node.id, nodeKind: 'webhookTrigger', payload, errorCode: 'EXEC', errorMsg: e.message });
    res.status(500).json({ error: e.message });
  }
});

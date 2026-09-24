// 웹훅 수신 — 외부 서비스가 부르는 공개 입구. API 키 대신 노드별 서명 검증 + 멱등성으로 보호한다.
import { Router } from 'express';
import { Workflows, ProcessedEvents } from '../store.js';
import { verifySignature, idempotencyKey } from '../webhookSecurity.js';
import { enqueue, ensureInlineWorker, waitForJob } from '../queue.js';

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

  // 3) 큐에 넣는다 — 요청 안에서 돌리지 않는다. 워커(서버 안 또는 별도 프로세스)가 잡아 돌고, 죽으면 다른 워커가 이어받는다.
  const seed = { [matched.node.id]: { main: payload } };
  const { job } = enqueue({ workflowId: matched.wf.id, workflowName: matched.wf.name, trigger: 'webhook', seed, idempotencyKey: key });
  ensureInlineWorker();
  const base = { received: true, workflow: matched.wf.name, jobId: job.id, idempotencyKey: key };
  if (req.query.async !== undefined) return res.status(202).json({ ...base, queued: true });

  // 기본: 결과를 기다려 돌려준다 (호환). 시간 안에 안 끝나면 202 로 작업 id 를 준다 — GET /api/jobs/:id 로 본다.
  const done = await waitForJob(job.id, { timeoutMs: Number(process.env.CONDUIT_WEBHOOK_WAIT_MS) || 25000 });
  if (done?.status === 'done') return res.json({ ...base, executionId: done.executionId });
  if (done?.status === 'failed') return res.status(500).json({ ...base, error: done.error });
  res.status(202).json({ ...base, queued: true, status: done?.status ?? 'queued' });
});

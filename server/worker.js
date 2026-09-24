// ============================================================
// 별도 워커 프로세스 — HTTP 없이 jobs 테이블에서 일을 잡아 돈다.
//
//   node server/worker.js                # 같은 CONDUIT_DATA_DIR 의 conduit.db 를 본다
//   서버는 CONDUIT_WORKER=off 로 띄우면 큐에 넣기만 하고 돌리지 않는다 → 워커를 몇 개든 띄울 수 있다.
//   같은 일은 한 워커만 잡고(claimNext 한 문장), 워커가 죽으면 임대가 만료돼 다른 워커가 이어받는다.
// ============================================================
import './env.js';
import { installBridges } from './bridges.js';
import { startWorker, Jobs } from './queue.js';
import { closeOcr } from './vision.js';

process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));

installBridges();
const worker = startWorker({
  workerId: process.env.CONDUIT_WORKER_ID || `w_${process.pid}`,
  pollMs: Number(process.env.CONDUIT_WORKER_POLL_MS) || 500,
  keepAlive: true,                                            // 이 프로세스의 생명줄
  onJob: (job, result) => console.log(`[worker ${process.pid}] ${job.id} ${job.workflowName || job.workflowId} → ${result ? result.execution.status : '실패'} (시도 ${job.attempts})`),
});
console.log(`[worker ${process.pid}] 시작 · 큐 ${JSON.stringify(Jobs.counts())}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { worker.stop(); await closeOcr(); process.exit(0); });
}

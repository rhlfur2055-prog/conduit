# 신뢰성과 보안

재시도 · 실패 격리 · DLQ · 멱등성 · 웹훅 서명 검증 · API 인증 · 코드 실행 정책.

## 신뢰성 (Reliability)

n8n의 핵심 안정성 기능을 구현했습니다. 모두 동작 검증 완료.

### 재시도 + 지수 백오프
- 노드 카테고리별 기본 정책: HTTP 3회 · LLM 5회 · Email 2회 · 트리거 0회
- **일시 오류만 재시도**: 408·425·429·5xx·529·네트워크 오류 → 재시도 / **400·401·403·404·422 → 즉시 실패**
- 지수 백오프(×2) + **±20% 지터**, 카테고리별 상한(cap)
- 노드별 오버라이드: 인스펙터 **안정성** 섹션에서 재시도 횟수 지정

### Continue On Fail
- 노드별 체크박스. 켜면 실패해도 흐름이 멈추지 않고, 다음 노드로 `_error` 정보를 담아 전달합니다.

### DLQ (실패 격리 큐)
- 실패한 노드는 자동으로 DLQ에 격리: `workflow_id · node_id · payload · error_code · attempts · replay_status`
- `GET /api/dlq` 조회 · `POST /api/dlq/:id/replay` 재실행 · `DELETE /api/dlq/:id` 삭제

### 웹훅 HMAC 서명 검증
Webhook 트리거 노드에서 `signature` 선택 (`none|slack|github|stripe|generic`) + `secretCred`(크리덴셜 이름).

| 스킴 | 헤더 | 알고리즘 | 실패 응답 |
|---|---|---|---|
| slack | `X-Slack-Signature` + `X-Slack-Request-Timestamp` | HMAC-SHA256 `v0:{ts}:{body}` | 401 / 403(리플레이) |
| github | `X-Hub-Signature-256` | HMAC-SHA256(body) | 401 |
| stripe | `Stripe-Signature` | HMAC-SHA256 `{t}.{body}` | 401 / 403(리플레이) |
| generic | `X-Signature` | HMAC-SHA256(body) | 401 |

**raw body** 기준 계산, **상수시간 비교**, **±5분 리플레이 윈도우**. 시크릿은 자격 증명에 `webhook` 타입으로 암호화 저장.

### Error Trigger 워크플로 (전역 에러 핸들러)

**Error Trigger** 노드(트리거 카테고리)로 시작하는 워크플로를 만들어 **활성화**하면,
다른 워크플로가 실패할 때마다 자동 실행됩니다.

- 주입되는 에러 페이로드: `workflowName · executionId · errorNode · errorMessage · failedNodes[] · failedAt`
- 이 데이터를 표현식으로 받아 Slack/이메일 알림, Notion 장애 기록 등으로 연결하면 됩니다.
- **무한루프 방지**: 에러 핸들러 자신의 실패(trigger=error)는 재발동하지 않습니다.
- 검증됨: 실패 실행 → 핸들러 자동 발동 → `"[장애] (캔버스) 실패 — httpRequest: fetch failed"` 알림 생성 ✅

### 멱등성 (중복 실행 방지)
- 키 규칙: provider 이벤트 id 우선(`X-GitHub-Delivery`·`body.id`·`event_id`), 없으면 **body 해시** (시각은 키에 넣지 않음 — 재시도 시 키가 바뀌면 멱등성이 깨지므로)
- 상태 저장: SQLite `processed_events` 테이블 — `idempotency_key`(PRIMARY KEY) · `status(pending/done/failed)` · `attempts` · `locked_until` · `result_ref`
- 잡기(claim)는 `INSERT … ON CONFLICT DO UPDATE … WHERE status != 'done' AND (status != 'pending' OR locked_until <= now)` **한 문장**. "읽고 나서 쓰는" 틈이 없어서 같은 키가 동시에 100번 와도 하나만 잡는다 (`tests/server/store.sqlite.test.js`)
- 중복 요청은 실행하지 않고 `{deduped:true, reason:"already_done"}` 반환. 처리 중이면 `in_progress`.
- 조회: `GET /api/idempotency`

## API 인증

코드 노드는 임의 JavaScript를 실행하기 때문에, 인증 없이 외부에 열리면 누구나 서버에서 코드를 돌릴 수 있습니다. 그래서 기본값을 "전부 허용"이 아니라 **"이 컴퓨터에서 온 요청만 허용"**으로 두었습니다.

| `CONDUIT_API_KEY` | `/api/*` · `/mcp` | `/api/health` · `/webhook/*` · 화면 |
|---|---|---|
| 설정함 | `Authorization: Bearer <키>` 또는 `X-API-Key` 가 맞아야 통과, 아니면 **401** | 공개 |
| 비워 둠 | 127.0.0.1 에서 온 요청만 통과, 외부는 **403** | 공개 |

- 같은 서버의 Nginx 같은 프록시를 거친 요청은 주소가 127.0.0.1로 보이므로, `X-Forwarded-For` 가 붙은 요청은 로컬로 치지 않습니다.
- 키 비교는 SHA-256 해시 후 `crypto.timingSafeEqual` 로 해서, 응답 시간으로 키를 추측할 수 없게 했습니다.
- 웹훅은 외부 서비스가 부르는 입구라 공개하고, 노드별 HMAC 서명 검증(Slack·GitHub·Stripe 방식)으로 보호합니다.
- 화면에서는 사이드바 **설정**에 같은 키를 넣으면 됩니다 (이 브라우저에만 저장).
- 구현: `server/auth.js`, 테스트: `tests/server/auth.test.js` (실제 HTTP 요청으로 401·403·200 확인)

### 작업 큐 (`server/queue.js` · `CONDUIT_WORKER`)
- 웹훅(`/webhook/*`)과 크론 틱은 `execute()` 를 직접 부르지 않고 `jobs` 테이블에 넣는다. 수동 실행·MCP·DLQ 재실행·승인 재개는 사용자가 결과를 기다리는 호출이라 그대로 직접 돈다.
- `claimNext(workerId, leaseMs)`: `UPDATE jobs SET status='running', worker_id, attempts+1, lease_until WHERE id = (SELECT … queued OR (running AND lease_until < now) … LIMIT 1) RETURNING *` — 한 문장이라 프로세스가 몇 개든 한 일은 한 워커만 잡는다.
- 임대: 일을 잡은 워커는 `leaseMs/3` 마다 `heartbeat` 로 임대를 늘린다. 워커가 죽으면 임대가 만료되고 `claimNext` 가 그 일을 다시 준다(`attempts` +1). `max_attempts`(기본 2)에 닿은 채 임대가 만료되면 `reapExpired` 가 failed 로 닫는다. 시도를 다 쓴 실패는 페이로드를 DLQ 에 격리한다.
- 멱등: `idempotency_key UNIQUE`. 웹훅은 이벤트 키, 스케줄은 `schedule:<wf>:<node>:<분>` — 서버 두 대가 같은 분에 같은 크론을 울려도 일은 하나. 웹훅의 멱등 원장(`processed_events`)은 일이 끝날 때 워커가 done/failed 로 적는다.
- 웹훅 응답: 기본은 결과를 기다려 `executionId` 를 돌려준다(`CONDUIT_WEBHOOK_WAIT_MS`, 기본 25초). `?async=1` 이면 `202 { jobId }`. 시간을 넘겨도 `202 { jobId }` — `GET /api/jobs/:id` 로 본다.
- 워커: `CONDUIT_WORKER=inline`(기본) 이면 서버 프로세스 안에서 돈다. `off` 면 큐에 넣기만 하고 `node server/worker.js` 를 따로 띄운다(여러 개 가능, 같은 `CONDUIT_DATA_DIR`).
- 최소 한 번 실행이다: 워커가 죽었다 이어받으면 앞 워커가 이미 한 부작용은 되돌리지 않는다. 그래서 발송 노드는 승인 게이트 뒤에 있고(승인 없이 두 번 나가지 않는다), 트리거 경계에는 멱등 키가 있다.
- 테스트: `tests/server/queue.test.js` — 문장 단위(dedupe · claim · 임대 만료 · 심장박동 · 상한) + 진짜 워커 프로세스 두 개(일 30개 정확히 한 번씩 · SIGKILL 뒤 이어받기).

### 실행 추적 (`GET /api/executions/:id/trace`)
- 실행 id 는 `execute()` 가 돌기 전에 발급한다(`uid('ex')`). 그래서 실행 중에 생긴 승인 요청(`approvals.execution_id`)과 DLQ 항목(`dlq.execution_id`)이 그 실행에 매달린다.
- 노드마다 `status · attempts(재시도 포함) · ms · failedItems · injected(스냅샷 주입, 재실행 아님) · kind` 를 실행 기록의 `statuses` 에 남긴다. 워크플로가 지워져도 기록만으로 이름이 복원된다.
- 응답: `execution` · `nodes[]` · `approvals[]`(flow·snapshot 제외) · `resumedFrom`(이 실행이 어느 승인의 재개였나) · `children[]`(이 실행의 승인이 만든 재개 실행) · `deadLetters[]`.
- 캔버스의 서버 실행(`POST /run/stream`)도 같은 기록을 남기고, 승인 요청도 확정해 보낸다 (전에는 스트리밍 실행에서 승인이 `preparing` 에 머물렀다).
- 구현: `server/runtime.js`(statusRecorder · enrichStatuses · finalizeWaiting) · `server/routes/workflows.js` · 화면 `src/components/ExecutionsModal.jsx`. 테스트: `tests/server/trace.test.js`

### 자동 승인 게이트 (`CONDUIT_AI_GATE`)
- 규칙: 발송 노드(`sends`)로 들어오는 경로 위에 모델 출력 노드(`llm`)가 있고 그 사이에 승인 노드(`approvalRequest`)가 없으면, 실행기가 발송 노드 앞에서 멈추고 `approval` 연동으로 사람에게 묻는다 (`gate: 'auto'` 로 저장). 판정은 `src/engine/gates.ts` — 데이터가 아니라 그래프를 본다.
- 재개: 승인이면 발송 노드를 실행하되 들어오는 아이템마다 `approval` 을 붙인다(승인 노드와 같은 모양). 거절·만료면 발송 노드를 건너뛴다. 위쪽 노드는 스냅샷으로 주입돼 다시 돌지 않는다. 한 체인에서 이미 승인된 발송 노드 아래의 두 번째 발송은 다시 묻지 않는다.
- 발송으로 보는 것: 텔레그램 · Slack · Gmail · Notion · HTTP 요청(GET 제외) · MCP 도구 호출(도구 이름이 있을 때). 모델 출력으로 보는 것: AI · 구조화 추출 · 에이전트 · 루프 · 소크라테스식 읽기 · 화면 이해.
- 채널이 없으면 조용히 통과하지 않고 노드 오류. 브라우저(브리지 없음)에서는 시뮬레이션 대기로만 표시.
- 설계 때: `POST /api/workflows/lint` `{ nodes, edges }` → 보호되지 않은 경로 목록(노드 이름 포함).
- 기본 `auto`. `CONDUIT_AI_GATE=off` 로만 끈다. 테스트: `tests/engine/gates.test.js`, `tests/server/approvals.test.js`(자동 게이트 절)

### 서버에서의 코드 실행 (`CONDUIT_ALLOW_CODE`)

서버에서 사용자 JS가 실행되는 입구는 코드 노드만이 아닙니다. **`{{ }}` 표현식**도 JS로 평가되고(`{{ process.env.ANTHROPIC_API_KEY }}` 한 줄로 비밀값을 읽을 수 있음), **AI 에이전트의 `run_code` 도구**는 모델이 고른 코드를 실행합니다. 하나만 막으면 나머지로 같은 일을 할 수 있어서, 스위치 하나로 셋을 함께 끕니다.

| | 코드 실행 켜짐 | 코드 실행 꺼짐 |
|---|---|---|
| 코드 노드 | 실행 | 실행하지 않고 노드 오류 |
| `{{ }}` 표현식 | JS 식 | **데이터 경로만** — `$json.a.b`, `$json["주문 번호"]`, `$items[0].x`, `$items.length`, `$index`, `$now` |
| 에이전트 `run_code` | 사용 가능 | 도구 목록에서 빠지고, 모델이 이름을 지어내 불러도 실행하지 않음 |

- 기본값: 키가 없으면(로컬 전용) **켜짐**, `CONDUIT_API_KEY` 가 있으면(외부에 연 서버) **꺼짐**. `CONDUIT_ALLOW_CODE=true|false` 로 직접 지정할 수 있습니다.
- 브라우저 캔버스에서 돌리는 실행은 내 컴퓨터 안이라 제한하지 않습니다.
- 경로 표현식은 `new Function` 없이 직접 해석하고, `constructor`·`__proto__`·프로토타입 메서드는 읽지 않습니다.
- 현재 상태는 `/api/health` 의 `code: on|off` 로 확인. 구현: `server/policy.js`, `src/engine/expr.ts`(evalPath), 테스트: `tests/engine/policy.test.js`, `tests/server/policy.test.js`

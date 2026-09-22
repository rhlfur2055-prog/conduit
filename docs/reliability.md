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
- 상태 저장: `idempotency_key · status(pending/done/failed) · attempts · locked_until · result_ref`
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
- 현재 상태는 `/api/health` 의 `code: on|off` 로 확인. 구현: `server/policy.js`, `src/engine/expr.js`(evalPath), 테스트: `tests/engine/policy.test.js`, `tests/server/policy.test.js`

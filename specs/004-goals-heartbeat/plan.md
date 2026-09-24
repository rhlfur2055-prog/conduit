# 구현 계획: 목표 + 하트비트

명세: [spec.md](spec.md) · 원칙: [constitution](../../.specify/memory/constitution.md)

## 구조

```
server/store.js        Goals · Heartbeats · InboxSeen · PendingActions 저장소
server/heartbeat.js    senseInbox · gatherContext · propose(LLM 또는 규칙) · validate(코드) · runHeartbeat
server/routes/agent.js /api/goals CRUD · POST /api/heartbeat (한 번 돌리기) · GET 기록 · 대기 제안 승인/거절
server/index.js        CONDUIT_HEARTBEAT 크론이 있으면 주기 실행 (겹치면 건너뜀)
```

## 제안 → 검증 → 실행

| 검증 (코드) | 실패하면 |
|---|---|
| 목표 ID 가 이번 상황에 있고 활성 | 거부 · 기록 |
| 워크플로가 그 목표의 허용 목록에 있음 | 거부 · 기록 |
| 근거 ID(G·I·E·M)가 이번 상황에 실제로 있음 | 거부 · 기록 |
| 입력의 문자열 중 파일 경로처럼 보이는 것은 이번에 감지된 입력(I)의 경로와 같음 | 거부 · 기록 |
| 입력이 감지 목록(I)을 가리키면 아직 처리 안 한 것 | 건너뜀 (중복 방지) |
| 하루 실행 상한 · 한 번 하트비트 실행 상한 | 건너뜀 |
| 확신도 ≥ 0.7 · 목표 requireApproval 꺼짐 · 워크플로에 부작용 노드 없음 | → 아니면 **사람 승인 대기** |

부작용 노드(코드로 판정): slack · gmail · telegram · notion · httpRequest · httpAuth · mcpTool · code · aiAgent

## 규칙 모드 (LLM 없음)

목표에 허용 워크플로가 하나이고 새 입력이 있으면 → 입력마다 `run` (확신도 1, 근거 G·I). 그 외는 `wait` 와 이유.

## 원칙 점검

| 원칙 | 여기서 |
|---|---|
| I 검증은 모델 밖 | 제안의 모든 ID·경로·워크플로를 코드가 대조. 부작용 판정도 코드 |
| II 모르면 모른다 | 할 일이 없거나 근거가 없으면 wait — 실행하지 않는다 |
| III 검증된 것만 기억 | 하트비트는 기억을 쓰지 않는다. 기억은 워크플로 안의 검증을 거친다 |
| IV 숫자는 재서 | 잘못된 제안 실행 0건 · 중복 0건을 테스트로 고정, 끝까지 테스트에 단계 추가 |
| V 없어도 멈추지 않음 | 키가 없으면 규칙 모드 |
| VI 테스트가 먼저 | 가짜 LLM · 가짜 실행기로 검증 규칙을 먼저 고정 |

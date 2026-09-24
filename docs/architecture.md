# 구조와 엔진

이 문서는 Conduit 의 내부 구조를 다룬다. 시작은 [README](../README.md) 를 먼저 보라.

## 구조

```
src/
├─ engine/
│  ├─ nodeTypes.js   # 노드 정의(메타 + 필드 + run) — UI 독립, 프론트/백엔드 공용
│  ├─ executor.js    # 위상정렬 실행 + seed 주입 + 입/출력 캡처
│  └─ expr.js        # {{ }} 표현식 해석
├─ ui/icons.jsx      # 라인 SVG 아이콘
├─ components/       # FlowNode · Sidebar · NodePanel · Inspector(NDV) · LogPanel
├─ api.js           # 백엔드 API 클라이언트
├─ flowActions.js    # 노드 액션 컨텍스트
└─ App.jsx           # 앱 셸 + 상태/저장/로컬·서버 실행

server/               # Node/Express 백엔드
├─ index.js          # 라우트 + 웹훅 + 크론
├─ store.js          # 파일 영속화 + 크리덴셜 AES 암호화
└─ llm.js            # Anthropic 호출 브리지
```

---

## 서버 구조

처음엔 `server/index.js` 한 파일(약 500줄)에 라우트·실행·크론이 다 있었습니다. 먼저 실제 HTTP 요청으로 동작을 고정하는 통합 테스트(`tests/server/routes.test.js`)를 붙인 뒤, 동작을 바꾸지 않고 책임별로 나눴습니다.

```
server/
  index.js        진입점 — env 로드 → 브리지 주입 → 앱 생성 → listen (36줄)
  app.js          Express 조립: 미들웨어 → 공개 라우트 → 인증 게이트 → 보호 라우트 → 정적 파일
  runtime.js      execute() · Error Trigger 발동 · 크론 스케줄러
  bridges.js      LLM·연동·에이전트 등 서버 전용 기능을 공용 엔진에 globalThis 로 주입
  auth.js         API 키 인증          policy.js   코드 실행 정책
  routes/
    workflows.js  /api/workflows · /api/run · /api/executions · /api/credentials
    webhooks.js   /webhook/*  (공개 · HMAC 서명 검증 + 멱등성)
    mcp.js        /api/mcp/tools (외부 MCP 도구 목록) · /mcp (Conduit = MCP 서버)
    dlq.js        /api/dlq · /api/idempotency
    channel.js    /api/channel/stats · /dashboard
  store.js        JSON 파일 저장소 + 크리덴셜 AES-256-GCM (CONDUIT_DATA_DIR 로 위치 변경 가능)
```

- 테스트는 `CONDUIT_DATA_DIR` 을 임시 폴더로 잡아 실제 `server/data` 를 건드리지 않습니다.
- 라우터는 모두 `runtime.execute()` 를 거치므로, 실행 기록·DLQ·Error Trigger 가 웹훅·MCP·재실행 어디서 시작해도 똑같이 남습니다.

## 아이템(배열) 데이터 모델 — n8n 식 데이터 흐름

모든 노드 사이를 흐르는 데이터는 **아이템 배열**입니다. 트리거에 배열을 넣으면 여러 아이템이 흐르고,
일반 노드는 **아이템마다 자동 반복 실행**됩니다 (노드 코드는 단일 아이템만 다루면 됨).

- **아이템별 라우팅**: IF/Switch/필터가 아이템 단위로 분기 — true 아이템은 true 경로로, false 아이템은 false 경로로 각각 흐릅니다.
- **아이템별 오류 격리**: Continue On Fail 켜면 실패한 아이템만 DLQ 격리 + `_error` 마킹하고 나머지는 계속.
- **배치 처리**: 인스펙터 **배치 처리** 섹션 — 배치 크기(N개씩 병렬) + 배치 간 지연(rate limit 대응).
- **NDV**: 입력/출력 탭에 아이템별 카드(`3 items` 카운트 + 아이템 1·2·3…)로 표시.

### 배열 카테고리 노드

| 노드 | 동작 |
|---|---|
| 배열 분해 (Split Out) | `items` 같은 중첩 배열을 아이템들로 분해, 부모 필드 병기(`include`: none/selected/all) |
| 집계 (Aggregate) | sum·avg·min·max·count·concat·toArray — N건 → 1건 |
| 정렬 (Sort) | 필드 기준 asc/desc (숫자/문자 자동판별) |
| 중복 제거 | 필드 기준 또는 전체 비교 |
| 개수 제한 (Limit) | first/last N건 |
| 병합 (Merge) | append(이어붙이기) / combine(인덱스별 필드 병합) |

검증된 파이프라인: `주문 1건 → Split Out(3 아이템) → 중복제거(2) → 코드(lineTotal 각각 계산) → 정렬 → Aggregate sum = 500` ✅

## 핵심 기능 (n8n 코어 재현)

- **캔버스**: 팬/줌·미니맵·노드 드래그, 우상단 `+` 로 검색형 노드 추가 패널
- **연결**: 노드 오른쪽 점(출력) → 다른 노드 왼쪽 점(입력)으로 드래그
- **실행 엔진**: 위상 정렬 후 연결 순서대로 실행하며 데이터 전달
- **표현식**: 값에 `{{ $json.필드 }}` 를 쓰면 이전 노드 데이터를 참조 (`$now`, `$items`, `$index` 도 지원)
- **분기/스킵**: IF·Switch·Filter — 안 탄 경로는 자동 스킵
- **NDV 데이터 뷰**: 노드 선택 시 설정 / **입력** / **출력** 탭으로 데이터 확인
- **실행 로그 도크** + 노드별 상태 뱃지(✓·아이템 수)
- **저장**: localStorage 자동 저장 + JSON 내보내기/불러오기

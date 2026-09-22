# Conduit — 자동화 워크플로 빌더

[![test](https://github.com/rhlfur2055-prog/conduit/actions/workflows/test.yml/badge.svg)](https://github.com/rhlfur2055-prog/conduit/actions/workflows/test.yml)

![Conduit 데모 — 주문 5건이 금액 기준으로 분기되어 VIP 3건·소액 2건으로 처리되는 장면](docs/demo.gif)

*주문 5건 → 대기(레이트 리밋 흉내) → IF `amount > 30000` → VIP 3건은 필드 설정·합계, 소액 2건은 건수 집계. 노드마다 처리한 아이템 수가 표시되고, 노드를 열면 입력·출력 아이템을 볼 수 있습니다.*

> **개발 일지는 문서 맨 아래 [📅 개발 일지](#-개발-일지) 참고.**

n8n / Make 같은 **노드 기반 자동화 툴**을 직접 만든 프로젝트입니다.
노드를 캔버스에 놓고 → 선으로 잇고 → **실행**하면 데이터가 노드 순서대로 흐릅니다.

Vite + React + [React Flow(@xyflow/react)](https://reactflow.dev) 로 만들었고,
디자인은 Claude 감성(따뜻한 크림 + 코랄)을 적용했습니다.

> 이전 이름은 FlowForge 였습니다. 브랜드명은 `src/components/Sidebar.jsx` 의 `sb-word` 한 곳에서 바꿀 수 있어요.

## Conduit으로 만든 것

### 1. 유튜브 쇼츠 자동 제작 — 대본에서 업로드까지 워크플로 하나로

`트리거(수동 · 매일 09:00 스케줄)` → `주제·데이터 선택` → `대본` → `TTS 내레이션` → `영상 렌더(Remotion)` → `YouTube 업로드`

- **TTS 내레이션** (`server/tts.js`) — 무료 Edge TTS, 오프라인 폴백(Windows SAPI), 같은 대본은 캐시 재사용
- **낭독과 화면 1:1 싱크** — 문장마다 TTS를 따로 만들고 ffprobe로 잰 실제 길이가 장면 길이를 정한다 (추정 없음)
- **렌더** (`server/render-*.js`) — `npx remotion render` → ffmpeg 후처리(라우드니스 정규화) → 썸네일 → ffprobe 검증
- **YouTube 업로드** — Data API(OAuth 2.0 리프레시 토큰, resumable 업로드), 예약 공개(`publishAt`), 기본값은 `private`. 크리덴셜이 없으면 시뮬레이션으로 동작
- **채널 관제 화면** (`/dashboard`) — 채널의 최근 업로드 통계 + 워크플로 클릭 실행 + 서버 상태

업로드는 실제 채널에서 동작을 확인했습니다. 사람은 주제를 고르고 공개 전에 확인합니다. (지금 채널에 공개된 영상은 없습니다. Remotion 영상 템플릿은 별도 로컬 프로젝트이고, 이 저장소에는 그것을 호출하는 서버 모듈이 있습니다.)

### 1-2. 그날의 핫이슈 → 헤드라인 3줄 쇼츠

`스케줄(매일 09:00)` → `핫이슈 수집(Google 트렌드 KR)` → `핫이슈 쇼츠 렌더` → `YouTube 업로드` → `출력`

- **핫이슈 수집 노드** — Google 트렌드 실시간 인기 검색어 RSS(키 불필요)에서 주제·검색량·관련 뉴스 헤드라인(제목·출처·URL)을 가져온다. 한글 주제만, 검색량 하한, 최근 N일 안에 쓴 주제 제외(`hot-topics-history.json`). 주제 하나가 아이템 하나로 흘러서 `limit`을 3으로 올리면 하루 3편이 나온다.
- **핫이슈 쇼츠 렌더 노드** — 훅(주제·검색량) → 헤드라인 카드 → CTA. 문장마다 TTS를 따로 만들고 실측 길이로 장면 길이를 정해 낭독과 화면이 1:1로 맞는다. 업로드용 제목·설명·태그도 같이 만들며, **설명란에 출처와 원문 링크를 남긴다.**
- 대본은 실제 헤드라인만 읽는다. LLM이 없어도 돌아가고, 지어낸 수치가 들어갈 자리가 없다. `[단독]`·`(종합)` 같은 꼬리표와 제목 끝의 언론사 이름은 정리한다.
- 실제 실행(2026-09-19): 주제 "로또"(검색 2,000+), 헤드라인 3개(서울경제·Daum·머니투데이) → 41.5초 영상, 36~63초 소요.
- 알려진 한계: 트렌드 RSS가 붙여 주는 관련 뉴스에 **지난 회차 기사처럼 오래된 헤드라인이 섞일 수 있다**(RSS에 기사 날짜가 없음). 그래서 업로드 기본값은 `private` — 확인 후 공개.

### 1-3. 재사용이 허락된 재료로만 만드는 쇼츠 (출처 강제)

`실영상 쇼츠`·`댓글 밈` 노드는 **출처를 못 밝히면 렌더를 거부한다.** 화면 표기(credit)와 설명란 출처(attributions)가 비어 있으면 `validateStory`/`validateMemeItems`가 이유를 돌려주고 영상이 나오지 않는다.

- **재료 수급** (`server/memeimages.js`) — Wikimedia Commons·Openverse에서 CC0·퍼블릭 도메인·CC BY만 통과시킨다(`commonsLicense`). BY-SA·NC·ND는 거른다. 받은 파일마다 원본 주소·라이선스·촬영자를 `manifest.json`에 남긴다.
- **429 대응** — 표준 썸네일 폭만 요청하고, 연락처가 든 User-Agent를 붙이고, 429·5xx는 `retry-after`를 존중해 지수 백오프로 재시도한다.
- **클립 잘라내기** — ffmpeg `-ss`를 `-i` **뒤**에 두는 정확 seek(앞에 두면 키프레임으로 1~2초 밀린다). 무성영화에 덧입힌 반주는 저작권이 따로 있을 수 있어 기본값은 무음.
- **낭독 정리** (`server/ttsseg.js`) — TTS 앞뒤 무음을 `silenceremove`+`areverse`로 잘라내 자막과 낭독이 어긋나지 않게 한다.
- 만들어 본 결과: 조회수는 나오지 않았다. 재사용이 허락된 재료만으로는 한국 유머 쇼츠에서 경쟁이 안 된다는 것이 실측 결론이고, 이 노드들은 "출처를 강제하는 렌더 파이프라인" 자체가 결과물이다.

### 2. 같은 영상을 4개 언어로 한 번에

`다국어 쇼츠` 노드 하나로 화면·정답은 그대로 두고 문구·내레이션만 한국어·영어·일본어·스페인어로 바꿔 렌더합니다. 한국어·영어 두 편을 약 2분 30초에 렌더했습니다.

### 3. Claude가 Conduit 워크플로를 직접 실행 (MCP)

Conduit 서버를 MCP 서버로 등록하면, 저장된 워크플로가 Claude의 도구(`run_<id>`)가 됩니다. "주문 처리 워크플로 돌려줘"라고 말하면 Claude가 워크플로를 실행하고 결과를 받아옵니다. 반대로 외부 MCP 서버의 도구를 Conduit 노드에서 부를 수도 있습니다. ([MCP 지원](#mcp-지원-양방향))

### 4. 실제 사이트에 붙이는 방법 — 예: 쇼핑몰 주문

맨 위 데모 GIF의 흐름에서 트리거만 `Webhook 트리거`(경로 `/new-order`)로 바꾸고 서버에 저장·활성화하면, 쇼핑몰이 주문마다 보내는 요청으로 같은 처리가 돌아갑니다.

```bash
curl -X POST http://localhost:8787/webhook/new-order \
  -H "Content-Type: application/json" \
  -d '{"customer": "김민수", "amount": 42000}'
```

웹훅 트리거는 Slack·GitHub·Stripe 방식의 HMAC 서명 검증을 지원해서, 요청이 진짜 그 서비스에서 왔는지 확인한 뒤에만 실행합니다. VIP 주문은 `Slack 메시지` 노드로 알리고, 고객 문의라면 `AI 구조화 추출` 노드로 분류해 `Notion 페이지 생성` 노드에 쌓는 식으로 확장할 수 있습니다.

### 그 밖에 만들어 둔 것 (API 키만 넣으면 동작)

- 쿠팡 파트너스·알리익스프레스·링크프라이스 상품 조회 → 광고 표기 문구 자동 삽입 → Blogger 초안 발행 — 시뮬레이션으로 전체 흐름 검증, 실제 키는 미발급

## 한눈에 보기

| | |
|---|---|
| **무엇** | n8n / Make 방식의 노드 기반 워크플로 자동화 플랫폼 (개인 프로젝트, 2026.08 ~) |
| **스택** | Vite · React · React Flow / Express · Node.js / Docker |
| **규모** | 노드 54종 (트리거 4·동작 7·흐름 제어 5·배열 5·연동 9·AI 4·영상 10·수익화 8·출력 2) · 프론트+서버 약 8,800줄 |
| **실사용** | 쇼츠 자동 제작 파이프라인(스케줄 → 대본 → TTS → Remotion 렌더 → YouTube API 업로드)을 실제 채널에 연결해 업로드까지 동작을 확인 — [Conduit으로 만든 것](#conduit으로-만든-것) |
| **테스트** | Vitest 179개 — 실행 엔진(실행 순서·분기·배치·병렬·재시도·오류 격리), 표현식, 재시도 정책, 노드 동작, API 인증·라우트 통합(실제 HTTP), 코드 실행 정책, MCP 패키지(stdio 엔드투엔드), 평가 실행기. `npm test` |
| **평가(evals)** | AI 노드 프롬프트를 입력 20건에 돌려 통과율·회귀 목록으로 비교. `npm run eval` — [AI 노드 평가](#ai-노드-평가-evals) |
| **MCP 패키지** | [`conduit-workflows-mcp`](packages/conduit-workflows-mcp) — Claude Desktop·Cursor 등 stdio 전용 클라이언트에서 Conduit 워크플로를 도구로 쓰는 패키지 (npm 게시 전 — 지금은 저장소에서 실행) |
| **보안** | `/api`·`/mcp` API 키 인증, 키 미설정 시 로컬 전용, 외부 서버에선 코드 실행 차단(코드 노드·JS 표현식·에이전트 도구), 웹훅 HMAC 서명 검증, 크리덴셜 암호화 저장 — [API 인증](#api-인증) |

**글**: [n8n을 직접 만들며 배운 설계 결정 6가지](docs/blog/2026-09-n8n-design-decisions.md) — 아이템 배열 모델, 엔진 공용화, 재시도 분류, 실패 격리, 테스트로 찾은 버그, 코드 실행 입구 셋.

**설계에서 신경 쓴 것**

- **엔진 공용화** — `src/engine/` 실행 코어를 브라우저와 서버가 같이 씁니다. 서버 전용 기능(LLM·외부 연동·에이전트)은 `globalThis` 브리지로 주입하고, 브라우저에서는 시뮬레이션 응답으로 대체합니다. 같은 워크플로를 캔버스에서 미리 돌려 보고 서버에 올리면 그대로 동작합니다.
- **아이템 배열 데이터 모델** — n8n처럼 노드 사이를 아이템 배열이 흐르고, 일반 노드는 단일 아이템만 다루면 엔진이 반복합니다. IF/Switch/필터는 아이템 단위로 분기하고, Continue On Fail 시 실패 아이템만 DLQ로 격리됩니다.
- **MCP 양방향** — 저장된 워크플로가 MCP 도구(`run_<id>`)로 노출되어 Claude가 직접 실행할 수 있고, 반대로 외부 MCP 서버(stdio)의 도구를 노드·에이전트에서 호출합니다.
- **운영 기능** — 노드별 재시도·실패 무시·배치 크기·배치 지연, 실행 기록, DLQ UI, 크리덴셜 암호화 저장(`.enckey`), 크론 스케줄러, 웹훅 트리거.
- **외부 연동** — YouTube Data API(OAuth 2.0 리프레시 토큰, resumable 업로드), Slack, 쿠팡 파트너스(HMAC 서명), 알리익스프레스(TOP 프로토콜), 링크프라이스, Blogger, Edge TTS.

**바로 실행**: 아래 [Docker로 실행](#docker로-실행-권장--단일-컨테이너) 참고. 개발 모드는 `npm install` 후 `npm run dev`(프론트 5173) + `node server/index.js`(API 8787).

**테스트**: `npm test` — `tests/engine/` 에 엔진 단위·통합 테스트, `tests/server/` 에 API 인증 테스트. 엔진 테스트를 붙이면서 실제 버그 두 개를 찾아 고쳤습니다.
- 중복 제거 노드가 중첩 객체를 비교하지 못해 `{u:{id:1}}` 과 `{u:{id:2}}` 를 같은 아이템으로 지우던 문제 (`JSON.stringify` 배열 replacer 가 모든 깊이에 같은 키 목록을 적용하는 동작 때문)
- `"{{ a }} {{ b }}"` 처럼 표현식 두 개로만 된 문자열이 `undefined` 가 되던 문제 (단일 표현식 판별 정규식이 두 개를 하나로 잡음)

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

## AI 노드 평가 (evals)

LLM 노드의 프롬프트를 고쳤을 때 "더 좋아진 것 같다"가 아니라 **통과율과 회귀 목록**으로 확인합니다. 평가 파일에 노드 설정과 입력·기대값을 적어 두면, 같은 설정을 입력 전부에 돌려 리포트를 냅니다.

```bash
npm run eval -- evals/customer-inquiry.json                                    # 실제 모델 (ANTHROPIC_API_KEY 필요)
npm run eval -- evals/customer-inquiry.json --runs 3                           # 케이스마다 3번 돌려 일관성 확인
npm run eval -- evals/customer-inquiry.json --baseline evals/reports/이전.json  # 이전 리포트와 비교 → 회귀·개선 목록
npm run eval -- evals/customer-inquiry.json --dry-run                          # 키 없이 실행기·리포트만 확인 (가짜 LLM)
```

- 평가 파일 `evals/customer-inquiry.json`: 쇼핑몰 고객 문의 20건 → `aiExtract` 노드로 `category`(배송·환불·교환·상품문의·결제·기타)와 `urgent`(시급 여부)를 추출하고, 케이스마다 기대값을 검사로 적어 둡니다.
- 검사 종류: `equals` · `oneOf` · `contains` · `notContains` · `regex` · `maxChars` · `type` · `hasKeys` · `defined`. 한 검사 객체에 여러 조건을 넣으면 전부 만족해야 하고, 파일 상단 `checks` 는 모든 케이스에 공통 적용됩니다.
- 리포트는 `evals/reports/` 에 JSON 으로 남아 다음 실행의 `--baseline` 이 됩니다. 통과율만이 아니라 **어느 케이스가 새로 깨졌는지**를 이름으로 짚습니다.
- API 키가 없으면 실제 평가는 시작하지 않습니다. 시뮬레이션 응답으로 만든 0% 리포트는 의미가 없기 때문입니다.
- 구현: `server/evals.js` (노드 `run()` 을 엔진과 같은 방식으로 호출 · 검사 · 리포트 · CLI), 테스트: `tests/server/evals.test.js` (가짜 LLM 주입)

리포트 모양 — 아래는 `--dry-run` 출력입니다. 키워드 규칙으로 답을 지어내는 가짜 LLM 이라 **모델 품질과 무관**하고, 8번은 "반품… 배송비" 문장이 키워드 규칙에 걸려 틀린 것입니다.

```
평가: 고객 문의 분류 · 노드 aiExtract · 모델 claude-haiku-4-5-20251001 · 케이스 20

 1  ✔  배송 지연
 2  ✔  오늘 도착 문의(급함)
 ⋮
 8  ✖  단순 변심 반품
        - extracted.category: "배송" ≠ "환불"
 ⋮
20  ✔  행사 전 배송(급함)

통과 19/20 (95%) · 평균 0ms/케이스 · 토큰 -
기준 대비: +16 (15% → 95%)
  개선 16: 배송 지연, 사이즈 교환, 파손 환불, …
```

(마지막 두 줄은 `--baseline` 으로 이전 리포트를 넘겼을 때 붙습니다. 위 예에서는 가짜 LLM 의 키워드 매칭을 고치기 전 리포트를 기준으로 삼았습니다.)

## Docker로 실행 (권장 · 단일 컨테이너)

```bash
cp .env.example .env      # CONDUIT_API_KEY 를 채울 것 — 컨테이너 밖에서 오는 요청은 로컬이 아니다
docker compose up -d --build
```

→ http://localhost:8787 (프론트엔드 + API + 웹훅이 한 포트로 동작). 처음 열면 사이드바 **설정**에 `.env` 의 키를 입력하세요.

- 데이터(워크플로·크리덴셜·실행기록·DLQ)는 named volume `conduit-data` 에 영속화됩니다.
- ⚠️ 이 볼륨에 크리덴셜 **암호화 키(`.enckey`)**가 들어 있으니 삭제하지 마세요. 삭제 시 저장된 크리덴셜 복호화가 불가능해집니다.
- `HEALTHCHECK` 로 `/api/health` 를 감시하고, 로그는 10MB×3 로테이션됩니다.
- 컨테이너는 non-root(`node`) 유저로 실행됩니다.

## MCP 지원 (양방향)

Conduit는 **MCP(Model Context Protocol)** 를 양쪽 방향으로 지원합니다.

### 1) Conduit → MCP 서버 사용 (클라이언트)

외부 MCP 서버(stdio)의 도구를 워크플로/에이전트에서 호출합니다.

- **등록**: 자격 증명 → `MCP 서버 (stdio)` → `command`(예: `npx` 또는 `node`) + `args`
  - 예: `npx` / `-y @modelcontextprotocol/server-filesystem C:/data`
  - 데모: `node` / `C:/workflow/flowforge/examples/sample-mcp-server.mjs` (echo·add 도구 포함)
- **MCP 도구 호출 노드** (연동 카테고리): 도구 이름 비우면 목록 조회, 지정하면 호출. 인자는 JSON + 표현식 지원.
- **에이전트 도구**: `mcp_list_tools` · `mcp_call` — 에이전트가 스스로 MCP 도구를 탐색·호출.
- 프로세스는 서버 이름별 1개를 띄워 재사용하고, initialize 핸드셰이크 후 `tools/list`·`tools/call` JSON-RPC 로 통신.

검증됨: 샘플 서버 접속 → 도구 목록(echo·add) → 표현식 인자로 `add(2,3)` 호출 → `"5"` ✅

### 2) Claude → Conduit 사용 (서버)

Conduit 자체가 MCP 서버가 되어, **저장된 워크플로가 MCP 도구(`run_<id>`)로 노출**됩니다.

```bash
claude mcp add --transport http conduit http://localhost:8787/mcp
# CONDUIT_API_KEY 를 설정했다면 헤더를 함께
claude mcp add --transport http conduit http://localhost:8787/mcp --header "Authorization: Bearer <키>"
```

**stdio 로만 MCP 서버를 붙일 수 있는 클라이언트**(Claude Desktop 설정 파일, Cursor 등)에는 패키지 [`conduit-workflows-mcp`](packages/conduit-workflows-mcp) 를 씁니다. Conduit 의 `/mcp` 앞에 붙는 얇은 stdio 다리이고, 도구 정의는 Conduit 한 곳에만 있습니다.

> **아직 npm 에 게시하지 않았습니다.** 게시 전에는 아래 예시의 `npx -y conduit-workflows-mcp` 자리에
> `node <이 저장소 경로>/packages/conduit-workflows-mcp/bin/conduit-workflows-mcp.js` 를 씁니다 (먼저 그 폴더에서 `npm install`).

```json
{ "mcpServers": { "conduit": {
    "command": "npx", "args": ["-y", "conduit-workflows-mcp"],
    "env": { "CONDUIT_URL": "http://localhost:8787", "CONDUIT_API_KEY": "<키를 설정한 경우>" } } } }
```

```bash
claude mcp add conduit -e CONDUIT_URL=http://localhost:8787 -- npx -y conduit-workflows-mcp
```

이후 Claude Code/Desktop 에서 "conduit의 run_… 도구로 ○○ 워크플로 실행해줘"라고 하면
Claude 가 `tools/call` 로 워크플로를 실행하고 출력 노드 결과를 돌려받습니다.

검증됨: `initialize` → `tools/list`(워크플로 3개 노출) → `tools/call(input={amount:7777})` → `{"amount":7777,"ok":true}` ✅

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

## 실행 방법 (개발 모드)

이 PC는 Node.js가 **fnm**으로 설치되어 있습니다. 아래 스크립트가 환경을 잡고
**백엔드(8787) + 프론트엔드(5173)를 함께** 띄웁니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

또는 수동으로:

```powershell
fnm env --shell power-shell | Out-String | Invoke-Expression
npm install     # 최초 1회
npm run dev     # http://localhost:5173
```

프로덕션 빌드: `npm run build` → `dist/`

## 핵심 기능 (n8n 코어 재현)

- **캔버스**: 팬/줌·미니맵·노드 드래그, 우상단 `+` 로 검색형 노드 추가 패널
- **연결**: 노드 오른쪽 점(출력) → 다른 노드 왼쪽 점(입력)으로 드래그
- **실행 엔진**: 위상 정렬 후 연결 순서대로 실행하며 데이터 전달
- **표현식**: 값에 `{{ $json.필드 }}` 를 쓰면 이전 노드 데이터를 참조 (`$now`, `$items`, `$index` 도 지원)
- **분기/스킵**: IF·Switch·Filter — 안 탄 경로는 자동 스킵
- **NDV 데이터 뷰**: 노드 선택 시 설정 / **입력** / **출력** 탭으로 데이터 확인
- **실행 로그 도크** + 노드별 상태 뱃지(✓·아이템 수)
- **저장**: localStorage 자동 저장 + JSON 내보내기/불러오기

## 노드 카탈로그

| 카테고리 | 노드 |
|----------|------|
| 트리거 | 수동 트리거, 스케줄 트리거\*, Webhook 트리거\* |
| AI\* | AI · Claude, AI 구조화 추출, AI 에이전트(하네스), 루프 엔지니어링 |
| 동작 | HTTP 요청, 필드 설정(Set), 코드(JS), 날짜/시간, 해시, 키 이름 변경, 대기(Wait) |
| 흐름 제어 | IF 조건, Switch(다중분기), 필터, 병합(Merge), 중단&오류 |
| 연동\* | Slack, Gmail, Notion, YouTube 검색, Naver 검색, **HTTP 요청(인증)** |
| 출력 | 출력, No-Op |

\* 표시 노드는 **백엔드 서버 + 크리덴셜**이 필요합니다. 크리덴셜이 없으면 시뮬레이션 결과를 냅니다.

### "n8n의 모든 기능"에 대하여

n8n은 400개 이상의 통합 노드 + 웹훅 수신 서버 + 크론 스케줄러 + OAuth 크리덴셜 볼트 + 실행 기록 DB를 갖춘 거대한 제품입니다.
이 중 **웹훅 수신·스케줄 실행·실제 OAuth 연동은 브라우저만으로는 불가능**하고 백엔드(Node) 서버가 필요합니다.
Conduit 은 **n8n을 n8n답게 만드는 코어 엔진**(표현식·분기·데이터 흐름·NDV)을 재현하고,
노드는 레지스트리 한 곳에 정의만 추가하면 무한히 늘릴 수 있는 구조입니다.

## 백엔드 (server/) — 실제 자동화

프론트만으로는 불가능한 것들을 Node/Express 백엔드가 담당합니다. 실행 엔진은 프론트와 **동일 소스를 재사용**합니다.

| 기능 | 엔드포인트 / 동작 |
|------|------------------|
| 서버 실행 | `POST /api/run` — 상단바 **서버 실행** 버튼이 호출 (AI 노드가 실제로 동작) |
| 워크플로 저장 | `GET/POST/DELETE /api/workflows` (파일 영속화) |
| 웹훅 수신 | `POST /webhook/<경로>` — 활성 워크플로의 Webhook 트리거로 라우팅 |
| 스케줄 | `node-cron` — 활성 워크플로의 스케줄 트리거를 크론으로 자동 실행 |
| 크리덴셜 | `GET/POST /api/credentials` — AES-256-GCM 암호화 저장 |
| 실행 기록 | `GET /api/executions` |

검증된 예: 활성 워크플로 저장 후 `POST /webhook/hook/new-order` 로 페이로드를 보내면
Webhook 트리거에 주입되어 워크플로가 실행되고 실행 기록에 남습니다.

**활성 토글**: 상단바 `활성/비활성` 토글을 누르면 즉시 서버에 저장되며 백엔드가
크론(스케줄 트리거)과 웹훅 수신을 **바로 등록/해제**합니다. (비활성 시 웹훅은 404)

## AI 노드 (n8n이 불편한 것들)

`AI` 카테고리는 **서버 실행** 시 실제 Claude를 호출합니다 (프론트 실행 시엔 시뮬레이션).

- **AI · Claude** — 프롬프트 → 응답
- **AI 구조화 추출** — 텍스트/데이터 → JSON
- **AI 에이전트 (도구 사용)** — **실제 도구를 호출하는 tool_use 루프**. LLM이 도구를 선택하면 서버가 실행하고 결과를 되먹여 목표를 수행합니다.
  - 사용 가능 도구: `run_code`(JS 실행) · `http_get`(웹 요청) · `http_auth`(인증 요청) · `youtube_search` · `naver_search` · `slack_post` · `notion_create` · `run_workflow`(저장된 다른 워크플로를 도구로 실행 — 입력 주입, 재귀 깊이 2 제한)
  - 도구별 크리덴셜 지정 가능: `도구 크리덴셜` 필드에 `slack=내슬랙, http=깃허브` 형식.
  - NDV **출력** 탭에서 각 스텝(도구·입력·결과)이 **타임라인 UI**로 시각화되고, 마지막에 최종 답변이 표시됩니다.
  - **서버 실행**은 SSE(`/api/run/stream`)로 노드 상태·로그·에이전트 스텝을 **실시간 스트리밍** — 타임라인이 도구 호출마다 라이브로 채워집니다.
- **루프 엔지니어링** — 기준을 두고 N회 반복 개선

프롬프트에 `{{ $json.필드 }}` 표현식을 그대로 쓸 수 있어요.

### 실제 Claude 호출 켜기

둘 중 하나면 됩니다:

```powershell
# 1) 환경변수
$env:ANTHROPIC_API_KEY = 'sk-ant-...'
# 그 후 server 를 재시작

# 2) 크리덴셜로 저장 (type=anthropic)
# POST /api/credentials  { "name":"Claude", "type":"anthropic", "data": { "apiKey":"sk-ant-..." } }
```

키가 없으면 AI 노드는 시뮬레이션 응답을 내므로 워크플로는 항상 "동작"합니다.
기본 모델: `claude-sonnet-5` (옵션: `claude-opus-5`, `claude-haiku-4-5-20251001`).

## 실연동 노드 (실제 API 호출)

`연동` 카테고리는 **서버 실행** 시 저장된 크리덴셜로 실제 API를 호출합니다.

| 노드 | 필요한 크리덴셜 |
|------|----------------|
| Slack 메시지 | `slack` — Bot Token (`xoxb-…`) |
| Gmail 보내기 | `gmail` — Gmail 주소 + 앱 비밀번호(SMTP) |
| Notion 페이지 생성 | `notion` — Integration Token |
| YouTube 검색 | `youtube` — Data API Key |
| Naver 검색 | `naver` — Client ID + Secret |
| **HTTP 요청(인증)** | `httpAuth` — Bearer / API 키 헤더 / Basic |

### "어떤 API든 연결" — 범용 HTTP 노드

**HTTP 요청(인증)** 노드는 Bearer 토큰·API 키 헤더·Basic 인증을 지원해
GitHub·Stripe·OpenAI·Discord·Airtable·SendGrid 등 **대부분의 REST API**를 노드 하나로 호출합니다.
(OAuth 전용 API는 별도 토큰 발급이 필요합니다.)

### 크리덴셜 추가

사이드바 **자격 증명** → 종류 선택 → 값 입력 → 저장.
값은 서버에서 **AES-256-GCM** 으로 암호화되어 저장되고, 목록/응답에는 노출되지 않습니다.

## 새 노드 추가하는 법

`src/engine/nodeTypes.js` 의 `NODE_TYPES` 에 항목 하나만 추가하면 팔레트에 자동 등록됩니다:

```js
myNode: {
  title: '내 노드', icon: 'edit', color: '#22c55e', category: '동작',
  inputs: ['main'], outputs: ['main'],
  defaults: { greeting: '안녕 {{ $json.name }}' },
  fields: [{ key: 'greeting', label: '인사말', type: 'text' }],
  summary: (p) => p.greeting,
  run: async (inputs, params) => ({ main: { ...inputs.main, msg: params.greeting } }),
},
```

`run` 이 받는 `params` 는 실행 엔진이 표현식을 이미 해석해서 넘겨줍니다.

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

## 📅 개발 일지

### 2026-08-02 — 프로젝트 시작 & 완성 (1일차)

하루 만에 0 → 풀스택 자동화 플랫폼까지. 작업 순서대로:

**오전~오후: 기반 구축**

1. **환경**: Node.js v24 설치(fnm), Vite + React + React Flow 스캐폴딩
2. **에디터**: 캔버스(팬/줌/미니맵), 노드 연결, 검색형 노드 추가 패널, 인스펙터, 실행 로그
3. **디자인**: Claude 감성(크림 #f4f1ea + 코랄 #cc785c), 라인 SVG 아이콘, SaaS 셸(사이드바/상단바). 이름 FlowForge → **Conduit**
4. **실행 엔진**: 위상정렬 실행 + `{{ $json.필드 }}` 표현식 + NDV(입/출력 데이터 뷰)

**오후: 백엔드 & AI**

5. **Express 백엔드**: 서버 실행 API, 워크플로 CRUD, 웹훅 수신, node-cron 스케줄러, AES-256-GCM 크리덴셜, 실행 기록
6. **AI 노드 4종**: AI·Claude / 구조화 추출 / **에이전트(tool_use 루프)** / 루프 엔지니어링
7. **실연동**: Slack·Gmail(SMTP)·Notion·YouTube·Naver + **범용 인증 HTTP**(Bearer/API키/Basic)
8. **에이전트 고도화**: 실도구 8종 + 도구별 크리덴셜 주입 + **타임라인 UI** + **SSE 실시간 스트리밍** + **서브워크플로 도구(run_workflow)**
9. **SaaS 화면**: 크리덴셜 매니저, 실행 기록 화면, 다중 워크플로 저장/전환, 활성 토글→크론/웹훅 즉시 등록

**저녁: 신뢰성 & 아키텍처**

10. **신뢰성 전체 스펙 구현**: 재시도(지수백오프+지터, 일시/영구 오류 구분) · Continue On Fail · DLQ(+replay) · 웹훅 HMAC 서명검증 4종(slack/github/stripe/generic, 상수시간 비교+리플레이 윈도우) · 멱등성(중복 실행 차단) · **Error Trigger 전역 에러 핸들러**
11. **아이템 배열 데이터 모델**(n8n식): 아이템별 자동 반복 실행·아이템별 IF 라우팅·아이템별 오류 격리·배치 병렬+지연. 배열 노드 6종(SplitOut/Aggregate/Sort/중복제거/Limit/Merge)
12. **Docker**: 멀티스테이지 Dockerfile + compose(볼륨/헬스체크/non-root). 단일 포트(8787) 프로덕션 서빙 검증
13. **MCP 양방향**: ① 클라이언트 — stdio MCP 서버 접속(mcpTool 노드 + 에이전트 mcp_call), ② 서버 — `/mcp` 엔드포인트로 워크플로를 Claude의 도구로 노출

**최종 상태**: 노드 40여 종 · 8개 카테고리, 모든 기능 엔드투엔드 검증 완료.

**내일 후보**
- [ ] `claude mcp add` 로 Conduit 등록해 Claude가 워크플로 실행하는 것 실제 시연
- [ ] MCP 도구 자동 노드화 (연결된 서버의 도구가 노드 패널에 자동 표시)
- [ ] DLQ 화면 (UI에서 실패 항목 조회·재실행)
- [ ] 캔버스 라이브 아이템 카운터
- [ ] Docker Desktop 설치 후 실제 컨테이너 기동 테스트

**재시작 방법**
```powershell
powershell -ExecutionPolicy Bypass -File C:\workflow\flowforge\start.ps1
```
(백엔드 8787 + 프론트 5173 함께 기동. node는 fnm으로 설치되어 있어 스크립트가 환경을 잡아줌)

### 2026-08-03 — 2일차: 운영 편의 기능

1. **DLQ 화면** — 사이드바 "실패 큐 (DLQ)" 메뉴 → 실패 항목 목록(노드·워크플로·시각·상태) + 격리 페이로드 미리보기 + **↻ 재실행** / 삭제. (재실행은 저장된 워크플로만 가능)
2. **MCP 도구 자동 노드화** — `GET /api/mcp/tools` 로 등록된 MCP 서버들의 도구를 수집, 노드 추가 패널에 **"MCP · <서버명>"** 그룹으로 자동 표시. 클릭하면 크리덴셜·도구명이 프리셋된 MCP 노드가 추가됨. 검색도 됨.
3. **캔버스 라이브 아이템 카운터** — 아이템을 여러 개 처리하는 노드는 실행 중 노드 아래에 **`1/4 → 2/4 → 3/4`** 진행이 실시간 표시(SSE `progress` 이벤트). 완료되면 "4 items"로 전환.
   - 검증: 4아이템×500ms 대기 워크플로 실행 중 라이브 값 `1/4 → 2/4 → 3/4` 포착 ✅

**남은 후보**: `claude mcp add` 실등록 시연 · Docker Desktop 설치 후 컨테이너 기동 테스트

### 2026-08-09 ~ 08-10 — 영상 자동화 기능

이 기간에 만든 기능만 정리했다. (당시 채널에 올렸던 영상은 모두 내렸고, 채널 운영 기록은 이 문서에서 뺐다.)

1. **`Workflows.save` 부분 업데이트 수정** — 넘긴 필드만 갱신, 생략 필드는 기존 값 유지 (노드 유실 버그 해결)
2. **.env 체계** — 프로젝트 루트 `.env` 를 백엔드가 자동 로드(`process.loadEnvFile`). 크리덴셜 저장소가 비면 .env 값으로 폴백.
3. **영상 노드: 쇼츠 렌더 · YouTube 업로드** — 렌더는 `npx remotion render` → ffmpeg(CRF23 · faststart · `loudnorm I=-14`) → 썸네일 → ffprobe 검증. 업로드는 OAuth 리프레시 토큰 resumable 업로드, 예약 공개(`publishAt`), 크리덴셜 없으면 시뮬레이션. n8n이라면 외부 유료 렌더 API가 필요한 부분을 로컬에서 처리한다.
4. **TTS 내레이션(무료) 노드** — 1순위 Edge TTS(`msedge-tts`, 한국어·영어 신경망 음성), 2순위 Windows SAPI(오프라인 폴백). 같은 대본+음성은 해시 캐시 재사용. 내레이션이 길면 영상 길이가 따라 늘어난다(`calculateMetadata`가 오디오 길이 반영).
5. **안정성** — 모든 `spawn`에 `error` 리스너 + 서버 전역 uncaught/unhandled 가드 (외부 프로세스 하나가 죽어도 서버가 내려가지 않게).
6. **스케줄 실행** — "매일 09:00" 워크플로: 스케줄 → 주제 로테이션 → TTS → 렌더 → 업로드 → 출력. 크론 발동은 매분 테스트 워크플로로 확인. 백엔드가 켜져 있어야 돈다.
7. **실데이터 랭킹 노드** (`rankData`, `server/rankdata.js`) — World Bank Open Data API(무료·무키)로 전 국가 값을 받아 실제 순위를 계산. 지표 6종, 6시간 캐시, 한글 국가명 매핑.
8. **영상 템플릿(Remotion 컴포지션)** — 랭킹 레이스(순위 추월 · 국기 · 카운트업 · 효과음), 두뇌퀴즈, 3D 회전 실루엣(@remotion/three), Stroop · 청력 · 색각 · 집중력 테스트. 효과음·BGM은 에셋 없이 ffmpeg로 합성. 템플릿 소스는 별도 로컬 프로젝트에 있다.
9. **오디오-화면 1:1 싱크** — 문제: 내레이션이 한 덩어리라 화면 진행과 어긋났다. 해결: 서버가 문장별 TTS를 만들고 ffprobe로 각 mp3 길이를 **실측** → `buildTimeline()`이 실측 프레임 수로 화면 타임라인을 정한다(문제 낭독이 끝나야 카운트다운 시작, 리빌 프레임 = 정답 낭독 시작 프레임). 검증: 리빌 순간의 음량 변화와 하이라이트가 같은 프레임에 온다.
10. **트러블슈팅 기록** — GLB 모델은 ThreeCanvas "바깥"에서 로드해야 `delayRender`가 추적된다 · `Sequence` 안의 `useCurrentFrame()`은 상대 프레임이다(이중 차감 버그) · 코드 노드는 동기 `new Function`이라 top-level await 불가 → `return (async () => {...})()` 패턴 · `/dashboard` 라우트는 SPA 폴백보다 먼저 등록.
11. **YouTube OAuth 발급 스크립트** — 루프백(localhost:8791) 플로우로 동의 → 리프레시 토큰 교환 → `.env` 기록. 메타데이터 수정(`videos.update`)과 댓글 API도 같은 토큰으로 호출.
12. **출처 댓글 워크플로** — 예약 영상이 공개되면 출처(논문 링크) 댓글을 자동 게시. 멱등(이미 단 댓글이 있으면 건너뜀), 26시간 재시도 창. 비공개·예약 상태에서는 댓글을 달 수 없어 공개 후에 단다.
13. **콘텐츠 규칙** — 근거 없는 수치 문구("상위 1%", "99%가") 금지. 논문·공식 통계가 있는 주장만 쓰고 출처 링크를 단다.
14. **채널 관제 화면** (`server/dashboard.html` + `/api/channel/stats`) — 채널의 최근 업로드(조회·좋아요·댓글, 예약 시각) + 워크플로 클릭 실행(confirm 가드) + 서버 상태, 30초 자동 갱신. 영상 ID를 코드에 두지 않고 업로드 목록을 그때그때 불러온다.

### 2026-09-19 — 공개 전환 · 테스트 · 보안 · 구조 · 패키지

1. **공개 저장소** — 비밀값(`.env`·`server/data`·`.enckey`)이 빠졌는지 두 번 확인한 뒤 GitHub 공개. README 상단에 개요·데모 GIF(주문 5건 분기)·CI 배지.
2. **테스트 0 → 161** — 엔진(실행 순서·분기·배치·병렬·재시도·오류 격리)·표현식·재시도 정책·노드 동작 69개로 시작. 붙이면서 **버그 2건**: `stableKey`가 중첩 객체 키를 버려 중복 제거가 `{u:{id:1}}`과 `{u:{id:2}}`를 같은 아이템으로 지움(`JSON.stringify` 배열 replacer가 모든 깊이에 적용) · `"{{ a }} {{ b }}"`가 단일 표현식으로 잡혀 `undefined`. GitHub Actions CI(푸시마다 테스트+빌드).
3. **API 인증** (`server/auth.js`) — `/api`·`/mcp`에 Bearer/X-API-Key. 키 미설정 시 127.0.0.1만 허용(X-Forwarded-For 있으면 비로컬). `timingSafeEqual`. 화면 "설정"에서 키 입력. 401 응답이 워크플로로 들어가 캔버스가 비던 버그도 수정.
4. **코드 실행 정책** (`server/policy.js`) — 서버에서 사용자 JS가 도는 입구 셋(코드 노드·`{{ }}` 표현식·에이전트 `run_code`)을 `CONDUIT_ALLOW_CODE` 하나로. 키 있는 서버는 기본 꺼짐. 꺼지면 표현식은 `new Function` 없는 경로 전용 해석기.
5. **서버 분리** — 통합 테스트 11개로 동작을 고정한 뒤 500줄 `index.js` → `app`/`runtime`/`bridges` + `routes/` 5개(동작 변경 없음). `CONDUIT_DATA_DIR`로 테스트 데이터 격리.
6. **MCP npm 패키지** `packages/conduit-workflows-mcp` — Claude Desktop·Cursor 등 stdio 전용 클라이언트용 다리(공식 SDK). 실제 서버 + 자식 프로세스 + SDK Client로 엔드투엔드 테스트. `server.json` 레지스트리 검증 통과. (npm 배포·레지스트리 등록은 계정 로그인 대기)
7. **AI 노드 평가(evals)** `npm run eval` — 고객 문의 20건, 검사 9종, `--baseline` 회귀 목록, `--runs` 일관성, `--dry-run`. 실제 모델 실행은 `ANTHROPIC_API_KEY` 필요.
8. **spawn 정리** (`server/spawn.js`) — Windows에서 `.cmd` 래퍼(npx)만 셸로, ffmpeg·node는 셸 없이. DEP0190 경고 제거. 렌더 모듈 8개의 중복 `run()` 통합.
9. **묵은 후보 정리** — Docker Desktop 실기동 검증 ✅(`compose up` → health 200 / 키 없이 401 / 키로 200 / mcp·dashboard 200, 이미지 267MB) · `claude mcp add` 시연은 패키지 README의 한 줄로 대체 · 두뇌퀴즈 공장 재실행 ✅(92초, 59초 MP4) — 오늘 손댄 뒤에도 TTS·Remotion·ffmpeg 그대로 동작.
10. 기술 글 [n8n을 직접 만들며 배운 설계 결정 6가지](docs/blog/2026-09-n8n-design-decisions.md).

12. **핫이슈 쇼츠 공장** — `hotTopics` 노드(Google 트렌드 KR RSS, 한글 필터·중복 제외) + `issueShort` 노드(헤드라인 카드, 문장별 TTS 1:1 싱크, 출처 표기) + Remotion `IssueBrief` 컴포지션. 실제 트렌드로 끝까지 실행해 41.5초 영상 확인. 워크플로 `wf_hotissue`(매일 09:00, 비활성·업로드 private로 저장).
11. **YouTube 토큰 복구** — 8월에 발급한 리프레시 토큰이 `invalid_grant`로 만료돼 있었음(동의 화면이 "테스트" 상태면 7일 제한). GCP 브랜딩에 홈페이지·[개인정보처리방침](docs/privacy-policy.md) URL과 승인 도메인을 채워 게시 상태를 **프로덕션**으로 바꾼 뒤(7일 제한 해제) 재발급. 재발급은 `node server/scripts/get-youtube-token.mjs` → 출력된 URL에서 동의 → `.env` 자동 갱신. 관제실 `/api/channel/stats` 정상 응답 확인.

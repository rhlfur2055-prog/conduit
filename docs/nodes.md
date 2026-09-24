# 노드 카탈로그

노드 59종의 분류와, 새 노드를 추가하는 방법.

## 노드 카탈로그

| 카테고리 | 노드 |
|----------|------|
| 트리거 | 수동 트리거, 스케줄 트리거\*, Webhook 트리거\* |
| AI\* | AI · Claude, AI 구조화 추출, AI 에이전트(하네스), 루프 엔지니어링, OCR, 화면 이해, 번호판 인식, 소크라테스식 읽기, 기억 검색 |
| 동작 | HTTP 요청, 필드 설정(Set), 코드(JS), 날짜/시간, 해시, 키 이름 변경, 대기(Wait) |
| 흐름 제어 | IF 조건, Switch(다중분기), 필터, 병합(Merge), 사람 승인 대기, 중단&오류 |
| 연동\* | Slack, Gmail, Notion, YouTube 검색, Naver 검색, 텔레그램, **HTTP 요청(인증)** |
| 출력 | 출력, No-Op |

\* 표시 노드는 **백엔드 서버 + 크리덴셜**이 필요합니다. 크리덴셜이 없으면 시뮬레이션 결과를 냅니다.

### "n8n의 모든 기능"에 대하여

n8n은 400개 이상의 통합 노드 + 웹훅 수신 서버 + 크론 스케줄러 + OAuth 크리덴셜 볼트 + 실행 기록 DB를 갖춘 거대한 제품입니다.
이 중 **웹훅 수신·스케줄 실행·실제 OAuth 연동은 브라우저만으로는 불가능**하고 백엔드(Node) 서버가 필요합니다.
Conduit 은 **n8n을 n8n답게 만드는 코어 엔진**(표현식·분기·데이터 흐름·NDV)을 재현하고,
노드는 레지스트리 한 곳에 정의만 추가하면 무한히 늘릴 수 있는 구조입니다.

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

## 검증된 읽기 기억 (소크라테스식 읽기 · 기억 검색)

명세·계획·작업: [specs/001-verified-memory](../specs/001-verified-memory/spec.md) · 원칙: [constitution](../.specify/memory/constitution.md)

- **상황별 청킹** — 화면(좌표로 가까운 줄) · 코드(함수) · 마크다운(제목 경로) · 표(행 + 머리글) · 대화(발화) · 짧은 글(통째) · 긴 글(시맨틱: 인접 문장 임베딩 거리 급변점)
- **검증된 것만 기억** — 원문 조각과 인용 검증을 통과한 문답만 저장. 반박된 답·근거 없는 요약은 저장하지 않는다
- **2단계 검색** — 로컬 임베딩(multilingual-e5-small)으로 후보 20개 → 리랭커(bge-reranker-v2-m3)가 채점, 문턱 미달이면 빈 결과
- **기억도 인용 검증** — 소크라테스식 읽기에서 기억은 `M1` 로 들어가고, 기억 인용도 원문 인용과 같은 코드로 대조한다. 연결 질문은 지금 글(L)과 기억(M)을 둘 다 인용해야 통과
- 실측(처음 보는 질의): 관련 질의 1등 적중 91.7% · 무관 질의 거절 100% (임베딩 유사도 0.7 기본값은 거절 0%)

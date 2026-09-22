# 개발 일지

## 개발 일지

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
10. 기술 글 [n8n을 직접 만들며 배운 설계 결정 6가지](blog/2026-09-n8n-design-decisions.md).

12. **핫이슈 쇼츠 공장** — `hotTopics` 노드(Google 트렌드 KR RSS, 한글 필터·중복 제외) + `issueShort` 노드(헤드라인 카드, 문장별 TTS 1:1 싱크, 출처 표기) + Remotion `IssueBrief` 컴포지션. 실제 트렌드로 끝까지 실행해 41.5초 영상 확인. 워크플로 `wf_hotissue`(매일 09:00, 비활성·업로드 private로 저장).
11. **YouTube 토큰 복구** — 8월에 발급한 리프레시 토큰이 `invalid_grant`로 만료돼 있었음(동의 화면이 "테스트" 상태면 7일 제한). GCP 브랜딩에 홈페이지·[개인정보처리방침](privacy-policy.md) URL과 승인 도메인을 채워 게시 상태를 **프로덕션**으로 바꾼 뒤(7일 제한 해제) 재발급. 재발급은 `node server/scripts/get-youtube-token.mjs` → 출력된 URL에서 동의 → `.env` 자동 갱신. 관제실 `/api/channel/stats` 정상 응답 확인.

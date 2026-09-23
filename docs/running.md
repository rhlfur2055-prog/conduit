# 실행 방법

Docker · 개발 모드 · 환경변수.

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

## OCR 엔진 (선택) — PaddleOCR 서버

OCR·소크라테스식 읽기 노드는 `engine: auto` 일 때 PaddleOCR 서버가 떠 있으면 그것을, 없으면 tesseract.js 를 씁니다.

| 엔진 | 줄 내용 일치 (정답을 아는 한글·영문 360줄) | 속도 |
|---|---|---|
| tesseract.js (기본 설치) | 67% | 0.2초/문서 |
| **PaddleOCR** | **97.2%** | 1.4초/문서 (CPU) |
| 앙상블 (Paddle + tesseract 글자 투표) | 96.9~97.5% | 2~3초/문서 |

```bash
# Python 3.10~3.13 (paddle 휠이 3.14 에는 없다)
pip install paddlepaddle paddleocr opencv-python numpy
python server/ocr/paddle_ocr_server.py --port 8866
```

다른 주소면 `.env` 에 `CONDUIT_PADDLE_OCR=http://host:port`.

## 스스로 일을 시작 — 목표 + 하트비트 (선택)

명세: [specs/004-goals-heartbeat](../specs/004-goals-heartbeat/spec.md)

```bash
# 목표 등록 — 받은편지함 폴더에 새 화면이 오면 "화면 읽기" 워크플로로 읽는다
curl -X POST localhost:8787/api/goals -H "Content-Type: application/json"   -d '{"text":"받은편지함에 새 화면이 오면 읽고 기억해 둔다","workflows":["<워크플로 ID>"],"inbox":"C:/inbox"}'

# 하트비트 한 번 돌리기 (또는 .env 의 CONDUIT_HEARTBEAT=*/10 * * * * 로 10분마다)
curl -X POST localhost:8787/api/heartbeat
```

- LLM 은 무엇을 할지 **제안만** 하고, 코드가 검증한 뒤 실행한다 (허용 워크플로 · 실제 근거 · 감지된 파일만).
- 밖으로 내보내는 노드(슬랙·메일·업로드·코드 실행 등)가 있는 워크플로와 확신 낮은 제안은 `GET /api/heartbeat/pending` 에서 사람이 승인한다.
- 키가 없으면 규칙 모드: 목표에 워크플로가 하나면 새 파일마다 그 워크플로를 실행한다.

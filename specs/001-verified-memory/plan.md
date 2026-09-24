# 구현 계획: 검증된 읽기 기억

명세: [spec.md](spec.md) · 원칙: [constitution](../../.specify/memory/constitution.md)

## 기술 맥락

| | |
|---|---|
| 언어 | Node.js 22 (ESM), 기존 서버 코드와 같은 스타일 |
| 임베딩 | `@huggingface/transformers` 4.x · `Xenova/multilingual-e5-small` q8 (384차원) — 캐시는 `server/data/models` |
| 저장 | `server/data/memory.json` (기존 store.js 의 원자적 쓰기 재사용). 규모가 수천 조각을 넘으면 벡터 DB 로 교체 |
| 테스트 | Vitest. 임베더는 가짜(글자 n-gram 해시 벡터)로 주입해 결정론 유지 |
| 평가 | `server/memory/eval.js` — 질의 세트로 Top-1·거절 정확도, 절반은 튜닝·절반은 시험 |
| 리랭커 | `onnx-community/bge-reranker-v2-m3-ONNX` q8 (구현 중 추가 — 임베딩 문턱만으로는 목표 미달) |

## 사전 조사 결과 (research)

- e5-small 은 관련 문장 0.88, **무관한 문장도 0.77** (실측, 한국어 질의). 코사인 절대값만으로는 관련/무관을 가르지 못한다
  → FR-004 하이브리드 + FR-005 절대 문턱과 1등 대비 차이(margin) 를 함께 본다.
- e5 계열은 입력 앞에 `query: ` / `passage: ` 를 붙여야 성능이 나온다.
- 한국어 문장 분리: `다.` `요.` `?` `!` `.` + 줄바꿈. 숫자 소수점(`3.5`)·약어(`e.g.`)는 자르지 않는다.
- 시맨틱 청킹: 인접 문장 임베딩의 코사인 거리를 구해, 거리 분포의 상위 백분위(기본 90%)를 넘는 곳에서 자른다.
  최소 2문장·최대 800자로 제한한다.

## 구조

```
server/memory/
  chunkers.js   detectKind() + 종류별 청킹 (prose 는 임베더를 받아 시맨틱)     — 순수 함수
  embedder.js   로컬 e5 임베더 (지연 로딩, 싱글턴) · 실패 시 null                 — 부수효과
  retrieve.js   하이브리드 점수 · 문턱/차이 판정 · 기억 인용 검증 헬퍼           — 순수 함수
  memory.js     remember(docs) / recall(query) — store + embedder + chunkers 조립
server/socratic.js   기억 주입(M1..Mk) · connection 질문 · 기억 인용 검증 · 끝나면 remember
server/store.js      Memory 저장소 (memory.json)
```

### 데이터 모델 (memory.json 한 조각)

```json
{
  "id": "m_1a2b3c4d",
  "type": "source | fact",
  "kind": "prose | markdown | table | dialogue | code | screen | short",
  "text": "원문 조각 또는 검증된 사실 문장",
  "quote": "fact 일 때 근거 인용 (원문 그대로)",
  "docId": "d_…", "lines": ["L3", "L4"],
  "source": { "title": "…", "readAt": "ISO", "ocrEngine": "paddle", "ocrConfidence": 97 },
  "key": "정규화 텍스트 해시 (중복 방지)",
  "embedding": [384 floats] | null
}
```

### 검색 점수

```
score = 0.7 · cos(q, c)  +  0.3 · overlap(q, c)        overlap = 글자 2-gram 자카드
통과 조건: score ≥ T_abs  그리고  score ≥ top1 − margin   그리고  cos ≥ C_min
```
`T_abs · margin · C_min` 은 평가 세트 절반으로 고른다 (원칙 IV).

### socraticRead 연결

1. 원문 줄이 확정되면 → 앞 몇 줄 + focus 로 `recall` → 통과한 기억만 `M1..Mk` 로 프롬프트에 넣는다.
2. 검증기는 `L*` 는 원문 줄에서, `M*` 는 기억 조각에서 대조한다 (같은 `verifyEvidence`).
3. `connection` 유형은 L 인용과 M 인용이 모두 있어야 verified.
4. 끝나면 `remember`: 원문(종류별 청킹) + verified 문답(`fact`). refuted · dropped 는 넣지 않는다.

## 원칙 점검

| 원칙 | 이 계획에서 |
|---|---|
| I 검증은 모델 밖 | 기억 인용(M)도 코드 대조. 검색 통과 판정도 코드 |
| II 모르면 모른다 | 검색 문턱 미달 → 빈 결과 → 연결 질문은 unanswerable |
| III 검증된 것만 기억 | remember 는 source + verified fact 만 받는다 (타입으로 강제, 테스트로 고정) |
| IV 숫자는 재서 | 검색 Top-1·거절률을 절반 튜닝/절반 시험으로 잰다 |
| V 없어도 멈추지 않음 | 임베더 없으면 글자 겹침 검색으로 떨어지고 이유를 남김 |
| VI 테스트가 먼저 | 청킹·점수·저장 규칙은 가짜 임베더로 먼저 테스트 |

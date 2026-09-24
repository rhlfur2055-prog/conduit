# 작업 목록: 검증된 읽기 기억

`[P]` = 다른 작업과 파일이 겹치지 않아 병렬 가능. 테스트 작업이 구현보다 먼저 온다 (원칙 VI).

## 1단계 — 기반
- [x] T001 `@huggingface/transformers` 설치, e5-small 로딩·임베딩 실측 (로딩 17초 · 0.1초/배치 · 관련 0.88 / 무관 0.77)
- [x] T002 `store.js` 에 `Memory` 저장소 (add · all · byKey · reset)

## 2단계 — 청킹 (US2)
- [x] T003 [P] 테스트: `detectKind` 7종 판별, 종류별 청킹 결과, 결정론(같은 입력 100회)
- [x] T004 `server/memory/chunkers.js` — 문장 분리 · markdown · table · dialogue · code · screen · short · prose(시맨틱)

## 3단계 — 임베딩·검색 (US1, US4)
- [x] T005 [P] 테스트: 하이브리드 점수, 문턱·차이 판정, 무관 질의 거절, 임베더 없을 때 글자 겹침으로 떨어짐
- [x] T006 `server/memory/embedder.js` — 지연 로딩 싱글턴, query/passage 접두어, 실패 시 null
- [x] T007 `server/memory/retrieve.js` — score · 통과 판정
- [x] T008 `server/memory/memory.js` — remember / recall

## 4단계 — 검증된 것만 기억 (US3)
- [x] T009 [P] 테스트: refuted · dropped 는 저장 안 됨, source + verified fact 만 저장, 중복 저장 없음, 출처 필드
- [x] T010 socraticRead 끝에 remember 연결

## 5단계 — 기억을 문맥으로 (US1)
- [x] T011 [P] 테스트: M 인용 검증(기억에 없는 인용 반박), connection 유형은 L+M 둘 다 필요, 관련 기억 없으면 unanswerable
- [x] T012 socraticRead 에 recall → M1..Mk 주입, verifyEvidence 가 M 줄도 대조, connection 유형 추가
- [x] T013 노드 옵션 `memory` (on/off) + 기억 검색 노드 `memoryRecall`

## 6단계 — 평가 (SC-002, SC-003)
- [x] T014 질의 세트 작성 (관련 질의 + 무관 질의, 한·영)
- [x] T015 `server/memory/eval.js` — 절반으로 문턱 고르고 절반으로 Top-1·거절률 측정
- [x] T016 측정값을 spec.md 성공 기준 옆에 기록 · 문턱 기본값 반영

## 계획에서 바뀐 것
- 임베딩 문턱만으로는 SC-002·SC-003 을 못 넘었다 (e5-small 58%/83%, e5-base 83%/83%). 리랭커(cross-encoder) 2단계를 추가했다 — `server/memory/reranker.js`.
- 평가 스크립트 위치: `server/memory/eval.js`, 데이터 `evals/memory-recall.json`.
- 함정 질의는 검색 거절 지표에서 빼고 따로 기록 (검색이 아니라 인용 검증의 몫).

## 7단계 — 마무리
- [x] T017 전체 테스트 · lint · build · 문서(docs/nodes.md)

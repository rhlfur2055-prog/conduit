# AI 노드 평가 (evals)

프롬프트를 바꿨을 때 "느낌" 이 아니라 통과율과 회귀 목록으로 비교한다.

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

# 제휴 키 발급 로드맵

작성 2026-08-18. 코드가 실제로 요구하는 값 기준으로 정리.

---

## 한 줄 요약

**링크프라이스는 이미 열려 있습니다.** 별도 발급 없이 오늘부터 수익 링크를 만들 수 있고,
막고 있는 건 제휴 키가 아니라 **Blogger 발행 토큰** 하나입니다.

쿠팡파트너스는 API 이전에 **누적 판매 15만원**이라는 관문이 있어서, 수동 링크로 먼저 파는 것 외에 우회로가 없습니다.

---

## 현재 상태

| 경로 | 상태 | 막고 있는 것 | 난이도 |
|---|---|---|---|
| **링크프라이스 딥링크** | ✅ **동작 확인됨** | 없음 | — |
| 링크프라이스 실적 조회 | ⚠️ 키 없음 | `LINKPRICE_AUTH_KEY` | 낮음 (즉시 발급) |
| Blogger 발행 | ❌ 토큰 없음 | `BLOGGER_REFRESH_TOKEN`, `BLOGGER_BLOG_ID` | 낮음 (스크립트 준비됨) |
| 쿠팡파트너스 API | ❌ 미승인 | 누적 판매 15만원 → 최종 승인 | **높음 (실적 필요)** |
| 알리익스프레스 API | ❌ 키 없음 | `ALI_APP_KEY`, `ALI_APP_SECRET` | 중간 |

### 검증 방법

```
node -e "..." → linkprice.makeDeeplinks() 실제 호출
결과: simulated=false, 생성된 URL 에 본인 A_ID 포함 확인
```

`LINKPRICE_A_ID`가 `A` + 숫자 9자리 형식과 일치 → 이미 가입 완료 상태입니다.

---

## 1. 링크프라이스 — 이미 열림, 마무리만

### 왜 이미 되는가

`server/linkprice.js`의 `makeDeeplinks()`는 **`LINKPRICE_A_ID`만** 필요합니다.
딥링크는 API 호출이 아니라 URL 조립이기 때문입니다.

```
https://click.linkprice.com/click.php?m={머천트}&a={내 A_ID}&l=0000&url={상품URL}
```

`auth_key`는 **실적 조회(`fetchReport`)에만** 쓰입니다. 수익 발생과는 무관합니다.

### 남은 할 일

1. **`LINKPRICE_AUTH_KEY` 발급** — 어필리에이트센터(`ac.linkprice.net`)에서 32자리 키.
   수익에는 영향 없고, 대시보드에서 실적을 자동으로 끌어오려면 필요합니다.
2. **커미션 수령 조건 충족** — 개인은 실명 인증 + 본인 명의 계좌 등록.
   계좌가 등록돼 있지 않으면 수익이 쌓여도 지급되지 않습니다.
3. **머천트별 `deeplink_yn` 확인** — 머천트 조회 노드로 확인.
   `deeplink_yn=N`인 머천트는 상품 URL 딥링크로 실적이 안 잡힙니다.

### 주의

딥링크 규격은 어필리에이트센터의 딥링크 도구에서 나오는 URL과 **한 번 대조**해보시는 게 안전합니다.
`l=0000` 파라미터가 계정/캠페인에 따라 다를 수 있습니다.

---

## 2. 쿠팡파트너스 — 관문이 있음

### 조건

가입 후 **누적 판매 합산 15만원**을 넘겨야 최종 승인이 나고,
승인돼야 **정산과 API가 함께 열립니다.**

`wf_coupangmanual` 워크플로 이름의 "최종승인 전"이 정확히 이 단계를 가리킵니다.

### 그래서 순서가 정해져 있음

```
수동 링크로 포스팅  →  누적 판매 15만원 달성  →  최종 승인  →  API 키 발급  →  자동화
```

**API를 먼저 받아서 자동화로 15만원을 채우는 건 불가능합니다.** 순서가 반대입니다.
이 구간은 `wf_coupangmanual`(파트너스 대시보드에서 링크 복사 → 붙여넣기)로 버텨야 합니다.

### 발급 후

`.env`에 두 줄:

```
COUPANG_ACCESS_KEY=...
COUPANG_SECRET_KEY=...
```

`COUPANG_SUB_ID`는 이미 설정돼 있습니다. 인증은 CEA HMAC-SHA256이고 `server/coupang.js`에 구현 완료 상태라,
키만 넣으면 골드박스·카테고리 베스트·키워드 검색·딥링크·실적 리포트가 즉시 동작합니다.

---

## 3. 알리익스프레스 — 중간 난이도

### 절차

1. `portals.aliexpress.com` 접속 → Register (기존 알리 계정 있으면 Sign In)
2. 어필리에이트 승인 후 **Tools > API** 메뉴에서 AppKey / Secret 발급
3. Tracking ID 생성

```
ALI_APP_KEY=...
ALI_APP_SECRET=...
ALI_TRACKING_ID=...
```

### 코드에 이미 반영된 정책 주의사항

`server/aliexpress.js` 주석:

> ⚠️ 2025-03 정책: 어필리에이트 미등록 상품은 수수료 1% — commission 필터 필수

즉 **아무 상품이나 링크 걸면 수수료가 1%로 깎입니다.** 어필리에이트 등록 상품만 골라야 합니다.
이 필터는 코드에 이미 들어가 있습니다.

---

## 실행 순서 (권장)

| 순서 | 할 일 | 소요 | 얻는 것 |
|---|---|---|---|
| **1** | `node server/scripts/get-blogger-token.mjs` → `.env` 두 줄 | 5분 | **발행 해금 — 이게 진짜 병목** |
| **2** | 링크프라이스 실명인증 + 계좌 등록 | 10분 | 수익 지급 가능 상태 |
| **3** | `LINKPRICE_AUTH_KEY` 발급 | 5분 | 실적 자동 조회 |
| **4** | `wf_lpmanual`로 초안 1개 → 눈으로 확인 → `isDraft=false` | 30분 | **첫 수익 링크 발행** |
| **5** | 쿠팡 수동 링크로 포스팅 누적 | 수주~ | 15만원 달성 → API 승인 |
| **6** | 알리 포털 가입 → API 키 | 1~2주 | 해외직구 카테고리 확장 |

**1~4번이면 오늘 안에 실제 수익 링크가 붙은 글이 발행됩니다.** 5·6번은 시간이 필요한 트랙이라
병행해서 굴리는 게 맞습니다.

---

## 확인이 필요한 항목

아래는 검색으로 확정하지 못했습니다. 각 사이트에서 직접 확인해주세요.

- 링크프라이스 `auth_key`의 정확한 발급 위치 (어필리에이트센터 내 메뉴 경로)
- 알리익스프레스 어필리에이트의 현재 승인 조건 (심사 여부·소요 기간)
- 쿠팡파트너스 15만원 기준이 **판매액**인지 **수익액**인지 — 출처마다 표현이 갈립니다

---

## 출처

- [쿠팡 파트너스 최종승인 · API 활성화 방법](https://mg.jnomy.com/coupang-partners-verify)
- [쿠팡 파트너스 하는법 (가입·수수료·정산)](https://choicemon.com/coupang-partners-guide/)
- [링크프라이스 어필리에이트 가이드](https://www.linkprice.com/views/affiliateguide/guide02.html)
- [링크프라이스 AffiliateSetup (GitHub)](https://github.com/linkprice/AffiliateSetup)
- [알리익스프레스 어필리에이트 API 발급받기](https://worktimesaver.inblog.ai/%EC%95%8C%EB%A6%AC%EC%9D%B5%EC%8A%A4%ED%94%84%EB%A0%88%EC%8A%A4-%EC%96%B4%ED%95%84%EB%A6%AC%EC%97%90%EC%9D%B4%ED%8A%B8-api-%EB%B0%9C%EA%B8%89%EB%B0%9B%EA%B8%B0-25784)

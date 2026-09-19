// ============================================================
// 블로그 문구 생성기 — LLM 없이도 글마다 다른 문장을 만든다
//
//   왜 필요한가: 고정 문장 4종을 날짜로 돌리면 4일마다 같은 글이 나온다.
//   검색엔진은 이를 중복 콘텐츠로 보고 색인에서 밀어낸다. 색인이 밀리면
//   방문자가 없고, 방문자가 없으면 제휴 수익도 0이다.
//
//   방식: 문장 풀을 슬롯별로 나누고 조합한다. 각 슬롯이 독립적으로 완결된
//   문장이라 조각을 이어붙일 때 생기는 어색한 한국어가 나오지 않는다.
//
//   ⚠️ 절대 규칙: 주어진 사실(상품명·가격·카테고리·배송·할인)만 쓴다.
//   스펙·성능·후기 수치·판매량·순위는 지어내지 않는다. 확인 불가한 수치를
//   쓰면 낚시가 되고, 낚시로 판명되는 순간 블로그 신뢰가 무너진다.
// ============================================================

const fmtWon = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';

/* ---------- 한국어 조사 자동 선택 ----------
   "무선 청소기은(는)" 같은 표기는 기계가 쓴 티가 나고 글의 신뢰를 깎는다.
   마지막 글자의 받침 유무로 조사를 골라준다. */
export function josa(word, pair) {
  const [withBatchim, withoutBatchim] = pair.split('/');
  const last = String(word || '').trim().slice(-1);
  const code = last.charCodeAt(0);
  // 한글 음절이 아니면(영문·숫자 등) 받침 없는 쪽으로 둔다
  if (!(code >= 0xac00 && code <= 0xd7a3)) return withoutBatchim;
  return (code - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}
const J = (w, pair) => w + josa(w, pair);

/* ---------- 시드 & 추첨 ---------- */
// 같은 입력 → 같은 결과(재현 가능), 입력이 조금만 달라도 완전히 다른 조합
export function seedOf(...parts) {
  let h = 2166136261;
  const s = parts.filter(Boolean).join('|');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
// 선형합동 난수 — 시드 하나에서 독립적인 추첨을 여러 번 뽑는다
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const draw = (arr, r) => arr[Math.floor(r() * arr.length)];

/* ---------- 서론: 3슬롯 (상황 → 이 글이 주는 것 → 읽는 법) ---------- */
const INTRO_SITUATION = [
  (kw) => `${kw} 사려고 검색하다 보면 가격이 제각각이라 어디가 싼지 헷갈립니다.`,
  (kw) => `${J(kw, '은/는')} 모델과 옵션이 많아서 비교하는 데만 시간이 꽤 걸립니다.`,
  (kw) => `${kw} 알아보다가 창을 여러 개 띄워놓고 헤매신 적 있으실 겁니다.`,
  (kw) => `${kw} 가격은 재고와 프로모션에 따라 수시로 바뀝니다.`,
  (kw) => `${J(kw, '을/를')} 급하게 사야 할 때는 배송 속도까지 따져야 해서 더 복잡해집니다.`,
  (kw) => `같은 ${kw}인데도 파는 곳마다 조건이 달라 비교가 쉽지 않습니다.`,
  (kw) => `${J(kw, '은/는')} 한 번 사면 오래 쓰는 물건이라 고민이 길어지기 마련입니다.`,
  (kw) => `${kw} 예산을 정해놓고 찾다 보면 조건에 맞는 걸 고르기가 은근히 어렵습니다.`,
];
const INTRO_OFFER = [
  () => `그래서 지금 특가로 올라온 것들만 골라 한자리에 정리했습니다.`,
  () => `이 글에는 오늘 시점의 특가 목록을 가격순으로 묶어두었습니다.`,
  () => `아래에 지금 확인 가능한 조건들을 표처럼 정리해 두었습니다.`,
  () => `여기저기 흩어진 특가를 한 번에 볼 수 있게 모았습니다.`,
  () => `오늘 기준으로 살펴볼 만한 것들을 추려 담았습니다.`,
  () => `가격과 배송 조건을 나란히 놓고 볼 수 있게 정리했습니다.`,
  () => `일일이 검색하지 않아도 되도록 조건별로 묶어봤습니다.`,
  () => `지금 시점에 비교할 만한 선택지들을 모아두었습니다.`,
];
const INTRO_HOWTO = [
  () => `예산이 정해져 있다면 가격부터, 급하시면 배송 항목부터 보시면 빠릅니다.`,
  () => `순서는 참고용이니 조건을 먼저 보고 고르시는 편이 낫습니다.`,
  () => `가격은 계속 바뀌므로 마음에 드는 게 있으면 링크에서 오늘 조건을 확인해보세요.`,
  () => `배송 방식이 각각 다르니 받아야 하는 날짜를 먼저 정해두시면 고르기 쉽습니다.`,
  () => `아래 항목 중 본인 조건에 맞는 것만 골라 보셔도 충분합니다.`,
  () => `각 항목의 가격과 배송을 먼저 훑고, 끌리는 것만 상세 페이지로 넘어가시면 됩니다.`,
  () => `전부 볼 필요는 없고 조건이 맞는 것부터 확인해보시길 권합니다.`,
  () => `상세 스펙은 링크 안에서 확인하실 수 있으니 여기서는 조건만 비교해보세요.`,
];

/* ---------- 마무리: 2슬롯 ---------- */
const OUTRO_CAUTION = [
  () => `가격과 재고는 수시로 바뀌니 구매 전 링크에서 오늘 조건을 꼭 확인하세요.`,
  () => `표시된 금액은 작성 시점 기준이라 지금은 달라졌을 수 있습니다.`,
  () => `특가는 수량이 한정된 경우가 많아 조기에 마감되기도 합니다.`,
  () => `할인율은 원가 기준이 판매처마다 다를 수 있으니 최종 결제 금액으로 비교하세요.`,
  () => `옵션에 따라 가격이 달라지는 상품이 있으니 선택 후 금액을 다시 보시는 게 좋습니다.`,
  () => `배송비 포함 여부까지 계산해야 실제로 얼마인지 나옵니다.`,
];
const OUTRO_CLOSING = [
  () => `다음 글에서 또 괜찮은 조건으로 찾아오겠습니다.`,
  () => `도움이 되셨다면 다음 특가 정리도 참고해주세요.`,
  () => `필요하신 품목이 있으면 댓글로 남겨주시면 다음에 함께 살펴보겠습니다.`,
  () => `더 좋은 조건이 보이면 업데이트해서 다시 정리하겠습니다.`,
  () => `비슷한 품목 정리 글도 함께 보시면 비교가 수월합니다.`,
  () => `좋은 선택 하시길 바랍니다.`,
];

/* ---------- 상품 코멘트: 사실 요약 + 확인 팁 ----------
   사실 요약은 주어진 필드에서만 구성한다(날조 방지). */
const TIP_POOL = [
  () => `상세 페이지에서 옵션별 가격 차이를 함께 보시는 걸 권합니다.`,
  () => `구매 전 후기와 옵션 구성을 같이 확인하면 실패 확률이 줍니다.`,
  () => `같은 모델이라도 판매자에 따라 조건이 다를 수 있습니다.`,
  () => `필요한 사양이 명확하다면 상세 스펙표부터 확인해보세요.`,
  () => `재고가 적으면 가격이 다시 오를 수 있으니 서두르실 필요가 있습니다.`,
  () => `사은품이나 추가 구성이 붙는 경우가 있어 상세 페이지 확인이 유리합니다.`,
  () => `교환·반품 조건은 판매자마다 다르니 미리 확인해두면 좋습니다.`,
  () => `색상이나 용량 옵션에 따라 배송일이 달라지기도 합니다.`,
];

function factSentence(p, network) {
  const bits = [];
  if (p.category) bits.push(`${p.category} 품목`);
  bits.push(`가격은 ${fmtWon(p.price)}`);
  if (network === 'ali') bits.push('해외직구라 배송 기간이 깁니다');
  else if (p.isRocket) bits.push('로켓배송 대상이라 배송이 빠른 편입니다');
  if (p.isFreeShipping) bits.push('배송비는 무료입니다');
  // "A, B, C." 형태로 자연스럽게 잇는다
  const head = bits.slice(0, -1).join(', ');
  const tail = bits[bits.length - 1];
  const body = head ? `${head}, ${tail}` : tail;
  // 이미 '~습니다/~요' 로 끝나면 마침표만, 명사로 끝나면 '입니다.' 를 붙인다
  return /(다|요)$/.test(body) ? `${body}.` : `${body}입니다.`;
}

/* ---------- 제목: 패턴 × 일 단위 날짜 ----------
   기존은 "키워드 추천 BEST N (2026년 8월 특가 정리)" 고정이라
   같은 달에 같은 키워드로 쓰면 제목이 완전히 겹쳤다. */
const TITLE_PATTERNS = [
  (kw, n, d) => `${kw} 추천 BEST ${n} (${d} 특가 정리)`,
  (kw, n, d) => `${d} ${kw} 특가 ${n}개 모음 — 가격·배송 비교`,
  (kw, n, d) => `${kw} 가성비 ${n}선, ${d} 기준으로 정리했습니다`,
  (kw, n, d) => `오늘의 ${kw} 특가 ${n}가지 (${d} 업데이트)`,
  (kw, n, d) => `${kw} 살 때 비교할 ${n}가지 — ${d} 가격 정리`,
  (kw, n, d) => `${d} ${kw} 최저가 후보 ${n}개 비교`,
  (kw, n, d) => `${kw} 어디서 살까 — ${d} 특가 ${n}개 비교`,
  (kw, n, d) => `${d} 기준 ${kw} 할인 목록 ${n}선`,
  (kw, n, d) => `${kw} 특가 정리 (${d}) — 예산별 ${n}가지`,
  (kw, n, d) => `${d} ${kw} 가격 비교, 조건 좋은 ${n}개만`,
];

/* ---------- 공개 API ---------- */
export function composeIntro(keyword, seed) {
  const r = rng(seed);
  return [draw(INTRO_SITUATION, r)(keyword), draw(INTRO_OFFER, r)(), draw(INTRO_HOWTO, r)()].join(' ');
}
export function composeOutro(seed) {
  const r = rng(seed ^ 0x5bf03635);
  return [draw(OUTRO_CAUTION, r)(), draw(OUTRO_CLOSING, r)()].join(' ');
}
export function composeComment(product, seed, index, network) {
  const r = rng(seed ^ Math.imul(index + 1, 0x9e3779b1));
  return `${factSentence(product, network)} ${draw(TIP_POOL, r)()}`;
}
export function composeTitle(keyword, count, dayLabel, seed) {
  const r = rng(seed ^ 0x1b873593);
  return draw(TITLE_PATTERNS, r)(keyword, count, dayLabel);
}

// 조합 경우의 수 (테스트/문서용)
export const VARIETY = {
  intro: INTRO_SITUATION.length * INTRO_OFFER.length * INTRO_HOWTO.length,
  outro: OUTRO_CAUTION.length * OUTRO_CLOSING.length,
  comment: TIP_POOL.length,
  title: TITLE_PATTERNS.length,
};

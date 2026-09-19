// ============================================================
// 쿠팡 파트너스 Open API 클라이언트
//   • 골드박스(오늘의 특가) / 카테고리 베스트 / 키워드 검색 / 딥링크 / 실적 리포트
//   • 인증: CEA HMAC-SHA256 (access-key + secret-key)
//   • 키가 없으면 시뮬레이션 상품을 돌려 파이프라인이 항상 동작하게 한다.
// 키 발급: partners.coupang.com → 링크 생성 → Open API (사용 조건은 파트너스 정책 참고)
// ============================================================
import crypto from 'node:crypto';
import { Credentials } from './store.js';

const DOMAIN = 'https://api-gateway.coupang.com';
const BASE = '/v2/providers/affiliate_open_api/apis/openapi';

// 공식 문서의 베스트 카테고리 ID
export const CATEGORY_IDS = {
  '여성패션': 1001, '남성패션': 1002, '뷰티': 1010, '출산/유아동': 1011,
  '식품': 1012, '주방용품': 1013, '생활용품': 1014, '홈인테리어': 1015,
  '가전디지털': 1016, '스포츠/레저': 1017, '자동차용품': 1018, '도서/음반': 1019,
  '완구/취미': 1020, '문구/오피스': 1021, '헬스/건강식품': 1024, '반려동물용품': 1029,
};

function getKeys() {
  if (process.env.COUPANG_ACCESS_KEY && process.env.COUPANG_SECRET_KEY) {
    return {
      accessKey: process.env.COUPANG_ACCESS_KEY,
      secretKey: process.env.COUPANG_SECRET_KEY,
      subId: process.env.COUPANG_SUB_ID || '',
    };
  }
  const cred = Credentials.all().find((c) => c.type === 'coupang');
  if (cred) {
    try {
      const d = Credentials.reveal(cred.id);
      if (d.accessKey && d.secretKey) return { accessKey: d.accessKey, secretKey: d.secretKey, subId: d.subId || '' };
    } catch { /* env 폴백 실패 시 시뮬레이션 */ }
  }
  return null;
}

// CEA 서명: signed-date(yyMMdd'T'HHmmss'Z' · UTC) + method + path + query
function authHeader(method, path, query, { accessKey, secretKey }) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const signature = crypto.createHmac('sha256', secretKey).update(date + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${date}, signature=${signature}`;
}

async function cpFetch(method, pathWithQuery, body, keys) {
  const [path, query = ''] = String(pathWithQuery).split('?');
  const res = await fetch(DOMAIN + path + (query ? '?' + query : ''), {
    method,
    headers: {
      Authorization: authHeader(method, path, query, keys),
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`쿠팡 API ${res.status}: ${(data.message || text).slice(0, 300)}`);
  return data;
}

const normalize = (it, rank) => ({
  rank: it.rank ?? rank,
  productId: it.productId,
  name: it.productName,
  price: Number(it.productPrice) || 0,
  image: it.productImage || '',
  url: it.productUrl || '',          // 파트너스 트래킹이 포함된 링크
  category: it.categoryName || '',
  isRocket: !!it.isRocket,
  isFreeShipping: !!it.isFreeShipping,
});

/* ---------- 시뮬레이션 상품 (키 없을 때 파이프라인 검증용) ---------- */
const MOCK = [
  { productName: '〔시뮬레이션〕 무선 물걸레 청소기', productPrice: 189000, categoryName: '생활용품', isRocket: true },
  { productName: '〔시뮬레이션〕 저소음 안마의자 목어깨 마사지기', productPrice: 129000, categoryName: '헬스/건강식품', isRocket: true },
  { productName: '〔시뮬레이션〕 스테인리스 에어프라이어 8L', productPrice: 99000, categoryName: '주방용품', isRocket: true },
  { productName: '〔시뮬레이션〕 접이식 실내 사이클', productPrice: 159000, categoryName: '스포츠/레저', isRocket: false },
  { productName: '〔시뮬레이션〕 홍삼스틱 30포 선물세트', productPrice: 49900, categoryName: '헬스/건강식품', isRocket: true },
  { productName: '〔시뮬레이션〕 4K UHD 43인치 TV', productPrice: 329000, categoryName: '가전디지털', isRocket: true },
  { productName: '〔시뮬레이션〕 메모리폼 경추 베개 2개 세트', productPrice: 39900, categoryName: '홈인테리어', isRocket: true },
  { productName: '〔시뮬레이션〕 차량용 핸디 무선 청소기', productPrice: 45900, categoryName: '자동차용품', isRocket: false },
];
const mockProducts = () => MOCK.map((m, i) => normalize({
  ...m, productId: 90000000 + i, productImage: '', productUrl: 'https://www.coupang.com/np/products/' + (90000000 + i),
}, i + 1));

/* ---------- 상품 조회 (goldbox | best | search) ----------
   객단가 전략: minPrice 로 저가 제외, sort=priceDesc 로 고단가 우선 */
export async function fetchProducts({ source = 'goldbox', category = '', keyword = '', limit = 10, minPrice = 0, sort = 'rank' } = {}) {
  const keys = getKeys();
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  let items;
  let simulated = false;

  if (!keys) {
    items = mockProducts();
    simulated = true;
  } else {
    const sub = keys.subId ? `&subId=${encodeURIComponent(keys.subId)}` : '';
    if (source === 'best') {
      const catId = CATEGORY_IDS[category] || Number(category) || 1016;
      const r = await cpFetch('GET', `${BASE}/products/bestcategories/${catId}?limit=${lim}${sub}`, null, keys);
      items = (r.data || []).map(normalize);
    } else if (source === 'search') {
      const r = await cpFetch('GET', `${BASE}/products/search?keyword=${encodeURIComponent(keyword || '추천')}&limit=${lim}${sub}`, null, keys);
      items = (r.data?.productData || r.data || []).map(normalize);
    } else {
      const r = await cpFetch('GET', `${BASE}/v1/products/goldbox?limit=${lim}${sub}`, null, keys);
      items = (r.data || []).map(normalize);
    }
  }

  const min = Number(minPrice) || 0;
  let out = items.filter((p) => p.price >= min);
  if (!out.length) out = items; // 필터로 전멸하면 원본 유지 (빈 포스트 방지)
  if (sort === 'priceDesc') out = [...out].sort((a, b) => b.price - a.price);
  out = out.slice(0, lim);

  return {
    ok: true, simulated, source, count: out.length, products: out,
    ...(simulated ? { note: '쿠팡 키 없음 — .env의 COUPANG_ACCESS_KEY/SECRET_KEY 채우면 실상품 조회' } : {}),
  };
}

/* ---------- 딥링크 생성 (임의 쿠팡 URL → 파트너스 링크) ---------- */
export async function deeplink({ urls = [] } = {}) {
  const keys = getKeys();
  const list = (Array.isArray(urls) ? urls : String(urls).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
  if (!keys) return { simulated: true, note: '쿠팡 키 없음', links: list.map((u) => ({ originalUrl: u, shortenUrl: u })) };
  const r = await cpFetch('POST', `${BASE}/v1/deeplink`, { coupangUrls: list, ...(keys.subId ? { subId: keys.subId } : {}) }, keys);
  return { ok: true, links: r.data || [] };
}

/* ---------- 실적 리포트 (객단가 분석: 어떤 상품이 실제로 팔리는지) ---------- */
export async function fetchReport({ type = 'orders', days = 30 } = {}) {
  const keys = getKeys();
  if (!keys) {
    return {
      simulated: true, note: '쿠팡 키 없음 — 키를 채우면 실제 주문/커미션 리포트로 객단가 분석',
      rows: [], summary: { orders: 0, gmv: 0, commission: 0, avgOrderValue: 0 },
    };
  }
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(90, Number(days) || 30) * 86400000);
  const kind = ['orders', 'clicks', 'commission'].includes(type) ? type : 'orders';
  const r = await cpFetch('GET', `${BASE}/reports/${kind}?startDate=${fmt(start)}&endDate=${fmt(end)}&page=0`, null, keys);
  const rows = r.data || [];
  // 객단가(주문 평균 금액) 요약 — orders 리포트 기준
  let gmv = 0, commission = 0;
  for (const row of rows) {
    gmv += Number(row.gmv ?? row.orderPrice ?? 0);
    commission += Number(row.commission ?? row.commissionPrice ?? 0);
  }
  return {
    ok: true, type: kind, days: Number(days) || 30, rows,
    summary: { orders: rows.length, gmv, commission, avgOrderValue: rows.length ? Math.round(gmv / rows.length) : 0 },
  };
}

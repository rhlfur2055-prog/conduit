// ============================================================
// 알리익스프레스 어필리에이트 Open API
//   게이트웨이: https://api-sg.aliexpress.com/sync (TOP 프로토콜)
//   서명: md5(secret + 정렬된 key+value 연접 + secret).toUpperCase()
//   메서드: aliexpress.affiliate.hotproduct.query / product.query / link.generate
//   ⚠️ 2025-03 정책: 어필리에이트 미등록 상품은 수수료 1% — commission 필터 필수
// .env: ALI_APP_KEY, ALI_APP_SECRET, ALI_TRACKING_ID (포털 Tools>API에서 발급)
// 키가 없으면 시뮬레이션으로 동작.
// ============================================================
import crypto from 'node:crypto';
import { Credentials } from './store.js';

const GATEWAY = 'https://api-sg.aliexpress.com/sync';

function getKeys() {
  if (process.env.ALI_APP_KEY && process.env.ALI_APP_SECRET) {
    return {
      appKey: process.env.ALI_APP_KEY,
      appSecret: process.env.ALI_APP_SECRET,
      trackingId: process.env.ALI_TRACKING_ID || 'default',
    };
  }
  const cred = Credentials.all().find((c) => c.type === 'aliexpress');
  if (cred) {
    try {
      const d = Credentials.reveal(cred.id);
      if (d.appKey && d.appSecret) return { appKey: d.appKey, appSecret: d.appSecret, trackingId: d.trackingId || 'default' };
    } catch { /* 시뮬레이션 폴백 */ }
  }
  return null;
}

function signParams(params, secret) {
  const base = Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHash('md5').update(secret + base + secret, 'utf8').digest('hex').toUpperCase();
}

async function aliCall(method, apiParams, keys) {
  const params = {
    method,
    app_key: keys.appKey,
    timestamp: String(Date.now()),
    format: 'json',
    v: '2.0',
    sign_method: 'md5',
    ...Object.fromEntries(Object.entries(apiParams).filter(([, v]) => v !== undefined && v !== '')),
  };
  params.sign = signParams(params, keys.appSecret);
  const res = await fetch(GATEWAY + '?' + new URLSearchParams(params).toString());
  const data = await res.json();
  if (data.error_response) {
    throw new Error(`알리 API 오류 ${data.error_response.code}: ${data.error_response.msg} ${data.error_response.sub_msg || ''}`.slice(0, 300));
  }
  return data;
}

// 응답 어디에 있든 products.product 배열을 찾아낸다 (메서드별 래퍼 키가 달라서)
function digProducts(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.product)) return obj.product;
  for (const v of Object.values(obj)) {
    const found = digProducts(v);
    if (found) return found;
  }
  return null;
}

const normalize = (p) => ({
  productId: p.product_id,
  name: String(p.product_title || '').trim(),
  price: Math.round(Number(p.target_sale_price ?? p.sale_price) || 0),
  currency: p.target_sale_price_currency || 'KRW',
  image: p.product_main_image_url || '',
  url: p.promotion_link || p.product_detail_url || '',
  commission: parseFloat(p.commission_rate) || 0, // "7.0%" → 7
  category: p.first_level_category_name || '',
  orders: Number(p.lastest_volume) || undefined, // 최근 판매량 (있으면)
  rating: p.evaluate_rate || undefined,
  isRocket: false,
});

const MOCK = [
  { product_title: '〔시뮬레이션〕 무선 미니 가습기 USB', target_sale_price: 12900, commission_rate: '7.0%', first_level_category_name: 'Home & Garden', lastest_volume: 3200 },
  { product_title: '〔시뮬레이션〕 차량용 자석 거치대 2개입', target_sale_price: 8900, commission_rate: '8.0%', first_level_category_name: 'Automobiles', lastest_volume: 5100 },
  { product_title: '〔시뮬레이션〕 접이식 노트북 거치대 알루미늄', target_sale_price: 19900, commission_rate: '6.5%', first_level_category_name: 'Computer & Office', lastest_volume: 2100 },
  { product_title: '〔시뮬레이션〕 LED 무드등 스마트 조명', target_sale_price: 15900, commission_rate: '7.5%', first_level_category_name: 'Lights & Lighting', lastest_volume: 1800 },
  { product_title: '〔시뮬레이션〕 캠핑 미니 랜턴 충전식', target_sale_price: 11900, commission_rate: '5.5%', first_level_category_name: 'Sports', lastest_volume: 950 },
  { product_title: '〔시뮬레이션〕 주방 실리콘 조리도구 6종 세트', target_sale_price: 16900, commission_rate: '6.0%', first_level_category_name: 'Home & Garden', lastest_volume: 2700 },
];

/* ---------- 상품 조회 (hot=핫딜 추천 | search=키워드 검색) ---------- */
export async function fetchProducts({ source = 'hot', keyword = '', limit = 8, minPrice = 0, minCommission = 5 } = {}) {
  const keys = getKeys();
  const lim = Math.min(20, Math.max(1, Number(limit) || 8));
  let items;
  let simulated = false;

  if (!keys) {
    items = MOCK.map((m, i) => normalize({ ...m, product_id: 80000000 + i, product_detail_url: 'https://ko.aliexpress.com/item/' + (80000000 + i) + '.html' }));
    simulated = true;
  } else {
    const method = source === 'search' ? 'aliexpress.affiliate.product.query' : 'aliexpress.affiliate.hotproduct.query';
    const data = await aliCall(method, {
      tracking_id: keys.trackingId,
      target_currency: 'KRW',
      target_language: 'KO',
      ship_to_country: 'KR',
      page_size: String(Math.min(50, lim * 3)), // 필터로 걸러질 것 감안해 여유 조회
      page_no: '1',
      keywords: source === 'search' ? (keyword || '인기 상품') : undefined,
      sort: 'LAST_VOLUME_DESC',
    }, keys);
    items = (digProducts(data) || []).map(normalize);
  }

  const minP = Number(minPrice) || 0;
  const minC = Number(minCommission) || 0;
  let out = items.filter((p) => p.price >= minP && p.commission >= minC && p.url);
  if (!out.length) out = items.filter((p) => p.url); // 전멸 방지
  out = out.slice(0, lim);

  return {
    ok: true, simulated, source, count: out.length, products: out,
    ...(simulated ? { note: '알리 키 없음 — .env의 ALI_APP_KEY/SECRET/TRACKING_ID 채우면 실상품 조회' } : {}),
    filterNote: `수수료 ${minC}% 미만 제외(미등록 상품 1% 함정 회피)`,
  };
}

/* ---------- 임의 상품 URL → 제휴 링크 변환 ---------- */
export async function generateLinks({ urls = [] } = {}) {
  const keys = getKeys();
  const list = (Array.isArray(urls) ? urls : String(urls).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return { ok: false, error: 'urls 가 비어 있습니다' };
  if (!keys) {
    return { simulated: true, note: '알리 키 없음', links: list.map((u) => ({ source: u, promotion: u })) };
  }
  const data = await aliCall('aliexpress.affiliate.link.generate', {
    tracking_id: keys.trackingId,
    promotion_link_type: '0',
    source_values: list.join(','),
  }, keys);
  const dig = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o.promotion_link)) return o.promotion_link;
    for (const v of Object.values(o)) { const f = dig(v); if (f) return f; }
    return null;
  };
  const links = (dig(data) || []).map((l) => ({ source: l.source_value, promotion: l.promotion_link }));
  return { ok: true, count: links.length, links };
}

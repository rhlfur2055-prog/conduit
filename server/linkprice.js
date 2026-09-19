// ============================================================
// 링크프라이스 어필리에이트 — 머천트 조회 · 딥링크 생성 · 실적 조회
//   공식 연동 가이드: github.com/linkprice/AffiliateSetup
//   • 머천트 조회: api.linkprice.com/ci/service/all_merchant/{A코드}/{all|apr}/{cps|cpa}
//   • 딥링크: click.linkprice.com/click.php?m={머천트}&a={A코드}&l=0000&url={인코딩URL}
//     (머천트의 deeplink_yn=Y 일 때만 상품 URL 딥링크 트래킹 지원)
//   • 실적 조회 v1.6: api.linkprice.com/affiliate/translist.php?a_id&auth_key&yyyymmdd
// .env: LINKPRICE_A_ID(A+9자리), LINKPRICE_AUTH_KEY(실적조회용 32자), LINKPRICE_U_ID(선택 서브트래킹)
// 키가 없으면 시뮬레이션으로 동작해 파이프라인 검증 가능.
// ============================================================
import { Credentials } from './store.js';

function getKeys() {
  if (process.env.LINKPRICE_A_ID) {
    return {
      aId: process.env.LINKPRICE_A_ID,
      authKey: process.env.LINKPRICE_AUTH_KEY || '',
      uId: process.env.LINKPRICE_U_ID || '',
    };
  }
  const cred = Credentials.all().find((c) => c.type === 'linkprice');
  if (cred) {
    try {
      const d = Credentials.reveal(cred.id);
      if (d.aId) return { aId: d.aId, authKey: d.authKey || '', uId: d.uId || '' };
    } catch { /* 시뮬레이션 폴백 */ }
  }
  return null;
}

/* ---------- 머천트 조회 (제휴 가능한 쇼핑몰 + 수수료율) ---------- */
export async function fetchMerchants({ status = 'apr', type = 'cps' } = {}) {
  const keys = getKeys();
  if (!keys) {
    return {
      simulated: true,
      note: '링크프라이스 키 없음 — .env의 LINKPRICE_A_ID 채우면 실제 머천트 조회 (apr=승인된 것만, all=전체)',
      merchants: [
        { id: 'gmarket', name: '〔시뮬레이션〕 G마켓', category: '종합몰', maxCommissionPc: '2.0%', deeplink: true },
        { id: 'ssg', name: '〔시뮬레이션〕 SSG.COM', category: '종합몰', maxCommissionPc: '2.5%', deeplink: true },
        { id: 'oliveyoung', name: '〔시뮬레이션〕 올리브영', category: '뷰티', maxCommissionPc: '5.0%', deeplink: true },
      ],
    };
  }
  const st = ['all', 'apr'].includes(status) ? status : 'apr';
  const tp = ['cps', 'cpa'].includes(type) ? type : 'cps';
  const res = await fetch(`https://api.linkprice.com/ci/service/all_merchant/${encodeURIComponent(keys.aId)}/${st}/${tp}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('링크프라이스 응답 파싱 실패: ' + text.slice(0, 200)); }
  const raw = data.list || data.merchant_list || (Array.isArray(data) ? data : []);
  const merchants = raw.map((m) => ({
    id: m.merchant_id,
    name: m.merchant_name,
    category: m.category_name || '',
    maxCommissionPc: m.max_commission_pc || '',
    maxCommissionMobile: m.max_commission_mobile || '',
    deeplink: m.deeplink_yn === 'Y',
    clickUrl: m.click_url || '',
    returnDay: m.return_day || '',
  }));
  return { ok: true, count: merchants.length, merchants };
}

/* ---------- 딥링크 변환 (products 배열의 url → 트래킹 링크) ---------- */
export async function makeDeeplinks({ products = [], merchantId = '' } = {}) {
  const keys = getKeys();
  const items = Array.isArray(products) ? products : [];
  if (!items.length) return { ok: false, error: 'products 배열이 비어 있습니다' };
  if (!merchantId) return { ok: false, error: 'merchantId 가 필요합니다 (머천트 조회 노드의 id, 예: gmarket)' };
  if (!keys) {
    return {
      simulated: true,
      note: '링크프라이스 키 없음 — LINKPRICE_A_ID 채우면 실제 딥링크 생성',
      products: items.map((p) => ({ ...p, url: `https://click.linkprice.com/click.php?m=${merchantId}&a=A100000000&l=0000&url=${encodeURIComponent(p.url || '')}` })),
    };
  }
  const sub = keys.uId ? `&u_id=${encodeURIComponent(keys.uId)}` : '';
  const converted = items.map((p) => ({
    ...p,
    url: `https://click.linkprice.com/click.php?m=${encodeURIComponent(merchantId)}&a=${encodeURIComponent(keys.aId)}&l=0000${sub}&url=${encodeURIComponent(p.url || '')}`,
  }));
  return {
    ok: true, count: converted.length, products: converted,
    note: '딥링크는 해당 머천트가 deeplink_yn=Y 일 때만 실적이 잡힙니다 (머천트 조회 노드로 확인). 어필리에이트센터 딥링크 도구와 규격 대조 권장.',
  };
}

/* ---------- 실적 조회 (translist v1.6 — 확정/취소 상태 포함) ---------- */
const LP_STATUS = { 100: '정상', 200: '정산대기', 210: '정산완료', 300: '취소요청', 310: '취소완료' };

export async function fetchReport({ period = '' } = {}) {
  const keys = getKeys();
  if (!keys || !keys.authKey) {
    return {
      simulated: true,
      note: '실적 조회에는 LINKPRICE_A_ID + LINKPRICE_AUTH_KEY(어필리에이트센터 발급 32자) 둘 다 필요',
      rows: [], summary: { orders: 0, sales: 0, commission: 0 },
    };
  }
  // period: 'YYYYMM'(월) 또는 'YYYYMMDD'(일), 비우면 이번 달
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const q = /^\d{6}(\d{2})?$/.test(period) ? period : ym;
  const res = await fetch(`https://api.linkprice.com/affiliate/translist.php?a_id=${encodeURIComponent(keys.aId)}&auth_key=${encodeURIComponent(keys.authKey)}&yyyymmdd=${q}&per_page=1000`);
  const data = await res.json();
  const rows = (data.order_list || []).map((r) => ({
    id: r.trlog_id, order: r.o_cd, merchant: r.m_id, date: r.yyyymmdd,
    sales: Number(r.sales) || 0, commission: Number(r.commission) || 0,
    status: LP_STATUS[r.status] || r.status,
  }));
  let sales = 0, commission = 0;
  for (const r of rows) { if (!String(r.status).startsWith('취소')) { sales += r.sales; commission += r.commission; } }
  return { ok: true, period: q, rows, summary: { orders: rows.length, sales, commission } };
}

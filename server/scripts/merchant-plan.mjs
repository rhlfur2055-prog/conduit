// ============================================================
// 링크프라이스 제휴 신청 계획 + 승인 상태 확인
//
//   승인된 머천트가 0개면 딥링크를 아무리 잘 만들어도 수수료가 0원이다.
//   이 스크립트는 (1) 지금 승인 상태를 보여주고
//                (2) 아직 승인 안 된 것 중 신청 우선순위를 뽑는다.
//
//   실행:  node server/scripts/merchant-plan.mjs
//         node server/scripts/merchant-plan.mjs --track=beauty
//         node server/scripts/merchant-plan.mjs --track=digital
//         node server/scripts/merchant-plan.mjs --top=30
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const p of [path.join(HERE, '..', '..', '.env'), path.join(HERE, '..', '.env')]) {
  try { process.loadEnvFile(p); break; } catch { /* 다음 후보 */ }
}

const arg = (n, d = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const { fetchMerchants } = await import('../linkprice.js');

const TRACKS = {
  beauty:  { label: '뷰티',   re: /뷰티|화장|미용|헬스|건강|렌즈/ },
  digital: { label: '디지털', re: /디지털|가전|컴퓨터|전자|IT/ },
  fashion: { label: '패션',   re: /패션|의류|슈즈|잡화/ },
  all:     { label: '전체',   re: /./ },
};

// "3.5%" → 3.5 · "21% 또는 56,000원" → 21 (뒤의 정액 보상까지 이어붙이면 2156 이 된다)
const rate = (s) => {
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : 0;
};

// 링크프라이스 API 는 응답이 느려서, 두 요청을 동시에 던지면 연결이 밀려 타임아웃이 난다.
// 순차로 부르고 일시적 실패는 재시도한다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(opts, tries = 3) {
  let last;
  for (let n = 1; n <= tries; n++) {
    try { return await fetchMerchants(opts); } catch (e) { last = e; }
    if (n < tries) {
      console.log(`  (${opts.status} 조회 재시도 ${n}/${tries - 1})`);
      await sleep(n * 2000);
    }
  }
  throw last;
}

const approved = await fetchWithRetry({ status: 'apr', type: 'cps' });
const all = await fetchWithRetry({ status: 'all', type: 'cps' });

if (approved.simulated || all.simulated) {
  console.log('\n✖ LINKPRICE_A_ID 가 없어 시뮬레이션 상태입니다. .env 를 확인하세요.\n');
  process.exit(1);
}

const apprIds = new Set(approved.merchants.map((m) => m.id));

console.log('\n' + '='.repeat(62));
console.log(' 링크프라이스 제휴 현황');
console.log('='.repeat(62));
console.log(`  전체 머천트   : ${all.count}개`);
console.log(`  승인된 머천트 : ${approved.count}개` + (approved.count === 0 ? '  ← 이게 0이면 수수료도 0원' : ''));
console.log(`  딥링크 지원   : ${all.merchants.filter((m) => m.deeplink).length}개`);

if (approved.count) {
  console.log('\n  [승인 완료 — 바로 쓸 수 있음]');
  for (const m of approved.merchants.sort((a, b) => rate(b.maxCommissionPc) - rate(a.maxCommissionPc))) {
    console.log(`    ${String(m.maxCommissionPc).padEnd(10)} ${String(m.id).padEnd(16)} ${m.name}${m.deeplink ? '' : '  (딥링크 X)'}`);
  }
}

const trackKey = arg('track', 'all');
const track = TRACKS[trackKey] || TRACKS.all;
const top = Number(arg('top', 15));

// 신청 후보: 미승인 + 딥링크 지원 + 요율 높은 순
const candidates = all.merchants
  .filter((m) => !apprIds.has(m.id))
  .filter((m) => m.deeplink)                       // 딥링크 안 되면 상품 링크로 실적이 안 잡힌다
  .filter((m) => track.re.test(m.category + m.name))
  .sort((a, b) => rate(b.maxCommissionPc) - rate(a.maxCommissionPc))
  .slice(0, top);

console.log(`\n  [신청 우선순위 — ${track.label} · 미승인 · 딥링크 지원 · 요율순]`);
console.log('    요율'.padEnd(14), 'ID'.padEnd(18), '이름'.padEnd(20), '카테고리');
console.log('    ' + '-'.repeat(56));
for (const m of candidates) {
  console.log('   ', String(m.maxCommissionPc).padEnd(11), String(m.id).padEnd(18), String(m.name).slice(0, 18).padEnd(20), m.category);
}

console.log('\n  신청: 링크프라이스 어필리에이트센터 → 머천트 검색 → 제휴 신청');
console.log('        https://ac.linkprice.net/');
console.log('  여러 곳을 한 번에 신청해두세요. 심사가 머천트마다 별도이고 며칠 걸립니다.');
console.log('  승인되면 이 스크립트를 다시 돌려 "승인된 머천트" 목록으로 확인하세요.\n');

// ============================================================
// 블로그 포스트 생성기 — 쿠팡 상품 배열 → 발행 가능한 한국어 HTML 포스트
//   • 공정위 대가성 고지 문구를 항상 본문 최상단에 삽입 (옵션 아님 — 정책 의무)
//   • ANTHROPIC_API_KEY 가 있으면 서론/상품 코멘트를 Claude 로 생성, 없으면 템플릿 로테이션
//   • 최근 사용 상품 기록(history.json)으로 같은 상품 반복 포스팅 방지
//   • 결과 HTML 을 server/data/blogposts/ 에 저장 (네이버 블로그 복붙용 백업)
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { callLLM } from './llm.js';
import { composeIntro, composeOutro, composeComment, composeTitle, seedOf } from './blogcopy.js';
import { PublishedPosts } from './store.js';
import { exportAll } from './exporters.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POST_DIR = path.join(__dirname, 'data', 'blogposts');
const HISTORY = path.join(POST_DIR, 'history.json');

// 공정위(표시광고법) 경제적 이해관계 고지 — 반드시 본문 첫 요소 (채널별 문구)
export const DISCLOSURES = {
  coupang: '이 게시물은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.',
  ali: '이 게시물은 알리익스프레스 어필리에이트 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.',
  linkprice: '이 게시물은 제휴마케팅(링크프라이스) 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받을 수 있습니다.',
};
export const DISCLOSURE = DISCLOSURES.coupang; // 하위호환

const fmtWon = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- 반복 포스팅 방지 ---------- */
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch { return []; }
}
function recordHistory(products) {
  fs.mkdirSync(POST_DIR, { recursive: true });
  const now = new Date().toISOString();
  const next = [...loadHistory(), ...products.map((p) => ({ id: p.productId, at: now }))]
    .filter((h) => Date.now() - new Date(h.at).getTime() < 14 * 86400000) // 14일 유지
    .slice(-500);
  fs.writeFileSync(HISTORY, JSON.stringify(next, null, 2));
}
function filterRecentlyUsed(products, days = 7) {
  const cutoff = Date.now() - days * 86400000;
  const used = new Set(loadHistory().filter((h) => new Date(h.at).getTime() > cutoff).map((h) => h.id));
  const fresh = products.filter((p) => !used.has(p.productId));
  return fresh.length >= Math.min(3, products.length) ? fresh : products; // 너무 걸러지면 원본 사용
}

/* ---------- 문구 생성은 blogcopy.js 로 이관 ----------
   고정 문장 4종 로테이션 → 조합식 생성. 중복 콘텐츠 방지. */


/* ---------- LLM 보강 (키 있을 때만 · 사실 날조 금지 가드) ---------- */
async function llmEnrich({ keyword, products }) {
  const list = products.map((p, i) => `${i + 1}. ${p.name} — ${fmtWon(p.price)}${p.isRocket ? ' (로켓배송)' : ''}`).join('\n');
  const r = await callLLM({
    model: 'claude-haiku-4-5-20251001',
    system: '너는 한국어 쇼핑 블로그 필자다. 반드시 유효한 JSON만 출력한다. 제공된 정보(상품명·가격·로켓배송 여부) 외의 스펙·성능·후기 수치를 절대 지어내지 마라. 과장 표현("최고", "1위 보장") 금지.',
    prompt: `주제: "${keyword}"\n상품 목록:\n${list}\n\n다음 JSON을 출력하라:\n{"intro": "서론 2-3문장 (검색자가 얻을 것 요약)", "comments": ["상품별 1-2문장 코멘트", ...상품 수만큼], "outro": "마무리 1-2문장"}`,
  });
  if (r.simulated || r.error) return null;
  try {
    const parsed = JSON.parse(r.text.replace(/^```json?\s*|\s*```$/g, ''));
    if (parsed.intro && Array.isArray(parsed.comments)) return parsed;
  } catch { /* 템플릿 폴백 */ }
  return null;
}

/* ---------- 포스트 생성 ---------- */
export async function generatePost({ products = [], keyword = '오늘의 특가', title = '', style = 'ranking', cta = '오늘 가격 확인하기', useLLM = 'auto', network = 'coupang' } = {}) {
  const disclosure = DISCLOSURES[network] || DISCLOSURES.coupang;
  let items = Array.isArray(products) ? products.filter((p) => p && p.name) : [];
  if (!items.length) return { ok: false, error: '상품 데이터가 없습니다 (products 배열 필요)' };
  items = filterRecentlyUsed(items);
  if (style === 'review') items = items.slice(0, 1);

  const now = new Date();
  const dayLabel = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
  // 시드에 키워드·날짜·상품 구성을 모두 넣는다 → 같은 날 여러 글을 써도 문장이 겹치지 않는다
  const seed = seedOf(keyword, dayLabel, items.map((p) => p.productId || p.name).join(','));

  const enriched = useLLM !== 'off' ? await llmEnrich({ keyword, products: items }) : null;
  const intro = enriched?.intro || composeIntro(keyword, seed);
  const outro = enriched?.outro || composeOutro(seed);

  const finalTitle = title
    || (style === 'review'
      ? `${items[0].name.slice(0, 40)} 구매 전 체크포인트 (${dayLabel})`
      : composeTitle(keyword, items.length, dayLabel, seed));

  const tagList = [...new Set([keyword, '추천', '가성비', '특가', ...items.map((p) => p.category).filter(Boolean)])].slice(0, 10);

  // 검색결과에 노출되는 설명문. Blogger 의 customMetaData 로 전달한다.
  // 155자 근처에서 문장 경계로 끊어야 "…" 로 잘린 채 노출되지 않는다.
  const metaDescription = (() => {
    const plain = String(intro).replace(/\s+/g, ' ').trim();
    if (plain.length <= 155) return plain;
    const cut = plain.slice(0, 155);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다 '), cut.lastIndexOf('요 '));
    return (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut).trim();
  })();

  const anchorId = (i) => `item-${i + 1}`;

  const sections = items.map((p, i) => {
    const comment = enriched?.comments?.[i] || composeComment(p, seed, i, network);
    return `
<h2 id="${anchorId(i)}" style="margin:28px 0 10px;font-size:1.25em;">${style === 'review' ? esc(p.name) : `${i + 1}위. ${esc(p.name)}`}</h2>
${p.image ? `<p style="text-align:center;"><img src="${esc(p.image)}" alt="${esc(p.name)}" style="max-width:100%;border-radius:8px;" loading="lazy"/></p>` : ''}
<ul style="line-height:1.8;">
  <li><b>가격</b>: ${fmtWon(p.price)} <span style="color:#888;">(작성 시점 기준, 변동 가능)</span></li>
  ${p.category ? `<li><b>카테고리</b>: ${esc(p.category)}</li>` : ''}
  <li><b>배송</b>: ${network === 'ali' ? '해외직구 (국내 배송보다 기간이 깁니다)' : p.isRocket ? '로켓배송 🚀' : '일반배송'}${p.isFreeShipping ? ' · 무료배송' : ''}</li>
</ul>
<p style="line-height:1.8;">${esc(comment)}</p>
<p style="text-align:center;margin:16px 0 8px;">
  <a href="${esc(p.url)}" target="_blank" rel="sponsored noopener"
     style="display:inline-block;background:#2f6fed;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
    ${esc(cta)} →
  </a>
</p>`;
  }).join('\n<hr style="border:none;border-top:1px solid #eee;margin:24px 0;"/>\n');

  // 목차 — 체류시간을 늘리고, 검색결과에 섹션 링크가 붙을 여지를 만든다.
  const toc = (style === 'review' || items.length < 2) ? '' : `
<div style="border:1px solid #e5e5e5;border-radius:8px;padding:14px 18px;margin:20px 0;background:#fafafa;">
  <p style="margin:0 0 8px;font-weight:bold;">목차</p>
  <ol style="margin:0;padding-left:20px;line-height:1.9;">
${items.map((p, i) => `    <li><a href="#${anchorId(i)}" style="color:#2f6fed;text-decoration:none;">${esc(p.name)}</a></li>`).join('\n')}
  </ol>
</div>`;

  // 내부 링크 — 이전 발행 글로 연결해 크롤링 경로를 만든다.
  // 발행 이력이 쌓이기 전에는 비어 있고, 글이 늘수록 자동으로 붙는다.
  const relatedPosts = PublishedPosts.related({ keyword, labels: tagList, excludeTitle: finalTitle, limit: 3 });
  const related = !relatedPosts.length ? '' : `
<div style="border-top:1px solid #eee;margin-top:28px;padding-top:16px;">
  <p style="margin:0 0 8px;font-weight:bold;">함께 보면 좋은 글</p>
  <ul style="line-height:1.9;margin:0;padding-left:20px;">
${relatedPosts.map((r) => `    <li><a href="${esc(r.url)}" style="color:#2f6fed;">${esc(r.title)}</a></li>`).join('\n')}
  </ul>
</div>`;

  const html = `
<p style="font-size:0.85em;color:#777;border:1px solid #e5e5e5;border-radius:6px;padding:10px 14px;background:#fafafa;">${disclosure}</p>
<p style="line-height:1.8;">${esc(intro)}</p>
${toc}
${sections}
<p style="line-height:1.8;margin-top:24px;">${esc(outro)}</p>
${related}
<p style="font-size:0.85em;color:#999;">※ 본문의 가격 정보는 ${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}. 작성 시점 기준이며 실시간 가격은 링크에서 확인할 수 있습니다.${network === 'ali' ? ' 해외직구 상품은 환율·프로모션에 따라 결제 금액이 달라질 수 있습니다.' : ''}</p>`.trim();

  // 파일 백업 (네이버 블로그 반자동 발행용 — 브라우저로 열어 전체선택·복사 → 스마트에디터 붙여넣기)
  fs.mkdirSync(POST_DIR, { recursive: true });
  const slug = `${now.toISOString().slice(0, 10)}-${crypto.createHash('md5').update(finalTitle).digest('hex').slice(0, 6)}`;
  const file = path.join(POST_DIR, `${slug}.html`);
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="description" content="${esc(metaDescription)}"><title>${esc(finalTitle)}</title><body style="max-width:720px;margin:24px auto;font-family:sans-serif;">\n<h1>${esc(finalTitle)}</h1>\n${html}`);

  // 플랫폼별 붙여넣기용 파일도 같이 뽑는다.
  // Blogger 만 API 로 자동 발행되고 네이버·티스토리·커뮤니티는 사람이 붙여넣어야 하는데,
  // 원본 HTML 을 그대로 붙이면 에디터마다 레이아웃이 깨진다.
  const variants = exportAll({ html, title: finalTitle });
  const exports = {};
  for (const [target, body] of Object.entries(variants)) {
    if (target === 'blogger') continue;                      // 원본과 동일
    const ext = target === 'markdown' ? 'md' : target === 'text' ? 'txt' : `${target}.html`;
    const p = path.join(POST_DIR, `${slug}.${ext}`);
    fs.writeFileSync(p, body, 'utf8');
    exports[target] = p;
  }

  recordHistory(items);
  return {
    ok: true, title: finalTitle, html, tags: tagList, file,
    productCount: items.length,
    llm: enriched ? 'claude' : 'template',
    metaDescription,
    exports,
    relatedCount: relatedPosts.length,
    excerpt: intro.slice(0, 120),
  };
}

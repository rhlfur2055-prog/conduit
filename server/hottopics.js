// ============================================================
// 핫이슈 수집 — Google 트렌드 "실시간 인기 검색어" RSS (키 불필요)
//   https://trends.google.com/trending/rss?geo=KR
// 주제마다 검색량 추정치(approx_traffic)와 관련 뉴스 헤드라인(제목·출처·URL)이 같이 온다.
// 대본은 이 헤드라인만 쓰고(출처 표기), 근거 없는 수치는 만들지 않는다.
// 최근 N일 안에 쓴 주제는 server/data/hot-topics-history.json 으로 제외한다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const decode = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};
export const hasHangul = (s) => /[가-힣]/.test(String(s || ''));

/** RSS 본문 → [{ topic, traffic, publishedAt, picture, headlines:[{title,url,source}] }] (RSS 순서 그대로) */
export function parseTrendsRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const b = m[1];
    const headlines = [];
    const nre = /<ht:news_item>([\s\S]*?)<\/ht:news_item>/g;
    let n;
    while ((n = nre.exec(b))) {
      const h = { title: tag(n[1], 'ht:news_item_title'), url: tag(n[1], 'ht:news_item_url'), source: tag(n[1], 'ht:news_item_source') };
      if (h.title) headlines.push(h);
    }
    items.push({
      topic: tag(b, 'title'),
      traffic: Number(String(tag(b, 'ht:approx_traffic')).replace(/[^\d]/g, '')) || 0,
      publishedAt: tag(b, 'pubDate'),
      picture: tag(b, 'ht:picture'),
      headlines,
    });
  }
  return items;
}

/** 조건에 맞는 주제를 검색량 순으로 골라 rank 를 붙인다 */
export function selectTopics(items, { limit = 3, minTraffic = 0, koreanOnly = true, minHeadlines = 1, exclude = [] } = {}) {
  const ex = new Set(exclude.map((s) => String(s).toLowerCase()));
  return items
    .filter((t) => t.topic && !ex.has(t.topic.toLowerCase()))
    .filter((t) => t.traffic >= minTraffic && t.headlines.length >= minHeadlines)
    .filter((t) => !koreanOnly || hasHangul(t.topic) || t.headlines.some((h) => hasHangul(h.title)))
    .sort((a, b) => b.traffic - a.traffic)
    .slice(0, Math.max(1, limit))
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

export function loadHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
/** history: { [topic]: 마지막 사용 시각 ISO } — skipDays 안에 쓴 주제를 뺀다 */
export function withoutRecent(items, history, skipDays, now = Date.now()) {
  if (!skipDays) return items;
  const cutoff = now - skipDays * 86400e3;
  return items.filter((t) => !(history[t.topic] && Date.parse(history[t.topic]) > cutoff));
}
export function recordUsed(file, items, now = new Date()) {
  const h = loadHistory(file);
  for (const t of items) h[t.topic] = now.toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(h, null, 2));
}

/**
 * @returns {Promise<Array<{topic, traffic, rank, headlines, publishedAt, region, fetchedAt, source}>>}
 */
export async function fetchHotTopics({
  region = 'KR', limit = 3, minTraffic = 0, koreanOnly = true, skipDays = 7,
  fetchImpl = globalThis.fetch, historyFile = path.join(DATA_DIR, 'hot-topics-history.json'),
} = {}) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(region)}`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Conduit hotTopics)' } });
  if (!res.ok) { const e = new Error(`Google 트렌드 RSS 응답 ${res.status}`); e.status = res.status; throw e; }
  const all = parseTrendsRss(await res.text());
  const fresh = withoutRecent(all, loadHistory(historyFile), Number(skipDays) || 0);
  const picked = selectTopics(fresh, { limit: Number(limit) || 3, minTraffic: Number(minTraffic) || 0, koreanOnly });
  if (picked.length) recordUsed(historyFile, picked);
  const fetchedAt = new Date().toISOString();
  return picked.map((t) => ({ ...t, region, fetchedAt, source: 'google-trends' }));
}

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTrendsRss, selectTopics, withoutRecent, recordUsed, loadHistory, fetchHotTopics } from '../../server/hottopics.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
<item><title>토트넘</title><ht:approx_traffic>1000+</ht:approx_traffic><pubDate>Sat, 20 Sep 2026 00:00:00 -0700</pubDate>
  <ht:news_item><ht:news_item_title>&#39;충격!&#39; 개막 4경기 무득점 토트넘, 이카르디 영입 검토中</ht:news_item_title><ht:news_item_url>https://example.com/a</ht:news_item_url><ht:news_item_source>조선일보</ht:news_item_source></ht:news_item>
  <ht:news_item><ht:news_item_title><![CDATA[토트넘 &amp; 손흥민 근황]]></ht:news_item_title><ht:news_item_url>https://example.com/b</ht:news_item_url><ht:news_item_source>Daum</ht:news_item_source></ht:news_item>
</item>
<item><title>sxmb</title><ht:approx_traffic>200+</ht:approx_traffic><ht:news_item><ht:news_item_title>XSMT 20/9 Ket qua xo so</ht:news_item_title><ht:news_item_url>https://example.vn</ht:news_item_url><ht:news_item_source>Bnews.vn</ht:news_item_source></ht:news_item></item>
<item><title>로또</title><ht:approx_traffic>500+</ht:approx_traffic><ht:news_item><ht:news_item_title>[종합] 1242회 로또 1등 9명…당첨금 각 32억8천만원(종합)</ht:news_item_title><ht:news_item_url>https://example.com/c</ht:news_item_url><ht:news_item_source>연합뉴스</ht:news_item_source></ht:news_item></item>
<item><title>조용한주제</title><ht:approx_traffic>50+</ht:approx_traffic></item>
</channel></rss>`;

describe('parseTrendsRss', () => {
  it('주제·검색량·헤드라인(출처·URL)을 뽑고 엔티티·CDATA 를 푼다', () => {
    const items = parseTrendsRss(RSS);
    expect(items.map((t) => t.topic)).toEqual(['토트넘', 'sxmb', '로또', '조용한주제']);
    expect(items[0].traffic).toBe(1000);
    expect(items[0].headlines).toHaveLength(2);
    expect(items[0].headlines[0]).toEqual({ title: "'충격!' 개막 4경기 무득점 토트넘, 이카르디 영입 검토中", url: 'https://example.com/a', source: '조선일보' });
    expect(items[0].headlines[1].title).toBe('토트넘 & 손흥민 근황');
    expect(items[3].headlines).toEqual([]);
  });
});

describe('selectTopics', () => {
  const items = parseTrendsRss(RSS);
  it('한글 주제만, 헤드라인 있는 것만, 검색량 순으로 rank', () => {
    const picked = selectTopics(items, { limit: 3, minTraffic: 100 });
    expect(picked.map((t) => [t.topic, t.rank])).toEqual([['토트넘', 1], ['로또', 2]]);
  });
  it('koreanOnly 를 끄면 외국어 주제도 온다, limit 은 최소 1', () => {
    expect(selectTopics(items, { limit: 0, koreanOnly: false }).map((t) => t.topic)).toEqual(['토트넘']);
    expect(selectTopics(items, { limit: 5, koreanOnly: false }).map((t) => t.topic)).toEqual(['토트넘', '로또', 'sxmb']);
  });
  it('exclude 로 특정 주제를 뺀다', () => {
    expect(selectTopics(items, { exclude: ['토트넘'] }).map((t) => t.topic)).toEqual(['로또']);
  });
});

describe('최근 사용 주제 제외 (history)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
  const file = path.join(dir, 'hist.json');
  it('기록 → 7일 안이면 제외, 지나면 다시 후보', () => {
    const items = parseTrendsRss(RSS);
    recordUsed(file, [items[0]], new Date('2026-09-19T00:00:00Z'));
    expect(loadHistory(file)).toEqual({ '토트넘': '2026-09-19T00:00:00.000Z' });
    const t1 = Date.parse('2026-09-21T00:00:00Z');
    expect(withoutRecent(items, loadHistory(file), 7, t1).map((t) => t.topic)).not.toContain('토트넘');
    const t2 = Date.parse('2026-09-30T00:00:00Z');
    expect(withoutRecent(items, loadHistory(file), 7, t2).map((t) => t.topic)).toContain('토트넘');
    expect(withoutRecent(items, loadHistory(file), 0, t1)).toHaveLength(4);
  });
});

describe('fetchHotTopics (가짜 fetch)', () => {
  it('RSS 를 받아 고르고 history 에 기록한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'));
    const file = path.join(dir, 'hist.json');
    const fetchImpl = async () => ({ ok: true, text: async () => RSS });
    const first = await fetchHotTopics({ limit: 1, minTraffic: 100, fetchImpl, historyFile: file });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ topic: '토트넘', rank: 1, region: 'KR', source: 'google-trends' });
    // 같은 날 다시 부르면 방금 쓴 주제는 빠지고 다음 주제
    const second = await fetchHotTopics({ limit: 1, minTraffic: 100, fetchImpl, historyFile: file });
    expect(second[0].topic).toBe('로또');
  });
  it('RSS 응답이 실패하면 상태 코드를 담아 던진다', async () => {
    await expect(fetchHotTopics({ fetchImpl: async () => ({ ok: false, status: 503 }), historyFile: path.join(os.tmpdir(), 'x.json') })).rejects.toThrow(/503/);
  });
});

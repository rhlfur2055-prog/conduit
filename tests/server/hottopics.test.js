import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTrendsRss, selectTopics, withoutRecent, recordUsed, loadHistory, fetchHotTopics } from '../../server/hottopics.js';
import { cleanHeadline, stripSourceSuffix, buildIssueScript, issueYoutubeMeta } from '../../server/render-issue.js';

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

describe('대본·메타 (render-issue)', () => {
  it('cleanHeadline — 꼬리표 제거, 한자 中→중, 길면 구절 경계에서 자름', () => {
    expect(cleanHeadline('[종합] 1242회 로또 1등 9명…당첨금 각 32억8천만원(종합)')).toBe('1242회 로또 1등 9명…당첨금 각 32억8천만원');
    expect(cleanHeadline('이카르디 영입 검토中')).toBe('이카르디 영입 검토중');
    const src = '가나다라 마바사아, 자차카타 파하 아주 긴 제목이 계속 이어지고 또 이어져서 구십 자를 훌쩍 넘기는 문장, 그리고 또 다른 절이 붙습니다 끝까지 그리고 여기서도 한참 더 이어지는 아주 긴 꼬리 문장입니다';
    expect(src.length).toBeGreaterThan(90);
    const long = cleanHeadline(src);
    expect(long.length).toBeLessThanOrEqual(91);
    expect(long.endsWith('…')).toBe(true);
    expect(src.startsWith(long.slice(0, -1))).toBe(true); // 앞부분을 그대로 두고 뒤만 자른다
    expect(cleanHeadline('짧은 제목')).toBe('짧은 제목');
  });
  it('stripSourceSuffix — 제목 끝의 언론사 이름만 뗀다', () => {
    expect(stripSourceSuffix('33억 주인공 9명 탄생…이번주 로또 당첨번호는? - 머니투데이', '머니투데이')).toBe('33억 주인공 9명 탄생…이번주 로또 당첨번호는?');
    expect(stripSourceSuffix('속보 | 연합뉴스', '연합뉴스')).toBe('속보');
    expect(stripSourceSuffix('머니투데이가 전한 소식', '머니투데이')).toBe('머니투데이가 전한 소식'); // 끝이 아니면 그대로
    expect(stripSourceSuffix('제목 - 다른곳', '머니투데이')).toBe('제목 - 다른곳');
    expect(stripSourceSuffix('A+B (주) 소식 - A+B (주)', 'A+B (주)')).toBe('A+B (주) 소식');   // 정규식 특수문자 안전
    expect(buildIssueScript({ topic: 'x', headlines: [{ title: '당첨번호는? - 머니투데이', source: '머니투데이' }] }).cards[0].title).toBe('당첨번호는?');
  });
  it('buildIssueScript — 훅·헤드라인 낭독·CTA, 최대 개수, 빈 헤드라인은 오류', () => {
    const s = buildIssueScript({ topic: '로또', headlines: [{ title: 'A 헤드라인', source: '연합뉴스', url: 'u1' }, { title: 'B', source: 'Daum' }, { title: 'C' }, { title: 'D' }], maxHeadlines: 3 });
    expect(s.hook).toBe('오늘 검색이 급증한 키워드, 로또. 무슨 일이 있었을까요?');
    expect(s.items).toEqual(['첫 번째. A 헤드라인', '두 번째. B', '세 번째. C']);
    expect(s.cards).toHaveLength(3);
    expect(s.cards[0]).toEqual({ title: 'A 헤드라인', source: '연합뉴스', url: 'u1' });
    expect(() => buildIssueScript({ topic: 'x', headlines: [] })).toThrow(/헤드라인/);
  });
  it('issueYoutubeMeta — 설명란에 출처와 링크, 근거 없는 수치 없음', () => {
    const s = buildIssueScript({ topic: '로또', headlines: [{ title: 'A', source: '연합뉴스', url: 'https://e.com/a' }] });
    const m = issueYoutubeMeta({ topic: '로또', cards: s.cards, date: '2026-09-20' });
    expect(m.title).toBe('로또, 오늘 왜 뜬 걸까? | 핫이슈 3줄');
    expect(m.description).toContain('1. 연합뉴스 · A');
    expect(m.description).toContain('https://e.com/a');
    expect(m.description).toContain('#핫이슈');
    expect(m.description).not.toMatch(/\d+%|상위 \d/);
    expect(m.tags.split(',')).toContain('연합뉴스');
  });
});

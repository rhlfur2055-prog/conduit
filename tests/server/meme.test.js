import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateMemeItems, ttsText, memeBeats, memeYoutubeMeta } from '../../server/render-meme.js';
import { normalizeResult, attributionLine, searchImages, downloadImage, commonsLicense, normalizeCommons, normalizeCommonsVideo, screenCredit, cleanCreator } from '../../server/memeimages.js';

const src = { credit: '출처: Jane · CC0 · Wikimedia Commons', attribution: '"Cat" by Jane — CC0 1.0 — https://example.org/cat' };
const statement = { kind: 'statement', setupLines: ['첫 줄', '둘째 줄'], image: 'memes/a.jpg', punch: '한 줄 댓글', ...src };
const dialogue = { kind: 'dialogue', setupLines: ['교수님: 이해했죠?', '나:'], image: 'memes/b.jpg', punch: '표정이 이미 재수강', ...src };
const panels = { kind: 'panels', panels: [{ image: 'memes/c.jpg', caption: '하나' }, { image: 'memes/d.jpg', caption: '둘' }], punch: '셋은 없음', ...src };

describe('validateMemeItems', () => {
  it('세 가지 유형을 통과시킨다', () => {
    expect(validateMemeItems([statement, dialogue, panels])).toEqual([]);
  });
  it('개수·빈 칸·길이·사진 누락을 잡는다', () => {
    expect(validateMemeItems([statement])).toEqual(['밈은 2~8개여야 합니다']);
    expect(validateMemeItems('x')).toEqual(['밈은 2~8개여야 합니다']);
    expect(validateMemeItems([statement, { ...statement, punch: '' }])).toEqual(['2번: 댓글(punch)이 비었습니다']);
    expect(validateMemeItems([statement, { ...statement, image: '' }])).toEqual(['2번: 사진(또는 영상)이 없습니다']);
    expect(validateMemeItems([statement, { ...statement, image: '', video: 'memes/clip.mp4' }])).toEqual([]);
    expect(validateMemeItems([statement, { ...statement, setupLines: ['가'.repeat(25)] }])).toEqual(['2번 1줄: 24자를 넘습니다']);
    expect(validateMemeItems([statement, { ...statement, punch: '나'.repeat(31) }])).toEqual(['2번: 댓글이 30자를 넘습니다']);
    expect(validateMemeItems([statement, { kind: 'panels', panels: [{ image: 'a', caption: '하나' }], punch: '댓글', ...src }])).toEqual(['2번: 패널은 2~4개여야 합니다']);
    expect(validateMemeItems([statement, { kind: 'panels', panels: [{ image: 'a', caption: '' }, { image: '', caption: '둘' }], punch: '댓글', ...src }]))
      .toEqual(['2번 패널 1: 캡션이 비었습니다', '2번 패널 2: 사진이 없습니다']);
  });
});

describe('출처가 올릴 근거다', () => {
  it('화면 표기나 설명란 표기가 없는 사진·영상은 렌더하지 않는다', () => {
    const { credit, attribution, ...bare } = statement;
    expect(validateMemeItems([statement, bare])).toEqual(['2번: 화면 출처 표기(credit)가 없습니다', '2번: 설명란 출처(attribution)가 없습니다']);
    expect(validateMemeItems([statement, { ...bare, credit }])).toEqual(['2번: 설명란 출처(attribution)가 없습니다']);
  });
});

describe('ttsText — 화면 글자를 낭독용으로', () => {
  it('화자만 있는 줄의 콜론을 떼고, 대화체 콜론은 쉼표로 바꾼다', () => {
    expect(ttsText('나:')).toBe('나');
    expect(ttsText('교수님: 이해했죠?')).toBe('교수님, 이해했죠?');
  });
  it('ㅋㅋ·이모지·장식 기호는 읽지 않는다', () => {
    expect(ttsText('개웃긴 댓글ㅋㅋㅋ')).toBe('개웃긴 댓글');
    expect(ttsText('공짜로 받았는데😎')).toBe('공짜로 받았는데');
    expect(ttsText('OOOH~ MY GOD~')).toBe('OOOH MY GOD');
    expect(ttsText('  여러   칸  ')).toBe('여러 칸');
  });
});

describe('memeBeats — 캡션 → 사진 → 댓글 3박자', () => {
  it('한 줄 캡션: 다 읽은 뒤에 사진이 뜨고, 그림을 볼 시간(38프레임)을 준 다음 댓글', () => {
    const b = memeBeats([60], { punchFrames: 30 });
    expect(b.beatAt).toEqual([0]);
    expect(b.imageAt).toBe(64);        // 60 + 줄 간격 4 — 읽는 동안 사진 칸은 검정
    expect(b.punchAt).toBe(64 + 38);
    expect(b.len).toBe(102 + 30 + 40); // 댓글 낭독 + 유지 40
  });
  it('두 줄 캡션: 사진은 둘째 줄과 함께 뜬다', () => {
    const b = memeBeats([50, 70], { punchFrames: 20 });
    expect(b.beatAt).toEqual([0, 54]);
    expect(b.imageAt).toBe(54);
    // 둘째 줄 낭독이 끝난 뒤(124+8)와 사진을 본 시간(54+38) 중 늦은 쪽
    expect(b.punchAt).toBe(132);
  });
  it('둘째 줄이 아주 짧으면("나:") 사진을 볼 시간을 우선한다', () => {
    const b = memeBeats([60, 8]);
    expect(b.imageAt).toBe(64);
    expect(b.punchAt).toBe(64 + 38);   // 낭독 기준(72+8=80)보다 늦다
  });
  it('패널: 첫 패널은 처음부터, 댓글은 마지막 패널이 뜬 뒤', () => {
    const b = memeBeats([40, 40], { panels: true });
    expect(b.imageAt).toBe(0);
    expect(b.beatAt).toEqual([0, 44]);
    expect(b.punchAt).toBe(Math.max(84 + 8, 44 + 38));
  });
});

describe('memeimages — 재사용이 허락된 사진만', () => {
  const raw = (over = {}) => ({ id: 'abc', title: 'Cat staring', creator: 'Jane', license: 'cc0', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/', source: 'flickr', foreign_landing_url: 'https://example.org/cat', url: 'https://img.example.org/cat.jpg', thumbnail: 'https://api.example.org/thumb', width: 1024, height: 768, filetype: 'jpg', ...over });

  it('라이선스·크기·형식이 맞는 것만 통과시킨다', () => {
    expect(normalizeResult(raw())).toMatchObject({ id: 'abc', license: 'cc0', ext: 'jpg', landingUrl: 'https://example.org/cat' });
    expect(normalizeResult(raw({ license: 'by-nc' }))).toBeNull();   // 비영리 조건
    expect(normalizeResult(raw({ license: 'by-nd' }))).toBeNull();   // 변경 금지
    expect(normalizeResult(raw({ license: 'by-sa' }))).toBeNull();   // 동일조건 — 받지 않는다
    expect(normalizeResult(raw({ width: 400 }))).toBeNull();
    expect(normalizeResult(raw({ filetype: 'svg', url: 'https://img.example.org/x.svg' }))).toBeNull();
    expect(normalizeResult(raw({ mature: true }))).toBeNull();
    expect(normalizeResult(raw({ filetype: '', url: 'https://img.example.org/photo.JPEG' })).ext).toBe('jpg');
    expect(normalizeResult(raw({ title: '', creator: null }))).toMatchObject({ title: '(제목 없음)', creator: '(저작자 미상)' });
  });

  it('출처 한 줄: 제목 · 저작자 · 라이선스 · 출처 URL', () => {
    expect(attributionLine(normalizeResult(raw()))).toBe('"Cat staring" by Jane — CC0 1.0 — https://example.org/cat');
    expect(attributionLine(normalizeResult(raw({ license: 'by', license_version: '4.0' })))).toBe('"Cat staring" by Jane — CC BY 4.0 — https://example.org/cat');
  });

  it('저작자 칸의 중복을 접고, 미상은 한국어로 바꾼다', () => {
    // Commons 는 틀이 두 번 렌더되어 같은 말이 붙어 나올 때가 있다
    expect(cleanCreator('Unknown authorUnknown author')).toBe('촬영자 미상');
    expect(cleanCreator('Bernard GagnonBernard Gagnon')).toBe('Bernard Gagnon');
    expect(cleanCreator('<a href="/x">Mike Finn</a>')).toBe('Mike Finn');
    expect(cleanCreator('unknown')).toBe('촬영자 미상');
    expect(cleanCreator('')).toBe('촬영자 미상');
    expect(cleanCreator('Keystone View Company')).toBe('Keystone View Company');
  });

  it('Commons 라이선스 표기: CC0·퍼블릭 도메인·CC BY 만 받고 동일조건·비영리·변경금지는 버린다', () => {
    expect(commonsLicense('CC0')).toEqual({ license: 'cc0', version: '1.0' });
    expect(commonsLicense('Public domain')).toEqual({ license: 'pdm', version: '1.0' });
    expect(commonsLicense('CC BY 2.0')).toEqual({ license: 'by', version: '2.0' });
    expect(commonsLicense('CC BY-SA 4.0')).toBeNull();
    expect(commonsLicense('CC BY-NC 2.0')).toBeNull();
    expect(commonsLicense('GFDL')).toBeNull();
    expect(commonsLicense('')).toBeNull();
  });

  it('Commons 사진·영상 정규화와 화면 출처 한 줄', () => {
    const meta = { LicenseShortName: { value: 'CC BY 2.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/2.0' }, Artist: { value: '<a href="//flickr.com/x">Ashleigh Thompson</a>' } };
    const photo = normalizeCommons({ pageid: 7, title: 'File:Meerkats group.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/a/Meerkats_group.jpg', thumburl: 'https://upload.wikimedia.org/thumb/a/Meerkats_group.jpg/1280px-Meerkats_group.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Meerkats_group.jpg', width: 4000, height: 3000, extmetadata: meta }] });
    expect(photo).toMatchObject({ id: 'commons-7', title: 'Meerkats group', creator: 'Ashleigh Thompson', license: 'by', licenseVersion: '2.0', source: 'wikimedia' });
    expect(photo.url).toContain('/1280px-');       // 원본 대신 1280px 판
    expect(photo.thumbnail).toContain('/500px-');  // 미리보기는 표준 폭 500px
    expect(screenCredit(photo)).toBe('출처: Ashleigh Thompson · CC BY 2.0 · Wikimedia Commons');
    expect(normalizeCommons({ pageid: 8, title: 'File:x.jpg', imageinfo: [{ url: 'https://u/x.jpg', width: 2000, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }] })).toBeNull();

    const pd = { LicenseShortName: { value: 'Public domain' }, Artist: { value: 'USFWS Mountain-Prairie' } };
    const vid = (over = {}) => ({ pageid: 9, title: 'File:Sleepy owl.webm', videoinfo: [{ url: 'https://u/owl.webm', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Sleepy_owl.webm', width: 1920, height: 1080, duration: 30.4, extmetadata: pd, ...over }] });
    expect(normalizeCommonsVideo(vid())).toMatchObject({ kind: 'video', license: 'pdm', durationSec: 30.4, url: 'https://u/owl.webm' });
    expect(screenCredit(normalizeCommonsVideo(vid()))).toBe('출처: USFWS Mountain-Prairie · 퍼블릭 도메인 · Wikimedia Commons');
    expect(normalizeCommonsVideo(vid({ duration: 1 }))).toBeNull();     // 너무 짧음
    expect(normalizeCommonsVideo(vid({ duration: 600 }))).toBeNull();   // 너무 김
    // 4K 원본이면 1080p 이하 변환본을 받는다
    const big = normalizeCommonsVideo(vid({ width: 3840, height: 2160, derivatives: [{ src: 'https://u/owl.480p.webm', type: 'video/webm', height: 480 }, { src: 'https://u/owl.1080p.webm', type: 'video/webm', height: 1080 }] }));
    expect(big.url).toBe('https://u/owl.1080p.webm');
  });

  it('검색: 기본은 CC0 만 요청하고, 못 쓰는 결과는 걸러서 돌려준다', async () => {
    let asked = '';
    const fetchImpl = async (url) => { asked = url; return { ok: true, headers: new Map([['x-ratelimit-available-anon_burst', '19']]), json: async () => ({ result_count: 2, results: [raw(), raw({ id: 'nc', license: 'by-nc' })] }) }; };
    const r = await searchImages({ query: ' cat staring ', fetchImpl });
    expect(asked).toContain('q=cat%20staring');
    expect(asked).toContain('license=cc0');
    expect(r.total).toBe(2);
    expect(r.candidates.map((c) => c.id)).toEqual(['abc']);
    expect(r.rate.burst).toBe('19');
    await expect(searchImages({ query: '  ', fetchImpl })).rejects.toThrow(/검색어/);
    await expect(searchImages({ query: 'x', fetchImpl: async () => ({ ok: false, status: 429 }) })).rejects.toMatchObject({ status: 429 });
  });

  it('받기: 파일을 저장하고 manifest 에 출처를 남긴다 · 이미지가 아니면 거부 · 두 번 받지 않는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memes-'));
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
    const c = normalizeResult(raw());
    const a = await downloadImage(c, { dir, fetchImpl });
    expect(a.rel).toMatch(/^memes\/ov-[0-9a-f]{12}\.jpg$/);
    expect(fs.readFileSync(a.file)).toEqual(Buffer.from([1, 2, 3]));
    expect(a.needsCredit).toBe(false);
    expect(a.credit).toBe('출처: Jane · CC0 · flickr');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(Object.values(manifest)[0]).toMatchObject({ license: 'cc0', attribution: '"Cat staring" by Jane — CC0 1.0 — https://example.org/cat' });
    await downloadImage(c, { dir, fetchImpl });
    expect(calls).toBe(1);
    const html = async () => ({ ok: true, headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(downloadImage(normalizeResult(raw({ url: 'https://img.example.org/other.jpg' })), { dir, fetchImpl: html })).rejects.toThrow(/이미지가 아닙니다/);
    expect((await downloadImage(normalizeResult(raw({ license: 'by', license_version: '4.0', url: 'https://img.example.org/by.jpg' })), { dir, fetchImpl })).needsCredit).toBe(true);
  });
});

describe('memeYoutubeMeta', () => {
  it('시리즈 제목 공식, 창작 고지, 사진 출처를 설명란에 넣는다', () => {
    const m = memeYoutubeMeta({ episode: 3, seriesTitle: '팩폭 댓글', items: [statement, panels], credits: ['"Cat" by Jane — CC BY 4.0 — https://example.org/cat'] });
    expect(m.title).toBe('개웃긴 팩폭 댓글 3탄ㅋㅋㅋ');
    // 회차마다 앞부분(1번 밈 상황)이 달라야 같은 템플릿의 반복으로 보이지 않는다
    expect(memeYoutubeMeta({ episode: 1, hook: "단톡방에 '잘못 보낸 카톡'에 달린 댓글 한 줄", items: [statement, panels] }).title)
      .toBe("단톡방에 '잘못 보낸 카톡'에 달린 댓글 한 줄 | 한 줄 댓글 밈 1탄ㅋㅋㅋ");
    expect(m.description).toContain('1. 첫 줄');
    expect(m.description).toContain('2. 하나');
    expect(m.description).toContain('직접 쓴 창작물');
    expect(m.description).toContain('사진 출처\n- "Cat" by Jane — CC BY 4.0');
  });
  it('출처가 없으면 출처 단락을 넣지 않는다', () => {
    expect(memeYoutubeMeta({ episode: 1, items: [statement, dialogue] }).description).not.toContain('사진 출처');
  });
});

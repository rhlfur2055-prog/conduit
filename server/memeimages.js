// ============================================================
// 밈 쇼츠용 사진 수급 — Openverse (키 없음 · 익명 분당 20회 / 하루 200회)
//   재사용이 허락된 사진만 받는다: 기본은 CC0(저작자가 권리를 포기한 것), 필요하면 CC BY(출처 표기 의무).
//   Flickr 의 "퍼블릭 도메인 마크(pdm)"는 올린 사람이 붙인 표시일 뿐이라 기본값에서 뺐다.
//   검색 관련도가 들쭉날쭉하므로 자동으로 고르지 않는다 — 후보를 돌려주고, 고르는 것은 사람(또는 검수 단계)이 한다.
//   받은 사진마다 제목·저작자·출처·라이선스를 manifest.json 에 남겨 설명란 표기를 자동으로 만든다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PIPELINE_DIR } from './videoPipeline.js';

const API = 'https://api.openverse.org/v1/images/';
// Wikimedia 는 연락처가 있는 User-Agent 를 요구한다 (없으면 차단될 수 있다)
const UA = 'ConduitShorts/1.0 (https://github.com/rhlfur2055-prog/conduit)';
export const MEME_DIR = path.join(PIPELINE_DIR, 'public', 'memes');

const LICENSE_NAME = { cc0: 'CC0 1.0', pdm: 'Public Domain Mark 1.0', by: 'CC BY', 'by-sa': 'CC BY-SA' };

/** Commons·Openverse 는 연속 호출하면 429 를 준다 — 조금 기다렸다 다시 시도한다 */
async function fetchRetry(url, opts, fetchImpl = fetch, tries = 6) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, opts);
    if (res.ok || (res.status !== 429 && res.status < 500) || i >= tries - 1) return res;
    const wait = Number(res.headers?.get?.('retry-after')) * 1000 || 2000 * 2 ** i; // 2초부터 두 배씩
    await new Promise((r) => setTimeout(r, Math.min(wait, 30000)));
  }
}
const ALLOWED = new Set(['cc0', 'pdm', 'by']); // NC·ND·SA 는 받지 않는다

/** Openverse 응답 한 건 → 우리가 쓰는 모양. 쓸 수 없는 것(라이선스·크기·형식)은 null */
export function normalizeResult(r, { minWidth = 700 } = {}) {
  if (!r || !r.url || !ALLOWED.has(r.license)) return null;
  const ext = (String(r.filetype || '') || path.extname(new URL(r.url).pathname).slice(1)).toLowerCase().replace('jpeg', 'jpg');
  if (!['jpg', 'png', 'webp'].includes(ext)) return null;
  if (r.width && r.width < minWidth) return null;
  if (r.mature) return null;
  return {
    id: r.id, title: (r.title || '').trim() || '(제목 없음)', creator: (r.creator || '').trim() || '(저작자 미상)',
    license: r.license, licenseVersion: r.license_version || '', licenseUrl: r.license_url || '',
    source: r.source || r.provider || '', landingUrl: r.foreign_landing_url || '', url: r.url,
    thumbnail: r.thumbnail || '', width: r.width || 0, height: r.height || 0, ext,
  };
}

/** 설명란에 넣을 출처 한 줄 (제목 · 저작자 · 라이선스 · 출처 URL). CC0 는 의무가 없지만 같이 적는다 */
export function attributionLine(c) {
  const lic = c.license === 'by' ? `CC BY ${c.licenseVersion}`.trim() : (LICENSE_NAME[c.license] || c.license);
  return `"${c.title}" by ${c.creator} — ${lic} — ${c.landingUrl || c.url}`;
}

/**
 * @param {{ query:string, licenses?:string, limit?:number, minWidth?:number, fetchImpl?:typeof fetch }} opts
 * @returns {Promise<{ query, total, candidates, rate:{burst:string|null, daily:string|null} }>}
 */
export async function searchImages({ query, licenses = 'cc0', limit = 12, minWidth = 700, fetchImpl = fetch }) {
  const q = String(query || '').trim();
  if (!q) throw Object.assign(new Error('검색어가 비었습니다'), { status: 400 });
  const url = `${API}?q=${encodeURIComponent(q)}&license=${encodeURIComponent(licenses)}&page_size=${Math.min(20, Math.max(1, limit))}&mature=false`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw Object.assign(new Error(`Openverse ${res.status}`), { status: res.status });
  const j = await res.json();
  return {
    query: q, total: j.result_count || 0,
    candidates: (j.results || []).map((r) => normalizeResult(r, { minWidth })).filter(Boolean),
    rate: { burst: res.headers?.get?.('x-ratelimit-available-anon_burst') ?? null, daily: res.headers?.get?.('x-ratelimit-available-anon_sustained') ?? null },
  };
}

/* ---------- Wikimedia Commons (키 없음) — 분류가 잘 돼 있어 "여러 마리가 카메라를 보는" 같은 구체적 장면은 이쪽이 낫다 ---------- */
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Commons 의 저작자 칸은 틀이 두 번 렌더되어 "Unknown authorUnknown author" 처럼 같은 말이 붙어 나올 때가 있다.
 * 반복을 접고, 저작자 미상은 한국어로 바꾼다.
 */
export function cleanCreator(raw) {
  let s = stripTags(raw);
  const half = s.length / 2;
  if (s.length && Number.isInteger(half) && s.slice(0, half) === s.slice(half)) s = s.slice(0, half); // 통째로 두 번
  s = s.replace(/^(.+?)\1+$/, '$1').trim();                                                           // 붙어서 반복
  if (!s || /^unknown( author)?$/i.test(s) || /^(author )?unknown$/i.test(s)) return '촬영자 미상';
  return s;
}

/** Commons 의 라이선스 표기 → 우리 코드. 동일조건(SA)·비영리(NC)·변경금지(ND)는 null */
export function commonsLicense(shortName) {
  const s = String(shortName || '').trim();
  if (/^cc0/i.test(s)) return { license: 'cc0', version: '1.0' };
  if (/^(public domain|pd\b|pd-)/i.test(s)) return { license: 'pdm', version: '1.0' };
  const m = s.match(/^cc[ -]by[ -](\d(?:\.\d)?)$/i);
  return m ? { license: 'by', version: m[1] } : null;
}

export function normalizeCommons(page, { minWidth = 700 } = {}) {
  const ii = page?.imageinfo?.[0];
  if (!ii?.url) return null;
  const meta = ii.extmetadata || {};
  const lic = commonsLicense(meta.LicenseShortName?.value);
  if (!lic) return null;
  const ext = path.extname(new URL(ii.url).pathname).slice(1).toLowerCase().replace('jpeg', 'jpg');
  if (!['jpg', 'png', 'webp'].includes(ext)) return null;
  if (ii.width && ii.width < minWidth) return null;
  return {
    id: `commons-${page.pageid}`, title: String(page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
    creator: cleanCreator(meta.Artist?.value),
    license: lic.license, licenseVersion: lic.version, licenseUrl: meta.LicenseUrl?.value || '',
    // 원본이 수십 MB 인 경우가 많아 1280px 판을 받는다. 미리보기는 500px — 둘 다 Wikimedia 가 허용하는 표준 폭이다
    source: 'wikimedia', landingUrl: ii.descriptionurl || '', url: ii.thumburl && ii.width > 1280 ? ii.thumburl : ii.url,
    thumbnail: ii.thumburl ? ii.thumburl.replace(/\/\d+px-/, '/500px-') : ii.url, width: ii.width || 0, height: ii.height || 0, ext,
  };
}

/** @returns {Promise<{ query, total, candidates }>} */
export async function searchCommons({ query, limit = 40, minWidth = 700, fetchImpl = fetch }) {
  const q = String(query || '').trim();
  if (!q) throw Object.assign(new Error('검색어가 비었습니다'), { status: 400 });
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: String(Math.min(50, limit)),
    gsrsearch: `${q} filetype:bitmap`, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1280',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist',
  });
  const res = await fetchRetry(`${COMMONS_API}?${params}`, { headers: { 'User-Agent': UA } }, fetchImpl);
  if (!res.ok) throw Object.assign(new Error(`Commons ${res.status}`), { status: res.status });
  const pages = Object.values((await res.json())?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return { query: q, total: pages.length, candidates: pages.map((p) => normalizeCommons(p, { minWidth })).filter(Boolean) };
}

/* ---------- 영상 클립 (Wikimedia Commons) — 레퍼런스처럼 실제 영상을 보여 주되, 재사용이 허락된 것만 ---------- */
export function normalizeCommonsVideo(page, { minDur = 3, maxDur = 120, minWidth = 480 } = {}) {
  const vi = page?.videoinfo?.[0];
  if (!vi?.url) return null;
  const meta = vi.extmetadata || {};
  const lic = commonsLicense(meta.LicenseShortName?.value);
  if (!lic) return null;
  const dur = Number(vi.duration) || 0;
  if (dur < minDur || dur > maxDur || (vi.width || 0) < minWidth) return null;
  // 원본이 수백 MB 인 경우가 있어 1080p 이하 변환본 중 가장 큰 것을 받는다
  const smaller = (vi.derivatives || []).filter((d) => /webm|mp4/.test(d.type || '') && (d.height || 0) <= 1080 && (d.height || 0) >= 360).sort((a, b) => b.height - a.height)[0];
  return {
    id: `commons-${page.pageid}`, kind: 'video', title: String(page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
    creator: cleanCreator(meta.Artist?.value),
    license: lic.license, licenseVersion: lic.version, licenseUrl: meta.LicenseUrl?.value || '',
    source: 'wikimedia', landingUrl: vi.descriptionurl || '', url: (vi.height || 0) > 1080 && smaller ? smaller.src : vi.url,
    thumbnail: vi.thumburl || '', width: vi.width || 0, height: vi.height || 0, durationSec: Math.round(dur * 10) / 10,
  };
}

export async function searchCommonsVideos({ query, limit = 50, fetchImpl = fetch, ...filter }) {
  const q = String(query || '').trim();
  if (!q) throw Object.assign(new Error('검색어가 비었습니다'), { status: 400 });
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: String(Math.min(50, limit)),
    gsrsearch: `${q} filetype:video`, prop: 'videoinfo', viprop: 'url|size|extmetadata|derivatives', viurlwidth: '500',
    viextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist',
  });
  const res = await fetchImpl(`${COMMONS_API}?${params}`, { headers: { 'User-Agent': `${UA}; rhlfur2055-prog/conduit` } });
  if (!res.ok) throw Object.assign(new Error(`Commons ${res.status}`), { status: res.status });
  const pages = Object.values((await res.json())?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return { query: q, total: pages.length, candidates: pages.map((p) => normalizeCommonsVideo(p, filter)).filter(Boolean) };
}

/**
 * 올릴 근거 — Commons 파일 페이지에서 원출처(Flickr 등) 링크와 라이선스 검수 기록을 읽어 온다.
 * 검수 기록: Flickr 에서 옮겨 온 파일은 봇(FlickreviewR / Flickr upload bot)이 옮길 당시의 라이선스를 확인해 분류에 남긴다.
 */
export async function commonsProvenance(landingUrl, { fetchImpl = fetch } = {}) {
  const m = String(landingUrl || '').match(/\/wiki\/(File:.+)$/);
  if (!m) return null;
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', titles: decodeURIComponent(m[1]).replace(/_/g, ' '),
    prop: 'imageinfo|categories', iiprop: 'extmetadata', iiextmetadatafilter: 'Credit|Artist|AttributionRequired|DateTimeOriginal', cllimit: '500',
  });
  const res = await fetchRetry(`${COMMONS_API}?${params}`, { headers: { 'User-Agent': UA } }, fetchImpl);
  if (!res.ok) return null;
  const page = Object.values((await res.json())?.query?.pages || {})[0];
  const meta = page?.imageinfo?.[0]?.extmetadata || {};
  const links = [...`${meta.Credit?.value || ''} ${meta.Artist?.value || ''}`.matchAll(/href="([^"]+)"/g)].map((x) => x[1].replace(/^\/\//, 'https://')).filter((u) => !/wikimedia\.org|wikipedia\.org/.test(u));
  const cats = (page?.categories || []).map((c) => String(c.title).replace('Category:', ''));
  return {
    originalUrl: links[0] || '', creatorUrl: links[1] || '',
    licenseReview: cats.filter((c) => /reviewed by|Flickr upload bot|^PD[ -]|License review/i.test(c)),
    takenAt: stripTags(meta.DateTimeOriginal?.value), attributionRequired: meta.AttributionRequired?.value === 'true',
  };
}

/** 화면에 띄울 출처 한 줄 — 표기 의무가 없는 퍼블릭 도메인도 똑같이 밝힌다 */
export function screenCredit(c) {
  const lic = c.license === 'by' ? `CC BY ${c.licenseVersion}`.trim() : c.license === 'cc0' ? 'CC0' : '퍼블릭 도메인';
  const who = String(c.creator || '').split(/ from |,|\(/)[0].trim().slice(0, 30) || '저작자 미상';
  const site = c.source === 'wikimedia' ? 'Wikimedia Commons' : c.source;
  return `출처: ${who} · ${lic} · ${site}`;
}

const readManifest = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return {}; } };
const hashName = (s, ext) => `ov-${crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)}.${ext}`;

async function record(dir, name, c, extra = {}, fetchImpl = fetch) {
  const provenance = c.source === 'wikimedia' ? await commonsProvenance(c.landingUrl, { fetchImpl }).catch(() => null) : null;
  const manifest = readManifest(dir);
  manifest[name] = {
    title: c.title, creator: c.creator, license: c.license, licenseVersion: c.licenseVersion, licenseUrl: c.licenseUrl,
    source: c.source, landingUrl: c.landingUrl, url: c.url, ...(provenance || {}), ...extra,
    attribution: attributionLine(c) + (provenance?.originalUrl ? ` (원본: ${provenance.originalUrl})` : ''), screenCredit: screenCredit(c),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest[name];
}

/** 고른 사진을 public/memes 로 받고 manifest 에 출처·원본 링크·검수 기록을 남긴다. 이미 받은 것은 다시 받지 않는다 */
export async function downloadImage(c, { dir = MEME_DIR, fetchImpl = fetch } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const name = hashName(c.url, c.ext);
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    const res = await fetchImpl(c.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw Object.assign(new Error(`사진 받기 실패 ${res.status}: ${c.url}`), { status: res.status });
    const type = String(res.headers?.get?.('content-type') || '');
    if (type && !type.startsWith('image/')) throw new Error(`이미지가 아닙니다 (${type}): ${c.url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const m = await record(dir, name, c, {}, fetchImpl);
  return { file, rel: `memes/${name}`, attribution: m.attribution, credit: m.screenCredit, needsCredit: c.license === 'by' };
}

/**
 * 고른 영상에서 필요한 구간만 잘라 mp4 로 저장한다 (원본 webm/ogv → h264, 소리 제거, 긴 변 1080 이하).
 * @param {{ start?:number, duration?:number, crop?:string }} cut 초 단위. crop 은 ffmpeg crop 인자 "w:h:x:y" — 피사체가 작게 잡힌 가로 영상을 세로 화면에서 크게 보이게 할 때
 */
export async function downloadClip(c, { start = 0, duration = 8, crop, audio = false } = {}, { dir = MEME_DIR, fetchImpl = fetch, run, srcFile } = {}) {
  if (crop && !/^\d+:\d+:\d+:\d+$/.test(crop)) throw new Error(`crop 형식이 잘못됐습니다: ${crop}`);
  fs.mkdirSync(dir, { recursive: true });
  // audio 는 기본 꺼짐 — 무성영화에 덧입힌 음악처럼 영상과 별개로 저작권이 있는 소리가 섞여 있을 수 있다.
  // 원음 자체가 같은 출처의 기록(NASA 교신 등)일 때만 켠다.
  const name = hashName(`${c.url}#${start}+${duration}+${crop || ''}${audio ? '+a' : ''}`, 'mp4');
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    // srcFile — 내용을 확인하려고 이미 받아 둔 원본이 있으면 다시 받지 않는다
    const tmp = srcFile || path.join(dir, `${name}.src`);
    if (!srcFile) {
      const res = await fetchImpl(c.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw Object.assign(new Error(`영상 받기 실패 ${res.status}: ${c.url}`), { status: res.status });
      const type = String(res.headers?.get?.('content-type') || '');
      if (type && !/^(video|application\/ogg)/.test(type)) throw new Error(`영상이 아닙니다 (${type}): ${c.url}`);
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    }
    try {
      const exec = run || (await import('./spawn.js')).runCommand;
      // 폭 1080 으로 맞춘다 — 옛 기록 영상(320x240)은 브라우저 확대보다 lanczos 로 미리 키우는 쪽이 깨끗하다
      // -ss 를 -i 뒤에 둬야 정확히 그 지점에서 잘린다. 앞에 두면 키프레임으로 밀려 엉뚱한 장면이 들어온다
      // (옛 영상은 키프레임 간격이 넓어 1~2초씩 어긋났다). 원본이 로컬 파일이라 느려도 문제없다.
      await exec('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-ss', String(start), '-t', String(duration), ...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-vf', `${crop ? `crop=${crop},` : ''}scale=1080:-2:flags=lanczos,fps=30`, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { cwd: dir });
    } finally { if (!srcFile) fs.rmSync(tmp, { force: true }); }
  }
  const m = await record(dir, name, c, { clip: { start, duration, crop: crop || null, audio } }, fetchImpl);
  return { file, rel: `memes/${name}`, attribution: m.attribution, credit: m.screenCredit, needsCredit: c.license === 'by' };
}

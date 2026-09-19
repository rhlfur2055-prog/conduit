// ============================================================
// 핫이슈 쇼츠 렌더 브리지 — 주제 하나 + 뉴스 헤드라인 2~3개 → 세로 영상
//   훅(주제) → 헤드라인 카드(각각 낭독) → CTA. 문장별 TTS 실측 길이가 화면 타임라인을 결정.
//   대본은 실제 헤드라인만 읽고 출처를 화면·설명란에 표기한다 (수치 지어내기 없음).
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';

const PIPELINE_DIR = 'C:/workflow/video-pipeline';
const OUT_DIR = path.join(PIPELINE_DIR, 'out');
const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

const ORDINAL = ['첫 번째', '두 번째', '세 번째', '네 번째', '다섯 번째'];
export const DEFAULT_CTA = '자세한 내용은 설명란 출처 링크에서 확인하세요. 내일 아침 9시, 다음 핫이슈로 만나요.';

/** 언론사 헤드라인 정리 — [단독]·(종합) 같은 꼬리표 제거, 너무 길면 구절 경계에서 자름 */
export function cleanHeadline(s, max = 90) {
  let t = String(s || '')
    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*(종합|현장|영상|사진)[^)]*\)/g, ' ')
    .replace(/中/g, '중')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const idx = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf('…'), cut.lastIndexOf('→'), cut.lastIndexOf(' · '), cut.lastIndexOf(' '));
    t = (idx > max * 0.5 ? cut.slice(0, idx) : cut).replace(/[,.·→\s]+$/, '') + '…';
  }
  return t;
}

/** "제목 - 머니투데이" 처럼 제목 끝에 붙은 언론사 이름을 뗀다 (출처는 따로 표기하므로 중복) */
export function stripSourceSuffix(title, source) {
  const t = String(title || '');
  if (!source) return t;
  const esc = String(source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(`\\s*[-–—|:]\\s*${esc}\\s*$`), '').trim();
}

/** 대본 — TTS 로 읽을 문장과 화면 카드 */
export function buildIssueScript({ topic, headlines = [], maxHeadlines = 3, cta = DEFAULT_CTA }) {
  const cards = headlines
    .filter((h) => h && h.title)
    .slice(0, Math.max(1, maxHeadlines))
    .map((h) => {
      const source = String(h.source || '').trim();
      return { title: cleanHeadline(stripSourceSuffix(h.title, source)), source, url: h.url || '' };
    });
  if (!cards.length) throw new Error('헤드라인이 없습니다');
  return {
    hook: `오늘 검색이 급증한 키워드, ${topic}. 무슨 일이 있었을까요?`,
    items: cards.map((c, i) => `${ORDINAL[i] || `${i + 1}번째`}. ${c.title}`),
    ending: String(cta || DEFAULT_CTA),
    cards,
  };
}

/** 유튜브 제목·설명·태그 — 출처 링크를 설명란에 남긴다 */
export function issueYoutubeMeta({ topic, cards, date = new Date() }) {
  const d = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  const lines = [
    `${d} 검색 급상승 키워드 "${topic}" — 오늘 나온 헤드라인을 출처와 함께 정리했습니다.`,
    '',
    '출처',
    ...cards.map((c, i) => `${i + 1}. ${c.source ? c.source + ' · ' : ''}${c.title}${c.url ? '\n   ' + c.url : ''}`),
    '',
    '이 영상은 공개된 뉴스 헤드라인을 소개합니다. 자세한 내용은 위 링크의 원문을 확인하세요.',
    '',
    `#핫이슈 #오늘의이슈 #실시간검색어 #${String(topic).replace(/\s+/g, '')}`,
  ];
  return {
    title: `${topic}, 오늘 왜 뜬 걸까? | 핫이슈 3줄`,
    description: lines.join('\n'),
    tags: ['핫이슈', '오늘의 이슈', '실시간 검색어', topic, ...cards.map((c) => c.source).filter(Boolean)].join(','),
  };
}

/**
 * @param {{ topic:string, traffic?:number, headlines:Array<{title,source?,url?}>, maxHeadlines?:number, voice?:string, cta?:string }} opts
 * @returns {Promise<{ok:boolean,file?:string,thumbnail?:string,durationSec?:number,sizeMB?:number,yt?:object,error?:string}>}
 */
export async function renderIssueBrief({ topic, traffic, headlines, maxHeadlines = 3, voice = '선희(여)', cta }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'IssueBrief.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  if (!topic) return { ok: false, error: 'topic 이 비어 있습니다' };
  let script;
  try { script = buildIssueScript({ topic, headlines, maxHeadlines, cta }); } catch (e) { return { ok: false, error: e.message }; }

  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-issue-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `issue-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `issue-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-issue-${stamp}.json`);

  // 1) 문장별 TTS → 실측 프레임
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `issue-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/issue-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = { hook: await toSeg(script.hook, 'hook'), items: [], ending: await toSeg(script.ending, 'end') };
  for (let i = 0; i < script.items.length; i++) segments.items.push(await toSeg(script.items[i], `h${i}`));

  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  const date = new Date();
  const props = {
    topic: String(topic),
    traffic: Number(traffic) || 0,
    date: `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`,
    headlines: script.cards.map(({ title, source }) => ({ title, source })),
    segments,
    ...(bgmSrc ? { bgmSrc } : {}),
  };
  fs.writeFileSync(propsFile, JSON.stringify(props));

  try {
    // 2) Remotion 렌더 → 3) ffmpeg 후처리 → 4) 썸네일 → 5) 검증
    await run('npx', ['remotion', 'render', 'src/index.ts', 'IssueBrief', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
    await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '128k', finalMp4], PIPELINE_DIR);
    await run('ffmpeg', ['-y', '-ss', '0.5', '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);
    const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
    const info = JSON.parse(probe).format || {};
    return {
      ok: true, file: finalMp4, thumbnail: thumb,
      durationSec: Math.round(Number(info.duration) * 10) / 10,
      sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
      narrated: true, synced: true, headlineCount: script.cards.length,
      script,
      yt: issueYoutubeMeta({ topic, cards: script.cards, date }),
    };
  } finally {
    fs.rmSync(raw, { force: true });
    fs.rmSync(propsFile, { force: true });
    for (const c of copies) fs.rmSync(c, { force: true });
  }
}

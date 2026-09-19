// ============================================================
// 2D:4D 손가락 길이비 렌더 브리지
//   유사과학 주장(재물운·성격)을 논문으로 갈라내는 포맷.
//   화면 문구·내레이션 모두 다국어(ko/en/ja/es). 시각(손 도식)은 언어 무관.
//   ⚠️ 수치는 server/i18n.js DR 주석의 검증본만 사용할 것 (no-fake-stats).
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';
import { drNarration, TTS_VOICE, ytMeta } from './i18n.js';

const PIPELINE_DIR = 'C:/workflow/video-pipeline';
const OUT_DIR = path.join(PIPELINE_DIR, 'out');

const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

/** 2D:4D 손가락 길이비 렌더
 *  @param {{voice?:string, locale?:string}} opts
 *  @returns {Promise<{ok:boolean,file?:string,thumbnail?:string,durationSec?:number,sizeMB?:number,error?:string}>} */
export async function renderDigitRatio({ voice, locale = 'ko' } = {}) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'DigitRatio.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-dr-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `digitratio-${locale}-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `digitratio-${locale}-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-dr-${stamp}.json`);

  // 1) 장면별 TTS — 실측 길이가 각 장면의 화면 시간을 결정한다
  const narr = drNarration(locale);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || TTS_VOICE[locale] || TTS_VOICE.ko });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `drseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/drseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    intro: await toSeg(narr.intro, 'intro'),
    types: await toSeg(narr.types, 'types'),
    truth: await toSeg(narr.truth, 'truth'),
    ending: await toSeg(narr.ending, 'end'),
  };

  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({ segments, locale, ...(bgmSrc ? { bgmSrc } : {}) }));

  // 2) 렌더 → 3) 후처리 → 4) 썸네일(손 도식 구간) → 5) 검증
  await run('npx', ['remotion', 'render', 'src/index.ts', 'DigitRatio', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
  await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '128k', finalMp4], PIPELINE_DIR);
  await run('ffmpeg', ['-y', '-ss', '2', '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);
  const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
  const info = JSON.parse(probe).format || {};
  fs.rmSync(raw, { force: true });
  fs.rmSync(propsFile, { force: true });
  for (const c of copies) fs.rmSync(c, { force: true });

  return {
    ok: true, file: finalMp4, thumbnail: thumb,
    durationSec: Math.round(Number(info.duration) * 10) / 10,
    sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
    locale, narrated: true,
    title: ytMeta('digitRatio', locale).title,
  };
}

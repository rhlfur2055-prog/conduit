// ============================================================
// 색각 숫자 테스트 렌더 브리지 — 이시하라식 절차 생성 쇼츠
//   문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
//   npx remotion render → ffmpeg 후처리(H.264 CRF23, loudnorm) → 썸네일
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';
import { cvNarration, TTS_VOICE, ytMeta } from './i18n.js';

import { PIPELINE_DIR, OUT_DIR } from './videoPipeline.js';

const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

/** 색각 숫자 테스트 렌더 — 문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
 *  @param {{title?:string, plates:Array<{number:string,palette:'easy'|'mid'|'hard',seed?:number,qText?:string,aText?:string}>, cta?:string, countdownSec?:number, voice?:string}} opts
 *  @returns {Promise<{ok:boolean,file?:string,thumbnail?:string,durationSec?:number,sizeMB?:number,error?:string}>} */
export async function renderColorVision({ title, plates, cta, countdownSec, voice, locale = 'ko', compact = false }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'ColorVision.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const ps = (Array.isArray(plates) ? plates : [])
    .filter((p) => p && p.number != null && /^[0-9]{1,3}$/.test(String(p.number)))
    .map((p, i) => ({
      number: String(p.number),
      palette: ['easy', 'mid', 'hard'].includes(p.palette) ? p.palette : (['easy', 'mid', 'hard'][i] || 'hard'),
      seed: Number.isFinite(Number(p.seed)) && p.seed ? Number(p.seed) : (i + 1) * 9973 + 17,
      qText: p.qText, aText: p.aText,
    }));
  if (!ps.length) return { ok: false, error: 'plates 배열이 비어 있습니다 (number는 1~3자리 숫자 문자열)' };

  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-cv-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `colorvision-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `colorvision-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-cv-${stamp}.json`);

  // 1) 문장별 TTS 생성 + 실측 → 세그먼트
  const narr = cvNarration(ps, locale, compact);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || TTS_VOICE[locale] || TTS_VOICE.ko });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `cvseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/cvseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    // 컴팩트 모드는 인트로가 비어 있다 — 세그먼트를 아예 만들지 않아야 타임라인이 0프레임부터 시작한다
    ...(narr.intro ? { intro: await toSeg(narr.intro, 'intro') } : {}),
    rounds: [],
    ending: await toSeg(narr.ending, 'end'),
  };
  for (let i = 0; i < ps.length; i++) {
    segments.rounds.push({
      q: await toSeg(narr.rounds[i].q, `q${i}`),
      a: await toSeg(narr.rounds[i].a, `a${i}`),
    });
  }

  // 퀴즈 전용 부드러운 BGM (public/bgm-quiz 재사용)
  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || ytMeta('colorVision', locale).title),
    plates: ps.map(({ number, palette, seed }) => ({ number, palette, seed })),
    ...(cta ? { cta: String(cta) } : {}),
    locale,
    countdownSec: Number(countdownSec) || 3,
    segments,
    ...(bgmSrc ? { bgmSrc } : {}),
  }));

  // 2) Remotion 렌더 → 3) ffmpeg 후처리 → 4) 썸네일 → 5) 검증
  await run('npx', ['remotion', 'render', 'src/index.ts', 'ColorVision', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
  await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '128k', finalMp4], PIPELINE_DIR);
  await run('ffmpeg', ['-y', '-ss', '1', '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);
  const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
  const info = JSON.parse(probe).format || {};
  fs.rmSync(raw, { force: true });
  fs.rmSync(propsFile, { force: true });
  for (const c of copies) fs.rmSync(c, { force: true });

  return {
    ok: true, file: finalMp4, thumbnail: thumb,
    durationSec: Math.round(Number(info.duration) * 10) / 10,
    sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
    narrated: true, synced: true, segmentCount: (narr.intro ? 2 : 1) + ps.length * 2, locale, compact,
  };
}

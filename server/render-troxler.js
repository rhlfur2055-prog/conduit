// ============================================================
// 트록슬러 사라짐 렌더 브리지 — 해외 겨냥(글자 의존 최소) 15~20초 포맷
//   ⚠️ 응시 구간에는 어떤 시각적 변화도 넣지 않는다. 화면이 정지해 있어야
//      시청자의 지각에서만 색이 사라진다 (그게 이 포맷의 전부다).
//   내레이션도 응시 구간에는 넣지 않는다 — 소리에 주의가 끌리면 시선이 흔들린다.
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';
import { txNarration, TTS_VOICE, ytMeta } from './i18n.js';

import { PIPELINE_DIR, OUT_DIR } from './videoPipeline.js';

const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

/** 트록슬러 사라짐 렌더
 *  @param {{holdSec?:number, voice?:string, locale?:string}} opts
 *  @returns {Promise<{ok:boolean,file?:string,thumbnail?:string,durationSec?:number,sizeMB?:number,error?:string}>} */
export async function renderTroxler({ holdSec, voice, locale = 'ko' } = {}) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'Troxler.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  // 응시 시간: 너무 짧으면 사라짐이 안 일어나고, 너무 길면 이탈한다
  const hold = Math.min(Math.max(Number(holdSec) || 11, 7), 16);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-tx-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `troxler-${locale}-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `troxler-${locale}-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-tx-${stamp}.json`);

  // 1) 문장별 TTS (응시 구간 hold 는 의도적으로 비움)
  const narr = txNarration(locale);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || TTS_VOICE[locale] || TTS_VOICE.ko });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `txseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/txseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    intro: await toSeg(narr.intro, 'intro'),
    reveal: await toSeg(narr.reveal, 'reveal'),
    ending: await toSeg(narr.ending, 'end'),
  };

  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({ holdSec: hold, segments, locale, ...(bgmSrc ? { bgmSrc } : {}) }));

  // 2) 렌더 → 3) 후처리 → 4) 썸네일 → 5) 검증
  await run('npx', ['remotion', 'render', 'src/index.ts', 'Troxler', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
  await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '128k', finalMp4], PIPELINE_DIR);
  // 썸네일은 응시 구간에서 뽑는다 (색 블롭이 가장 선명한 구간)
  await run('ffmpeg', ['-y', '-ss', '3', '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);
  const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
  const info = JSON.parse(probe).format || {};
  fs.rmSync(raw, { force: true });
  fs.rmSync(propsFile, { force: true });
  for (const c of copies) fs.rmSync(c, { force: true });

  return {
    ok: true, file: finalMp4, thumbnail: thumb,
    durationSec: Math.round(Number(info.duration) * 10) / 10,
    sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
    holdSec: hold, locale, narrated: true,
    title: ytMeta('troxler', locale).title,
  };
}

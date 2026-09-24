// ============================================================
// 집중력 반전 테스트 렌더 브리지 — src/AttentionTest.tsx
// "빨간 공이 벽에 몇 번 튕기는지 세어보세요!" (고릴라 실험 개념 재현, 저작권 청정)
//   문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
//   바운스 정답은 여기서 물리 시뮬(결정적)로 사전 계산해 props 에 주입
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';
import { atNarration, TTS_VOICE, ytMeta } from './i18n.js';

import { PIPELINE_DIR, OUT_DIR } from './videoPipeline.js';

/* [주의] src/AttentionTest.tsx 의 ARENA / BALL_R / 물리 공식과 반드시 동일하게 유지할 것 */
const ARENA = { x: 40, y: 460, w: 1000, h: 1250 };
const BALL_R = 55;

const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

/* ---------- 결정적 물리: 축별 벽 반사 횟수 (컴포지션과 동일한 접기 공식) ---------- */
function axisBounces(p0, v, tSec, min, max) {
  const span = max - min - 2 * BALL_R;
  const u0 = p0 - min - BALL_R;
  const u1 = u0 + v * tSec;
  return Math.abs(Math.floor(u1 / span) - Math.floor(u0 / span));
}
function redBounceTotal(balls, playSec) {
  let n = 0;
  for (const b of balls) {
    if (b.color !== 'red') continue;
    n += axisBounces(b.x0, b.vx, playSec, ARENA.x, ARENA.x + ARENA.w);
    n += axisBounces(b.y0, b.vy, playSec, ARENA.y, ARENA.y + ARENA.h);
  }
  return n;
}

/* 기본 공 세트: 빨강2 파랑2 노랑2 — 초기 위치는 아레나 내부, 속도는 px/초 */
const DEFAULT_BALLS = [
  { color: 'red', x0: 300, y0: 640, vx: 330, vy: 280 },
  { color: 'red', x0: 780, y0: 1400, vx: -360, vy: -300 },
  { color: 'blue', x0: 540, y0: 900, vx: 390, vy: -410 },
  { color: 'blue', x0: 200, y0: 1500, vx: 480, vy: 300 },
  { color: 'yellow', x0: 860, y0: 700, vx: -440, vy: 420 },
  { color: 'yellow', x0: 420, y0: 1250, vx: -350, vy: -390 },
];

function sanitizeBalls(balls) {
  const src = Array.isArray(balls) && balls.length ? balls : DEFAULT_BALLS;
  return src.map((b) => ({
    color: b.color === 'red' || b.color === 'blue' || b.color === 'yellow' ? b.color : 'blue',
    x0: Math.min(Math.max(Number(b.x0) || 540, ARENA.x + BALL_R), ARENA.x + ARENA.w - BALL_R),
    y0: Math.min(Math.max(Number(b.y0) || 1000, ARENA.y + BALL_R), ARENA.y + ARENA.h - BALL_R),
    vx: Number(b.vx) || 350,
    vy: Number(b.vy) || 320,
  }));
}

/** 집중력 반전 테스트 렌더 — @returns {ok, file, thumbnail, durationSec, sizeMB, answer} */
export async function renderAttentionTest({ title, balls, catAt, playSec, cta, voice, locale = 'ko' } = {}) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'AttentionTest.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  const play = Math.min(Math.max(Number(playSec) || 12, 6), 20);
  const outBalls = sanitizeBalls(balls);
  if (!outBalls.some((b) => b.color === 'red')) return { ok: false, error: '빨간 공이 최소 1개 필요합니다' };

  // 고양이 통과 구간: 기본 8초~11초 (3초간), 재생 길이 안으로 클램프
  const from = Math.min(Math.max(Number(catAt?.fromSec) || 8, 1), play - 2);
  const to = Math.min(Math.max(Number(catAt?.toSec) || from + 3, from + 1.5), play - 0.5);
  const cat = { fromSec: from, toSec: to };

  // 바운스 정답: 물리 시뮬로 사전 계산 (컴포지션과 동일 공식 → 화면과 항상 일치)
  const answer = redBounceTotal(outBalls, play);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-attention-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `attention-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `attention-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-attention-${stamp}.json`);

  // 1) 문장별 TTS 생성 + 실측 → 세그먼트
  const narr = atNarration(answer, locale);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || TTS_VOICE[locale] || TTS_VOICE.ko });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `attseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/attseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    intro: await toSeg(narr.intro, 'intro'),
    rounds: [
      { q: await toSeg(narr.q1, 'q0'), a: await toSeg(narr.a1, 'a0') },
      { q: await toSeg(narr.q2, 'q1'), a: await toSeg(narr.a2, 'a1') },
    ],
    ending: await toSeg(narr.ending, 'end'),
  };

  // 퀴즈용 부드러운 BGM 재사용 (public/bgm-quiz)
  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || ytMeta('attention', locale).title),
    balls: outBalls,
    catAt: cat,
    answer,
    playSec: play,
    ...(cta ? { cta: String(cta) } : {}),
    locale,
    segments,
    ...(bgmSrc ? { bgmSrc } : {}),
  }));

  // 2) Remotion 렌더 → 3) ffmpeg 후처리 → 4) 썸네일
  await run('npx', ['remotion', 'render', 'src/index.ts', 'AttentionTest', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
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
    answer, narrated: true, synced: true, segmentCount: 6,
  };
}

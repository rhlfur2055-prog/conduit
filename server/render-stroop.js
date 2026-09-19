// ============================================================
// 스트룹 테스트 쇼츠 렌더 — "글자 말고, '색'을 말하세요!"
// 문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
//   렌더: npx remotion render → ffmpeg 후처리(H.264 CRF23, loudnorm) → 썸네일
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';

const PIPELINE_DIR = 'C:/workflow/video-pipeline';
const OUT_DIR = path.join(PIPELINE_DIR, 'out');

const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

/* ---------- 색이름 ↔ hex (src/Stroop.tsx 의 COLOR_HEX 와 동일해야 함) ---------- */
const COLOR_HEX = {
  빨강: '#ef4444',
  파랑: '#3b82f6',
  초록: '#22c55e',
  노랑: '#facc15',
  보라: '#a855f7',
  주황: '#f97316',
};

/** rounds 미지정 시 기본 3라운드 구성 (R1 워밍업 → R2 전부 불일치 → R3 고속+배경 간섭) */
function defaultStroopRounds() {
  const w = (text, colorName) => ({ text, color: COLOR_HEX[colorName], match: text === colorName });
  return [
    { // R1: 4단어 · 1.7초 · 일치 2개 섞기 (워밍업)
      intervalFrames: 51,
      words: [w('빨강', '빨강'), w('파랑', '초록'), w('초록', '초록'), w('노랑', '보라')],
    },
    { // R2: 6단어 · 1.2초 · 전부 불일치
      intervalFrames: 36,
      words: [w('빨강', '파랑'), w('파랑', '노랑'), w('초록', '빨강'), w('노랑', '초록'), w('보라', '주황'), w('주황', '보라')],
    },
    { // R3: 6단어 · 0.8초 · 전부 불일치 + 배경 간섭
      intervalFrames: 24,
      bgInterference: true,
      words: [w('보라', '초록'), w('노랑', '빨강'), w('파랑', '주황'), w('초록', '보라'), w('주황', '파랑'), w('빨강', '노랑')],
    },
  ];
}

/** 라운드에서 기본 내레이션 문장 생성 (round.qText/aText 로 덮어쓰기 가능) */
function stroopNarration(rounds) {
  const pace = (r) => (r.intervalFrames <= 30 ? '아주 빠르게 지나갑니다' : r.intervalFrames <= 40 ? '조금 빨라집니다' : '천천히 갑니다');
  return {
    intro: '지금부터 스트룹 테스트를 시작합니다. 글자를 읽지 말고, 글자의 색깔을 소리 내어 말하세요.',
    rounds: rounds.map((r, i) => {
      const q = r.qText || `라운드 ${i + 1}. 글자 말고 색을 말하세요. ${pace(r)}.`;
      const a = r.aText || (i === rounds.length - 1 ? '수고하셨습니다. 결과를 확인해 볼까요?' : '잘 따라오고 계신가요? 다음 라운드로 갑니다.');
      return { q, a };
    }),
    ending: '몇 개나 헷갈리셨나요? 뇌가 글자를 먼저 읽는 게 당연하니, 개수를 댓글로 남겨 주세요.',
  };
}

/** 스트룹 테스트 렌더. @returns {ok, file, thumbnail, durationSec, sizeMB} */
export async function renderStroop({ title, rounds, cta, voice }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'Stroop.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const rs = Array.isArray(rounds) && rounds.length ? rounds : defaultStroopRounds();
  for (const r of rs) {
    if (!Array.isArray(r.words) || !r.words.length) return { ok: false, error: '각 라운드에 words 배열이 필요합니다' };
    if (!Number.isFinite(Number(r.intervalFrames)) || r.intervalFrames <= 0) return { ok: false, error: 'intervalFrames가 올바르지 않습니다' };
  }

  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-stroop-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `stroop-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `stroop-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-stroop-${stamp}.json`);

  // 1) 문장별 TTS 생성 + ffprobe 실측 → 세그먼트
  const narr = stroopNarration(rs);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || '인준(남)' });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `stroopseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/stroopseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    intro: await toSeg(narr.intro, 'intro'),
    rounds: [],
    ending: await toSeg(narr.ending, 'end'),
  };
  for (let i = 0; i < rs.length; i++) {
    segments.rounds.push({
      q: await toSeg(narr.rounds[i].q, `q${i}`),
      a: await toSeg(narr.rounds[i].a, `a${i}`),
    });
  }

  // 퀴즈 계열 부드러운 BGM (public/bgm-quiz)
  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || '글자 말고 색을 말하세요'),
    rounds: rs.map((r) => ({
      intervalFrames: Number(r.intervalFrames),
      ...(r.bgInterference !== undefined ? { bgInterference: !!r.bgInterference } : {}),
      words: r.words.map((w) => ({
        text: String(w.text),
        color: String(w.color || COLOR_HEX[w.text] || '#ffffff'),
        match: w.match !== undefined ? !!w.match : String(w.color) === COLOR_HEX[w.text],
      })),
    })),
    cta: String(cta || '헷갈린 개수를 댓글로! 👇'),
    segments,
    ...(bgmSrc ? { bgmSrc } : {}),
  }));

  // 2) Remotion 렌더 → 3) ffmpeg 후처리 → 4) 썸네일 → 5) 실측
  await run('npx', ['remotion', 'render', 'src/index.ts', 'Stroop', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
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
    narrated: true, synced: true, segmentCount: 2 + rs.length * 2,
  };
}

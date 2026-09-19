// ============================================================
// 영상 렌더 브리지 — 로컬 Remotion 파이프라인(C:/workflow/video-pipeline)으로
// 데이터 랭킹 쇼츠를 실제 렌더링한다. (n8n은 외부 유료 API가 필요한 부분)
//   렌더: npx remotion render → ffmpeg 후처리(H.264 CRF23, faststart) → 썸네일
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PIPELINE_DIR = 'C:/workflow/video-pipeline';
const OUT_DIR = path.join(PIPELINE_DIR, 'out');

function run(cmd, args, cwd, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('시간 초과: ' + cmd)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`${cmd} 스폰 실패: ${e.message}`)); });
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(`${cmd} 종료코드 ${code}: ${err.slice(-500)}`));
    });
  });
}

/* ---------- 국기 PNG 캐시 (flagcdn.com — 무료, 키 불필요) ---------- */
async function ensureFlags(items) {
  const flagDir = path.join(PIPELINE_DIR, 'public', 'flags');
  fs.mkdirSync(flagDir, { recursive: true });
  for (const d of items) {
    if (!d.code) continue;
    const code = String(d.code).toLowerCase();
    const dest = path.join(flagDir, `${code}.png`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 500) continue;
    try {
      const res = await fetch(`https://flagcdn.com/w160/${code}.png`);
      if (res.ok) fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    } catch { /* 국기 없으면 회색 박스로 렌더됨 */ }
  }
}

/** 회전 실루엣 착시 테스트 렌더 — 섹션별 내레이션 실측 길이가 타임라인 결정 (1:1 싱크) */
export async function renderSpinTest({ title, subtitle, sections, voice, modelSrc, secPerRev }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'SpinTest.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const secs = Array.isArray(sections) ? sections : [];
  if (!secs.length) return { ok: false, error: 'sections 배열이 비어 있습니다' };
  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-spin-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `spin-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `spin-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-spin-${stamp}.json`);

  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const outSections = [];
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i];
    let seg;
    if (s.narr) {
      const r = await speak({ text: s.narr, voice: voice || '선희(여)' });
      if (!r.ok) return { ok: false, error: `TTS 실패(섹션${i}): ${r.error || ''}` };
      const dest = path.join(audioDir, `spinseg-${stamp}-${i}.mp3`);
      fs.copyFileSync(r.file, dest);
      copies.push(dest);
      seg = { src: `audio/spinseg-${stamp}-${i}.mp3`, frames: Math.ceil(r.durationSec * 30) };
    }
    outSections.push({ band: s.band, sub: s.sub, accent: s.accent, ...(seg ? { seg } : {}) });
  }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || '착시 테스트'),
    subtitle: subtitle ? String(subtitle) : undefined,
    sections: outSections,
    modelSrc: modelSrc || 'models/cat.glb',
    secPerRev: Number(secPerRev) || 3,
  }));

  await run('npx', ['remotion', 'render', 'src/index.ts', 'SpinTest', raw, `--props=${propsFile}`, '--codec=h264', '--gl=angle', '--log=error'], PIPELINE_DIR);
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
    narrated: true, synced: true,
    credit: '3D 모델: Cat — Poly by Google (CC-BY 3.0) · poly.pizza',
  };
}

/** 라운드에서 기본 내레이션 문장 생성 (round.qText/aText 로 덮어쓰기 가능) */
function quizNarration(rounds, title) {
  const num = ['하나', '둘', '셋', '넷', '다섯'];
  return {
    intro: `지금부터 두뇌 나이를 측정해 보겠습니다.`,
    rounds: rounds.map((r, i) => {
      const q = r.qText || `문제 ${num[i] || i + 1}. ${r.prompt} 시간은 오초입니다.`;
      let a;
      if (r.type === 'hidden') a = r.aText || `정답은, ${r.word}였습니다.`;
      else if (r.type === 'chosung') a = r.aText || `정답은, ${r.answer}!`;
      else a = r.aText || `정답은 여기 있습니다.`;
      return { q, a };
    }),
    ending: `몇 개 맞히셨나요? 댓글로 알려주세요.`,
  };
}

/** 시니어 두뇌퀴즈 렌더 — 문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화) */
export async function renderBrainQuiz({ title, rounds, cta, countdownSec, voice }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'BrainQuiz.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const rs = Array.isArray(rounds) ? rounds : [];
  if (!rs.length) return { ok: false, error: 'rounds 배열이 비어 있습니다' };

  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-quiz-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `quiz-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `quiz-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-quiz-${stamp}.json`);

  // 1) 문장별 TTS 생성 + 실측 → 세그먼트 (캐시 재사용)
  const narr = quizNarration(rs, title);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || '인준(남)' });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `quizseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/quizseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
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

  // 퀴즈 전용 부드러운 BGM (public/bgm-quiz)
  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || '두뇌 테스트'),
    rounds: rs,
    cta: String(cta || '댓글로 알려주세요!'),
    countdownSec: Number(countdownSec) || 5,
    segments,
    ...(bgmSrc ? { bgmSrc } : {}),
  }));

  await run('npx', ['remotion', 'render', 'src/index.ts', 'BrainQuiz', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
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

/** 데이터 랭킹 쇼츠 렌더 (내레이션 선택). @returns {file, thumbnail, durationSec, sizeMB, narrated} */
export async function renderDataShort({ title, subtitle, data, cta, source, audioPath, composition, teaseText }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'DataShort.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const items = Array.isArray(data) ? data : [];
  if (!items.length) return { ok: false, error: 'data 배열이 비어 있습니다' };

  const comp = composition === 'DataShort' ? 'DataShort' : 'RankRace'; // 기본 v2
  if (comp === 'RankRace') await ensureFlags(items);

  // BGM: public/bgm/*.mp3 가 있으면 자동 선곡 (제목 해시로 결정적 로테이션)
  let bgmSrc;
  try {
    const bgmDir = path.join(PIPELINE_DIR, 'public', 'bgm');
    const loops = fs.existsSync(bgmDir) ? fs.readdirSync(bgmDir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) {
      let h = 0;
      for (const ch of String(title || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      bgmSrc = `bgm/${loops[h % loops.length]}`;
    }
  } catch { /* BGM 없이 진행 */ }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `short-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `short-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-${stamp}.json`);

  // 내레이션(선택): public/audio 로 복사해야 Remotion staticFile 로 접근 가능
  let audioSrc;
  let narrationCopy;
  if (audioPath && fs.existsSync(String(audioPath))) {
    const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    narrationCopy = path.join(audioDir, `narration-${stamp}.mp3`);
    fs.copyFileSync(String(audioPath), narrationCopy);
    audioSrc = `audio/narration-${stamp}.mp3`;
  }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || '랭킹'),
    subtitle: String(subtitle || ''),
    data: items.map((d) => ({
      label: String(d.label), value: Number(d.value) || 0,
      suffix: d.suffix ? String(d.suffix) : undefined,
      code: d.code ? String(d.code).toLowerCase() : undefined,
      highlight: !!d.highlight,
      finale: !!d.finale,
      rank: Number.isFinite(Number(d.rank)) && d.rank ? Number(d.rank) : undefined,
    })),
    cta: String(cta || '팔로우하고 다음 랭킹 받기'),
    source: String(source || ''),
    ...(teaseText ? { teaseText: String(teaseText) } : {}),
    ...(audioSrc ? { audioSrc } : {}),
    ...(bgmSrc ? { bgmSrc } : {}),
  }));

  // 1) Remotion 렌더
  await run('npx', ['remotion', 'render', 'src/index.ts', comp, raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);

  // 2) ffmpeg 후처리 (쇼츠 규격 보정 + 스트리밍 최적화 · 내레이션 있으면 라우드니스 정규화)
  const audioArgs = audioSrc
    ? ['-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '128k']
    : ['-c:a', 'aac', '-b:a', '96k'];
  await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', ...audioArgs, finalMp4], PIPELINE_DIR);

  // 3) 썸네일 (1초 지점)
  await run('ffmpeg', ['-y', '-ss', '1', '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);

  // 4) 검증
  const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
  const info = JSON.parse(probe).format || {};
  fs.rmSync(raw, { force: true });
  fs.rmSync(propsFile, { force: true });
  if (narrationCopy) fs.rmSync(narrationCopy, { force: true });

  return {
    ok: true,
    file: finalMp4,
    thumbnail: thumb,
    durationSec: Math.round(Number(info.duration) * 10) / 10,
    sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
    narrated: !!audioSrc,
  };
}

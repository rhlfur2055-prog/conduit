// ============================================================
// 정신연령 판정 테스트 렌더 브리지 — 로컬 Remotion 파이프라인으로
// MindAge 쇼츠를 렌더링한다. (문장별 TTS 실측 길이가 타임라인 결정, 1:1 싱크)
//   렌더: npx remotion render → ffmpeg 후처리(H.264 CRF23, loudnorm) → 썸네일
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

const DEFAULT_GRADES = [
  { range: '3~4점', label: '정신연령 45세, 애늙은이' },
  { range: '5~6점', label: '정신연령 28세, 균형형' },
  { range: '7~9점', label: '정신연령 17세, 영원한 사춘기' },
];

const LETTER_KO = ['에이', '비', '씨'];

/** 질문에서 기본 내레이션 문장 생성 (q.qText / q.aText 로 덮어쓰기 가능) */
function mindAgeNarration(questions, grades, title) {
  return {
    intro: `${title || '정신연령 테스트'}. 마음속으로 점수를 더하면서 따라오세요.`,
    rounds: questions.map((qu, i) => {
      const choiceRead = qu.choices.map((c, j) => `${LETTER_KO[j] || ''}, ${c.label}`).join('. ');
      const q = qu.qText || `질문 ${i + 1}. ${qu.q} ${choiceRead}. 시간은 오초입니다.`;
      const a = qu.aText || `${qu.choices.map((c) => `${c.label}은 ${c.score}점`).join(', ')}. 내 점수, 기억하세요!`;
      return { q, a };
    }),
    ending: `자, 이제 점수를 모두 더해 보세요. ${grades.map((g) => `${g.range}은, ${g.label}`).join('. ')}. 몇 점 나왔는지 댓글로 알려주세요!`,
  };
}

/** 정신연령 판정 테스트 렌더 — 문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
 *  @returns {ok, file, thumbnail, durationSec, sizeMB} */
export async function renderMindAge({ title, questions, grades, cta, thinkSec, voice }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'MindAge.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const qs = Array.isArray(questions) ? questions : [];
  if (!qs.length) return { ok: false, error: 'questions 배열이 비어 있습니다' };
  for (let i = 0; i < qs.length; i++) {
    if (!Array.isArray(qs[i].choices) || !qs[i].choices.length) {
      return { ok: false, error: `questions[${i}].choices 가 비어 있습니다` };
    }
  }
  const gs = Array.isArray(grades) && grades.length ? grades : DEFAULT_GRADES;

  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-mindage-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `mindage-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `mindage-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-mindage-${stamp}.json`);

  // 1) 문장별 TTS 생성 + 실측 → 세그먼트
  const narr = mindAgeNarration(qs, gs, title);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || '인준(남)' });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `mindageseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/mindageseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    intro: await toSeg(narr.intro, 'intro'),
    rounds: [],
    ending: await toSeg(narr.ending, 'end'),
  };
  for (let i = 0; i < qs.length; i++) {
    segments.rounds.push({
      q: await toSeg(narr.rounds[i].q, `q${i}`),
      a: await toSeg(narr.rounds[i].a, `a${i}`),
    });
  }

  // 퀴즈 전용 부드러운 BGM (public/bgm-quiz — 있으면 사용)
  let bgmSrc;
  try {
    const dir = path.join(PIPELINE_DIR, 'public', 'bgm-quiz');
    const loops = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')) : [];
    if (loops.length) bgmSrc = `bgm-quiz/${loops[0]}`;
  } catch { /* BGM 없이 진행 */ }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || '정신연령 테스트'),
    questions: qs.map((q) => ({
      q: String(q.q),
      choices: q.choices.map((c) => ({ label: String(c.label), score: Number(c.score) || 1 })),
    })),
    grades: gs.map((g) => ({ range: String(g.range), label: String(g.label) })),
    cta: String(cta || '몇 점 나왔어요? 댓글로!'),
    thinkSec: Number(thinkSec) || 5,
    segments,
    ...(bgmSrc ? { bgmSrc } : {}),
  }));

  // 2) Remotion 렌더 → 3) ffmpeg 후처리 → 4) 썸네일 → 5) 검증
  await run('npx', ['remotion', 'render', 'src/index.ts', 'MindAge', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
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
    narrated: true, synced: true, segmentCount: 2 + qs.length * 2,
  };
}

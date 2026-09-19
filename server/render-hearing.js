// ============================================================
// 청력 나이 테스트 렌더 브리지 — 로컬 Remotion 파이프라인으로
// 주파수 단계별 청력 테스트 쇼츠를 렌더링한다.
//   문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
//   ⚠️ 최종 후처리에서 loudnorm 금지 — 고주파 테스트 톤이 왜곡됨.
//      오디오는 -c:a aac -b:a 192k 재인코딩만 수행한다.
// ============================================================
import { runCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';

const PIPELINE_DIR = 'C:/workflow/video-pipeline';
const OUT_DIR = path.join(PIPELINE_DIR, 'out');

const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

/* ---------- 기본 단계 (유튜브 AAC ~16kHz 컷 → 판정 기준은 16kHz까지, 17kHz는 보너스) ---------- */
const DEFAULT_STEPS = [
  { freq: 8000, age: '60대' },
  { freq: 10000, age: '50대' },
  { freq: 12000, age: '40대' },
  { freq: 14000, age: '30대' },
  { freq: 15000, age: '25세' },
  { freq: 16000, age: '20세' },
  { freq: 17000, age: '10대', bonus: true, caption: '유튜브 압축 한계로 재생 안 될 수 있어요' },
];

/* ---------- 테스트 톤 보장 — 없으면 ffmpeg sine 소스로 직접 생성 (public/tones) ---------- */
async function ensureTones(steps) {
  const toneDir = path.join(PIPELINE_DIR, 'public', 'tones');
  fs.mkdirSync(toneDir, { recursive: true });
  const out = [];
  for (const s of steps) {
    const k = `${s.freq / 1000}k`.replace('.', '_');
    const file = `tone-${k}.m4a`;
    const dest = path.join(toneDir, file);
    if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
      // 3초 사인파 톤: 페이드 인/아웃으로 클릭 노이즈 방지, 48kHz + 고컷오프로 17kHz까지 보존
      await run('ffmpeg', [
        '-y', '-f', 'lavfi', '-i', `sine=frequency=${s.freq}:duration=3`,
        '-af', 'volume=0.5,afade=t=in:d=0.3,afade=t=out:st=2.5:d=0.5',
        '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-cutoff', '20000',
        dest,
      ], PIPELINE_DIR);
    }
    out.push({ ...s, toneSrc: `tones/${file}` });
  }
  return out;
}

/* ---------- 단계에서 기본 내레이션 문장 생성 (step.qText/aText 로 덮어쓰기 가능) ---------- */
function hearingNarration(steps) {
  const last = steps.length - 1;
  return {
    intro: '지금부터 당신의 청력 나이를 측정합니다. 볼륨을 최대로 올리고, 소리가 들리는 마지막 단계를 기억하세요.',
    rounds: steps.map((s, i) => {
      const kHz = s.freq / 1000;
      let q;
      if (s.bonus) q = s.qText || `마지막 보너스, ${kHz}킬로헤르츠. 유튜브 압축 한계로 재생되지 않을 수 있습니다. 그래도 들리면, 십대의 귀!`;
      else q = s.qText || `${kHz}킬로헤르츠. 이 소리가 들리면, 당신의 귀는 ${s.age} 이하입니다.`;
      let a;
      if (s.bonus) a = s.aText || '들렸다면 정말 대단한 귀입니다.';
      else if (i === last) a = s.aText || '여기까지 들렸다면 최고 등급입니다.';
      else a = s.aText || (i % 2 ? '통과했다면 다음 단계로 갑니다.' : '들리셨나요? 다음 단계입니다.');
      return { q, a };
    }),
    ending: '몇 살에서 멈췄나요? 십육 킬로헤르츠까지가 판정 기준, 십칠 킬로헤르츠는 보너스입니다. 멈춘 나이를 댓글로 알려주세요.',
  };
}

/** 청력 나이 테스트 렌더 — 문장별 TTS 실측 길이가 화면 타임라인을 결정 (1:1 동기화)
 *  @returns {ok, file, thumbnail, durationSec, sizeMB} */
export async function renderHearingAge({ title, steps, voice } = {}) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'HearingAge.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const baseSteps = Array.isArray(steps) && steps.length ? steps : DEFAULT_STEPS;

  const speak = globalThis.__conduitTtsSpeak;
  if (!speak) return { ok: false, error: 'TTS 브리지가 없습니다 (서버 재시작 필요)' };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const raw = path.join(OUT_DIR, `raw-hearing-${stamp}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `hearing-${stamp}.mp4`);
  const thumb = path.join(OUT_DIR, `hearing-${stamp}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-hearing-${stamp}.json`);

  // 0) 테스트 톤 보장 (없으면 ffmpeg로 생성)
  const fullSteps = await ensureTones(baseSteps);

  // 1) 문장별 TTS 생성 + 실측 → 세그먼트
  const narr = hearingNarration(fullSteps);
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const copies = [];
  const toSeg = async (text, key) => {
    const r = await speak({ text, voice: voice || '인준(남)' });
    if (!r.ok) throw new Error(`TTS 실패(${key}): ${r.error || ''}`);
    const dest = path.join(audioDir, `hearseg-${stamp}-${key}.mp3`);
    fs.copyFileSync(r.file, dest);
    copies.push(dest);
    return { src: `audio/hearseg-${stamp}-${key}.mp3`, frames: Math.ceil(r.durationSec * 30) };
  };
  const segments = {
    intro: await toSeg(narr.intro, 'intro'),
    rounds: [],
    ending: await toSeg(narr.ending, 'end'),
  };
  for (let i = 0; i < fullSteps.length; i++) {
    segments.rounds.push({
      q: await toSeg(narr.rounds[i].q, `q${i}`),
      a: await toSeg(narr.rounds[i].a, `a${i}`),
    });
  }

  fs.writeFileSync(propsFile, JSON.stringify({
    title: String(title || '당신의 청력 나이는?'),
    steps: fullSteps.map((s) => ({
      freq: Number(s.freq), age: String(s.age), toneSrc: String(s.toneSrc),
      ...(s.bonus ? { bonus: true } : {}),
      ...(s.caption ? { caption: String(s.caption) } : {}),
    })),
    segments,
  }));

  // 2) Remotion 렌더
  await run('npx', ['remotion', 'render', 'src/index.ts', 'HearingAge', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);

  // 3) ffmpeg 후처리 — ⚠️ loudnorm 절대 금지 (고주파 테스트 톤 왜곡).
  //    내레이션은 TTS 생성 시점 볼륨 그대로, 오디오는 AAC 192k 재인코딩만.
  await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', finalMp4], PIPELINE_DIR);

  // 4) 썸네일 (1초 지점)
  await run('ffmpeg', ['-y', '-ss', '1', '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);

  // 5) 검증 + 정리
  const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
  const info = JSON.parse(probe).format || {};
  fs.rmSync(raw, { force: true });
  fs.rmSync(propsFile, { force: true });
  for (const c of copies) fs.rmSync(c, { force: true });

  return {
    ok: true, file: finalMp4, thumbnail: thumb,
    durationSec: Math.round(Number(info.duration) * 10) / 10,
    sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
    narrated: true, synced: true, segmentCount: 2 + fullSteps.length * 2,
  };
}

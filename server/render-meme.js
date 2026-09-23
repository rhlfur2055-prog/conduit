// ============================================================
// 밈 댓글 쇼츠 렌더 브리지 — 검은 배경 · 상단 고정 2줄 제목 · [캡션 + 사진] · 빨간 테두리 댓글
//   화면의 모든 글자를 TTS 가 읽는다. 줄마다 세그먼트를 따로 만들어 실측 프레임으로 1:1 싱크한다.
//   캡션은 내레이터 음성, 댓글은 다른 음성으로 읽어 "툭 던지는" 느낌을 낸다.
//   대본은 직접 쓴 것이고, 사진은 재사용이 허락된 것(CC0·퍼블릭 도메인·CC BY)만 받는다 — 출처는 설명란에 적는다.
// ============================================================
import { runCommand } from './spawn.js';
import { ttsSegment, ttsText } from './ttsseg.js';
import fs from 'node:fs';
import path from 'node:path';

import { PIPELINE_DIR, OUT_DIR } from './videoPipeline.js';
const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

const MAX_LINE = 24;
const MAX_PUNCH = 30;

/** 대본 검증 — 문제가 있으면 이유 배열(비면 통과) */
export function validateMemeItems(items) {
  if (!Array.isArray(items) || items.length < 2 || items.length > 8) return ['밈은 2~8개여야 합니다'];
  const errs = [];
  items.forEach((it, i) => {
    const n = i + 1;
    if (!it || typeof it !== 'object') { errs.push(`${n}번: 객체가 아닙니다`); return; }
    const punch = String(it.punch || '').trim();
    if (!punch) errs.push(`${n}번: 댓글(punch)이 비었습니다`);
    if (punch.length > MAX_PUNCH) errs.push(`${n}번: 댓글이 ${MAX_PUNCH}자를 넘습니다`);
    if (it.kind === 'panels') {
      if (!Array.isArray(it.panels) || it.panels.length < 2 || it.panels.length > 4) errs.push(`${n}번: 패널은 2~4개여야 합니다`);
      (it.panels || []).forEach((p, j) => {
        if (!String(p?.caption || '').trim()) errs.push(`${n}번 패널 ${j + 1}: 캡션이 비었습니다`);
        if (!String(p?.image || '').trim()) errs.push(`${n}번 패널 ${j + 1}: 사진이 없습니다`);
      });
    } else {
      const lines = Array.isArray(it.setupLines) ? it.setupLines : [];
      if (lines.length < 1 || lines.length > 3) errs.push(`${n}번: 캡션은 1~3줄이어야 합니다`);
      lines.forEach((l, j) => {
        if (!String(l || '').trim()) errs.push(`${n}번 ${j + 1}줄: 비었습니다`);
        if (String(l || '').length > MAX_LINE) errs.push(`${n}번 ${j + 1}줄: ${MAX_LINE}자를 넘습니다`);
      });
      if (!String(it.image || it.video || '').trim()) errs.push(`${n}번: 사진(또는 영상)이 없습니다`);
    }
    // 출처를 밝히는 것이 올릴 근거다 — 화면 표기(credit)와 설명란 표기(attribution)가 없으면 렌더하지 않는다
    if (!String(it.credit || '').trim()) errs.push(`${n}번: 화면 출처 표기(credit)가 없습니다`);
    if (!String(it.attribution || '').trim()) errs.push(`${n}번: 설명란 출처(attribution)가 없습니다`);
  });
  return errs;
}

export { ttsText }; // 낭독용 글자 변환은 ttsseg.js 로 옮겼다 (다른 렌더 모듈과 공용)

/**
 * 밈 하나의 박자(프레임). video-pipeline/src/MemeComments.tsx 의 itemBeats 와 같은 공식이어야 한다.
 *   ① 캡션 첫 줄을 읽는 동안 사진 칸은 검정 → ② 사진 공개(둘째 줄이 있으면 둘째 줄과 함께) → ③ 댓글
 * @param {number[]} frames 줄(또는 패널)별 낭독 길이
 */
export function memeBeats(frames, { panels = false, punchFrames = 0 } = {}) {
  const LINE_GAP = 4, PHOTO_BEAT = 38, PUNCH_GAP = 8, HOLD = 40;
  let t = 0;
  const beatAt = frames.map((f) => { const s = t; t += f + LINE_GAP; return s; });
  const spoken = Math.max(0, t - LINE_GAP);
  const imageAt = panels ? 0 : frames.length >= 2 ? beatAt[1] : spoken + LINE_GAP;
  const lastVisual = panels ? (beatAt[beatAt.length - 1] ?? 0) : imageAt;
  const punchAt = Math.max(spoken + PUNCH_GAP, lastVisual + PHOTO_BEAT);
  return { beatAt, imageAt, punchAt, len: punchAt + punchFrames + HOLD };
}

/**
 * 업로드 제목 공식: "[1번 밈 상황 한마디] | 시리즈 N탄ㅋㅋㅋ" — 회차마다 앞부분이 달라야 같은 템플릿의 반복으로 보이지 않는다.
 * hook 이 없으면 시리즈 제목만 쓴다.
 */
export function memeYoutubeMeta({ episode, seriesTitle = '한 줄 댓글 밈', hook, items, credits = [], persona = { name: '오덤덤' } }) {
  const firstLine = (it) => (it.kind === 'panels' ? it.panels?.[0]?.caption : it.setupLines?.[0]) || '';
  return {
    title: hook ? `${hook} | ${seriesTitle} ${episode}탄ㅋㅋㅋ` : `개웃긴 ${seriesTitle} ${episode}탄ㅋㅋㅋ`,
    description: [
      `${persona.name}의 ${seriesTitle} ${episode}탄.`,
      '',
      ...items.map((it, i) => `${i + 1}. ${firstLine(it)}`),
      '',
      '대본(캡션·댓글)은 직접 쓴 창작물이며, 등장하는 상황은 모두 가상입니다.',
      ...(credits.length ? ['', '사진 출처', ...credits.map((c) => `- ${c}`)] : []),
      '',
      '#밈 #웃긴영상 #댓글모음 #공감 #shorts',
    ].join('\n'),
    tags: ['밈', '웃긴영상', '댓글모음', '공감', '팩폭', persona.name].join(','),
  };
}

const firstMp3 = (dir) => {
  try {
    const full = path.join(PIPELINE_DIR, 'public', dir);
    const f = fs.existsSync(full) ? fs.readdirSync(full).filter((x) => x.endsWith('.mp3')) : [];
    return f.length ? `${dir}/${f[0]}` : undefined;
  } catch { return undefined; }
};
const sfxIf = (name) => (fs.existsSync(path.join(PIPELINE_DIR, 'public', 'sfx', name)) ? `sfx/${name}` : undefined);

/**
 * @param {{
 *   episode:number, titleLine1:string, titleLine2:string, accent?:string, seriesTitle?:string,
 *   persona?:{name:string, avatar?:string},
 *   items:Array<{kind:'statement'|'dialogue'|'panels', setupLines?:string[], emphasis?:string, image?:string,
 *                panels?:Array<{image:string, caption:string}>, punch:string, credit?:string, attribution?:string}>,
 *   voice?:string, punchVoice?:string, tempo?:number
 * }} opts  image/avatar 는 절대 경로(→ public/memes 로 복사) 또는 public 기준 상대 경로
 */
export async function renderMemeComments({
  episode = 1, titleLine1 = '사진보다 웃긴', titleLine2 = '댓글 한 줄', accent, seriesTitle, hook, persona = { name: '오덤덤' },
  items, voice = '선희(여)', punchVoice = '인준(남)', tempo = 1.18,
}) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'MemeComments.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const bad = validateMemeItems(items);
  if (bad.length) return { ok: false, error: bad.join(' / ') };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  const memeDir = path.join(PIPELINE_DIR, 'public', 'memes');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(memeDir, { recursive: true });

  const ep = Number(episode) || 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = `meme-${String(ep).padStart(3, '0')}-${stamp}`;
  const raw = path.join(OUT_DIR, `raw-${tag}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `${tag}.mp4`);
  const thumb = path.join(OUT_DIR, `${tag}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-${tag}.json`);
  const made = [];

  // 줄 하나 = TTS 세그먼트 하나 (앞뒤 무음 제거 + 속도 조정은 ttsseg.js)
  const segment = async (text, v, key) => {
    const r = await ttsSegment({ text, voice: v, tempo, audioDir, name: `${tag}-${key}.mp3`, cwd: PIPELINE_DIR });
    made.push(r.file);
    return { src: r.src, frames: r.frames };
  };

  // 절대 경로로 받은 사진은 public/memes 로 옮겨 staticFile 로 읽게 한다
  const stage = (file) => {
    const f = String(file);
    if (!path.isAbsolute(f)) return f.replace(/\\/g, '/');
    if (!fs.existsSync(f)) throw new Error(`사진이 없습니다: ${f}`);
    const name = path.basename(f);
    const dest = path.join(memeDir, name);
    if (path.resolve(dest) !== path.resolve(f)) fs.copyFileSync(f, dest);
    return `memes/${name}`;
  };

  try {
    const built = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const punch = { text: String(it.punch), seg: await segment(it.punch, punchVoice, `${i}-p`) };
      if (it.kind === 'panels') {
        const panels = [];
        for (let j = 0; j < it.panels.length; j++) {
          const p = it.panels[j];
          panels.push({ imageSrc: stage(p.image), caption: String(p.caption), seg: await segment(p.caption, voice, `${i}-${j}`) });
        }
        built.push({ kind: 'panels', lines: [], panels, punch, credit: it.credit });
      } else {
        const lines = [];
        for (let j = 0; j < it.setupLines.length; j++) {
          lines.push({ text: String(it.setupLines[j]), seg: await segment(it.setupLines[j], voice, `${i}-${j}`) });
        }
        const media = {};
        if (it.video) {
          media.videoSrc = stage(it.video);
          const sec = parseFloat(await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(PIPELINE_DIR, 'public', media.videoSrc)], PIPELINE_DIR));
          media.videoFrames = Math.max(30, Math.floor(sec * 30) - 1);
        } else {
          media.imageSrc = stage(it.image);
        }
        built.push({ kind: it.kind === 'dialogue' ? 'dialogue' : 'statement', lines, ...media, emphasis: it.emphasis || undefined, punch, credit: it.credit });
      }
    }

    const props = {
      titleLine1, titleLine2, accent,
      persona: { name: persona.name, avatarSrc: persona.avatar ? stage(persona.avatar) : undefined },
      items: built,
      bgmSrc: firstMp3('bgm-quiz') || firstMp3('bgm'),
      sfx: { pop: sfxIf('impact.mp3'), whoosh: sfxIf('whoosh.mp3') },
    };
    fs.writeFileSync(propsFile, JSON.stringify(props));

    await run('npx', ['remotion', 'render', 'src/index.ts', 'MemeComments', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
    await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '160k', finalMp4], PIPELINE_DIR);

    // 썸네일은 1번 밈의 댓글이 뜬 직후
    const first = built[0];
    const isPanels = first.kind === 'panels';
    const { punchAt } = memeBeats(isPanels ? first.panels.map((p) => p.seg.frames) : first.lines.map((l) => l.seg.frames), { panels: isPanels });
    const thumbAt = Math.round(((punchAt + 16) / 30) * 10) / 10;
    await run('ffmpeg', ['-y', '-ss', String(thumbAt), '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);

    const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
    const info = JSON.parse(probe).format || {};
    const credits = items.map((it) => it.attribution).filter(Boolean);
    return {
      ok: true, file: finalMp4, thumbnail: thumb, episode: ep, memeCount: items.length, narrated: true, synced: true,
      durationSec: Math.round(Number(info.duration) * 10) / 10,
      sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
      yt: memeYoutubeMeta({ episode: ep, seriesTitle, hook, items, credits, persona }),
    };
  } finally {
    fs.rmSync(raw, { force: true });
    fs.rmSync(propsFile, { force: true });
    for (const f of made) fs.rmSync(f, { force: true });
  }
}

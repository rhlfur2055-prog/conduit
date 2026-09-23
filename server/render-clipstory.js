// ============================================================
// 실영상 쇼츠 렌더 브리지 — 영상 한 편 = 실제 영상 하나 = 이야기 하나
//   레퍼런스 구조: 제목 카드(TTS 가 제목을 읽음) → 노란 라벨 → 담담한 설명 → 빨간 ??? → 마지막 한 줄.
//   자막은 "그 영상에 실제로 나오는 내용"만 쓴다. 영상과 상관없는 상황극을 얹으면 뜬금없어진다 — 공감 드립은 마지막 한 줄뿐.
//   영상은 재사용이 허락된 것만(퍼블릭 도메인·CC0·CC BY), 출처는 화면(작품명·연도)과 설명란(링크)에 밝힌다.
// ============================================================
import { runCommand } from './spawn.js';
import { ttsSegment } from './ttsseg.js';
import fs from 'node:fs';
import path from 'node:path';

import { PIPELINE_DIR, OUT_DIR } from './videoPipeline.js';
const run = (cmd, args, cwd, timeoutMs) => runCommand(cmd, args, { cwd, timeoutMs });

const STYLES = ['label', 'normal', 'question', 'punch'];
const MAX_TEXT = 22;

/** 대본 검증 — 문제가 있으면 이유 배열(비면 통과) */
export function validateStory({ uploadTitle, titleLine1, titleLine2, credit, attributions, beats } = {}) {
  const errs = [];
  if (!String(uploadTitle || '').trim()) errs.push('업로드 제목(uploadTitle)이 비었습니다');
  if (!String(titleLine1 || '').trim() || !String(titleLine2 || '').trim()) errs.push('화면 제목 2줄이 필요합니다');
  // 출처를 밝히는 것이 올릴 근거다 — 화면 표기와 설명란 표기가 없으면 렌더하지 않는다
  if (!String(credit || '').trim()) errs.push('화면 출처 표기(credit)가 없습니다');
  if (!Array.isArray(attributions) || !attributions.length || attributions.some((a) => !String(a || '').trim())) errs.push('설명란 출처(attributions)가 없습니다');
  if (!Array.isArray(beats) || beats.length < 3 || beats.length > 9) return [...errs, '자막은 3~9개여야 합니다'];
  if (!String(beats[0]?.video || beats[0]?.image || '').trim()) errs.push('첫 자막에 영상(video) 또는 사진(image)이 없습니다');
  beats.forEach((b, i) => {
    const n = i + 1;
    if (!STYLES.includes(b?.style)) errs.push(`${n}번 자막: style 은 ${STYLES.join('·')} 중 하나여야 합니다`);
    if (!String(b?.text || '').trim()) errs.push(`${n}번 자막: 글이 비었습니다`);
    if (String(b?.text || '').length > MAX_TEXT) errs.push(`${n}번 자막: ${MAX_TEXT}자를 넘습니다`);
  });
  if (beats.length && beats[beats.length - 1]?.style !== 'punch') errs.push('마지막 자막은 punch(마지막 한 줄)여야 합니다');
  return errs;
}

/** 자막 박자(프레임). video-pipeline/src/ClipStory.tsx 의 storyTimeline 과 같은 공식이어야 한다 */
export function storyBeats(titleFrames, beats) {
  const PAD = 7, QUESTION = 22, END_HOLD = 24;
  let at = titleFrames + PAD;
  const marks = beats.map((b, i) => {
    const len = b.style === 'question' ? QUESTION : (b.frames ?? 30) + (i === beats.length - 1 ? END_HOLD : PAD);
    const from = at; at += len;
    return { from, len };
  });
  return { marks, total: at };
}

export function storyYoutubeMeta({ uploadTitle, beats, attributions = [], tags = [], sourceKind = '기록 자료' }) {
  // tags 는 배열도, 쉼표로 이은 문자열도 받는다 (문자열을 그냥 펼치면 글자 단위로 쪼개진다)
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((t) => String(t).trim()).filter(Boolean);
  const all = [...new Set([...list, 'shorts'])];
  return {
    title: uploadTitle,
    description: [
      ...beats.filter((b) => b.style !== 'question').map((b) => b.text),
      '',
      `자막과 편집은 직접 만들었고, ${sourceKind}는 재사용이 허락된 것만 썼습니다.`,
      '',
      '출처',
      ...attributions.map((a) => `- ${a}`),
      '',
      all.slice(0, 5).map((t) => `#${t.replace(/\s+/g, '')}`).join(' '),
    ].join('\n'),
    tags: all.join(','),
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
 *   slug:string, uploadTitle:string, titleLine1:string, titleLine2:string, accent?:string,
 *   credit:string, attributions:string[], tags?:string[],
 *   beats:Array<{ text:string, style:'label'|'normal'|'question'|'punch', video?:string, startSec?:number }>,
 *   voice?:string, tempo?:number, clipVolume?:number
 * }} opts  video 는 public 기준 상대 경로(memes/…mp4). clipVolume 은 원음이 같은 출처의 기록일 때만 0보다 크게
 */
export async function renderClipStory({ slug = 'story', uploadTitle, titleLine1, titleLine2, accent, credit, attributions, tags, beats, voice = '선희(여)', tempo = 1.2, clipVolume = 0, sourceKind }) {
  if (!fs.existsSync(path.join(PIPELINE_DIR, 'src', 'ClipStory.tsx'))) {
    return { simulated: true, note: `영상 파이프라인이 없습니다 (${PIPELINE_DIR})` };
  }
  const bad = validateStory({ uploadTitle, titleLine1, titleLine2, credit, attributions, beats });
  if (bad.length) return { ok: false, error: bad.join(' / ') };
  for (const b of beats) {
    const f = b.video || b.image;
    if (f && !fs.existsSync(path.join(PIPELINE_DIR, 'public', f))) return { ok: false, error: `파일이 없습니다: ${f}` };
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const audioDir = path.join(PIPELINE_DIR, 'public', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = `clip-${String(slug).replace(/[^a-z0-9-]/gi, '')}-${stamp}`;
  const raw = path.join(OUT_DIR, `raw-${tag}.mp4`);
  const finalMp4 = path.join(OUT_DIR, `${tag}.mp4`);
  const thumb = path.join(OUT_DIR, `${tag}-thumb.jpg`);
  const propsFile = path.join(OUT_DIR, `props-${tag}.json`);
  const made = [];
  const seg = async (text, key) => { const s = await ttsSegment({ text, voice, tempo, audioDir, name: `${tag}-${key}.mp3`, cwd: PIPELINE_DIR }); made.push(s.file); return { src: s.src, frames: s.frames }; };

  try {
    const titleSeg = await seg(uploadTitle, 't');
    const built = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      built.push({ text: String(b.text), style: b.style, video: b.video || undefined, image: b.image || undefined, startSec: Number(b.startSec) || 0, fit: b.fit === 'contain' ? 'contain' : undefined, seg: b.style === 'question' ? undefined : await seg(b.text, String(i)) });
    }
    const props = { titleLine1, titleLine2, accent, uploadTitle, titleSeg, credit, beats: built, clipVolume, bgmSrc: firstMp3('bgm-quiz') || firstMp3('bgm'), sfx: { pop: sfxIf('impact.mp3') } };
    fs.writeFileSync(propsFile, JSON.stringify(props));

    await run('npx', ['remotion', 'render', 'src/index.ts', 'ClipStory', raw, `--props=${propsFile}`, '--codec=h264', '--log=error'], PIPELINE_DIR);
    await run('ffmpeg', ['-y', '-i', raw, '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-af', 'loudnorm=I=-14:LRA=11:TP=-1', '-c:a', 'aac', '-b:a', '160k', finalMp4], PIPELINE_DIR);

    // 썸네일은 제목 카드가 걷힌 직후 첫 자막
    const tl = storyBeats(titleSeg.frames, built.map((b) => ({ style: b.style, frames: b.seg?.frames })));
    await run('ffmpeg', ['-y', '-ss', String(Math.round(((tl.marks[0].from + 12) / 30) * 10) / 10), '-i', finalMp4, '-frames:v', '1', '-q:v', '2', thumb], PIPELINE_DIR);
    const probe = await run('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration,size', '-of', 'json', finalMp4], PIPELINE_DIR);
    const info = JSON.parse(probe).format || {};
    return {
      ok: true, file: finalMp4, thumbnail: thumb, narrated: true, synced: true, beatCount: beats.length,
      durationSec: Math.round(Number(info.duration) * 10) / 10,
      sizeMB: Math.round((Number(info.size) / 1024 / 1024) * 10) / 10,
      yt: storyYoutubeMeta({ uploadTitle, beats, attributions, tags, sourceKind: sourceKind || (beats.some((b) => b.image) && !beats.some((b) => b.video) ? '사진' : '기록 영상') }),
    };
  } finally {
    fs.rmSync(raw, { force: true });
    fs.rmSync(propsFile, { force: true });
    for (const f of made) fs.rmSync(f, { force: true });
  }
}

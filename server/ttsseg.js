// ============================================================
// 자막 한 줄 = TTS 세그먼트 하나 — 밈 쇼츠 렌더 모듈들이 같이 쓴다
//   Edge TTS 는 앞에 0.2~0.4초, 뒤에 1초 안팎의 무음을 붙여 준다("나" 한 글자가 1.9초짜리 파일).
//   그대로 이으면 호흡이 두 배로 늘어지므로 앞뒤 무음을 잘라낸 뒤 쇼츠 호흡에 맞게 조금 빠르게 만들고,
//   그 결과 파일의 실제 길이를 프레임으로 돌려준다 (타임라인은 이 실측값으로 1:1 싱크).
// ============================================================
import path from 'node:path';
import { runCommand } from './spawn.js';
import { speak } from './tts.js';

/** 화면 글자 → 낭독용 글자. "나:" 의 콜론, ㅋㅋ·이모지처럼 읽으면 어색한 것을 걷어낸다 */
export function ttsText(s) {
  return String(s || '')
    .replace(/[ㅋㅎㄷㅠㅜ]{2,}/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*:\s*$/, '')
    .replace(/\s*:\s*/g, ', ')
    .replace(/[~^*#'"‘’“”〈〉]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRIM = 'silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.03';

/**
 * @param {{ text:string, voice:string, tempo?:number, audioDir:string, name:string, cwd:string, fps?:number }} opts
 * @returns {Promise<{ file:string, src:string, frames:number }>} src 는 public 기준 상대 경로
 */
export async function ttsSegment({ text, voice, tempo = 1.18, audioDir, name, cwd, fps = 30 }) {
  const r = await speak({ text: ttsText(text), voice });
  if (!r?.ok) throw new Error(`TTS 실패(${name}): ${r?.error || '알 수 없음'}`);
  const file = path.join(audioDir, name);
  await runCommand('ffmpeg', ['-y', '-v', 'error', '-i', r.file, '-filter:a', `${TRIM},areverse,${TRIM},areverse,atempo=${tempo}`, '-c:a', 'libmp3lame', '-b:a', '128k', file], { cwd });
  const dur = parseFloat(await runCommand('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { cwd }));
  return { file, src: `audio/${name}`, frames: Math.max(8, Math.ceil(dur * fps)) };
}

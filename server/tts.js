// ============================================================
// 무료 TTS 브리지 — API 키 불필요.
//   1순위 edge : Microsoft Edge 신경망 음성 (무료·무키, 인터넷 필요) — 유료급 품질
//   2순위 sapi : Windows 내장 음성합성 (완전 오프라인, Heami)
// 같은 텍스트+음성은 해시 캐시로 재사용한다.
// ============================================================
import { spawn } from 'node:child_process';
import { spawnCommand } from './spawn.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_DIR = path.join(__dirname, 'data', 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });

export const EDGE_VOICES = {
  '선희(여)': 'ko-KR-SunHiNeural',
  '인준(남)': 'ko-KR-InJoonNeural',
  '현수(남·멀티링궐)': 'ko-KR-HyunsuMultilingualNeural',
  '제니(영어·여)': 'en-US-JennyNeural',
  '크리스토퍼(영어·남)': 'en-US-ChristopherNeural',
};

const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    const p = spawnCommand('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => resolve(Math.round(parseFloat(out) * 10) / 10 || 0));
  });
}

/* ---------- Edge TTS (신경망 · 무키) ---------- */
async function edgeTts(text, voiceName, outFile) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const tmpDir = path.join(TTS_DIR, 'tmp-' + hashOf(outFile));
  fs.mkdirSync(tmpDir, { recursive: true }); // toFile 은 디렉토리를 만들어주지 않음
  const { audioFilePath } = await tts.toFile(tmpDir, text);
  fs.copyFileSync(audioFilePath, outFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/* ---------- Windows SAPI (오프라인 폴백) ---------- */
function sapiTts(text, outWav) {
  return new Promise((resolve, reject) => {
    // 텍스트를 파일로 넘겨 따옴표/인코딩 문제 회피
    const txtFile = outWav + '.txt';
    fs.writeFileSync(txtFile, text, 'utf8');
    const ps = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      `$t = [IO.File]::ReadAllText('${txtFile.replace(/\\/g, '/')}', [Text.Encoding]::UTF8);`,
      `$s.SetOutputToWaveFile('${outWav.replace(/\\/g, '/')}');`,
      '$s.Rate = 1; $s.Speak($t); $s.Dispose();',
    ].join(' ');
    const p = spawn('powershell', ['-NoProfile', '-Command', ps]);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { fs.rmSync(txtFile, { force: true }); reject(new Error('SAPI 스폰 실패: ' + e.message)); });
    p.on('exit', (code) => {
      fs.rmSync(txtFile, { force: true });
      if (code === 0) resolve();
      else reject(new Error('SAPI 실패: ' + err.slice(0, 200)));
    });
  });
}

/**
 * 무료 TTS 실행. voice: EDGE_VOICES 한글 라벨 | 'ko-KR-...' 직접 | 'sapi'
 * @returns { ok, file, durationSec, engine, cached? }
 */
export async function speak({ text, voice = '선희(여)' }) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '내레이션 텍스트가 비어 있습니다' };

  const wantSapi = voice === 'sapi' || voice === '시스템(오프라인)';
  const edgeVoice = EDGE_VOICES[voice] || (String(voice).includes('Neural') ? voice : 'ko-KR-SunHiNeural');
  const key = hashOf(clean + '|' + (wantSapi ? 'sapi' : edgeVoice));
  const mp3 = path.join(TTS_DIR, `tts-${key}.mp3`);

  // 캐시 히트
  if (fs.existsSync(mp3)) {
    return { ok: true, file: mp3, durationSec: await ffprobeDuration(mp3), engine: 'cache', cached: true };
  }

  // 1) Edge 신경망 시도
  if (!wantSapi) {
    try {
      await edgeTts(clean, edgeVoice, mp3);
      if (fs.existsSync(mp3) && fs.statSync(mp3).size > 1000) {
        return { ok: true, file: mp3, durationSec: await ffprobeDuration(mp3), engine: 'edge:' + edgeVoice };
      }
    } catch (e) {
      console.warn('[tts] edge 실패 → SAPI 폴백:', e.message);
    }
  }

  // 2) SAPI 폴백 (wav → mp3 변환)
  const wav = mp3.replace(/\.mp3$/, '.wav');
  await sapiTts(clean, wav);
  await new Promise((resolve, reject) => {
    const p = spawnCommand('ffmpeg', ['-y', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '96k', mp3]);
    p.on('error', (e) => reject(new Error('ffmpeg 스폰 실패: ' + e.message)));
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg 변환 실패'))));
  });
  fs.rmSync(wav, { force: true });
  return { ok: true, file: mp3, durationSec: await ffprobeDuration(mp3), engine: 'sapi:Heami' };
}

// ============================================================
// 외부 프로세스 실행 — Windows 에서 npx 같은 .cmd 래퍼를 안전하게 띄운다.
//
// Node 는 보안상 .cmd/.bat 을 셸 없이 직접 spawn 하지 못하게 막고(EINVAL),
// 반대로 shell:true 에 인자 배열을 넘기면 이스케이프 없이 이어 붙인다(DEP0190 경고).
// 그래서 ① 셸이 정말 필요한 명령(.cmd/.bat 래퍼)만 PATH 에서 골라내고
//        ② 그 경우에만 인자를 직접 따옴표 처리한 한 줄 명령을 셸에 넘기며
//        ③ ffmpeg·node 처럼 진짜 실행 파일은 셸 없이 인자 배열 그대로 띄운다.
// 렌더 모듈(video.js·render-*.js)·TTS·MCP 클라이언트가 모두 이 파일을 쓴다.
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** cmd.exe 에 넘길 인자 하나를 따옴표 처리한다 */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (s !== '' && /^[\w\-.:\\/=@+,]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

export function buildCommandLine(command, args = []) {
  return [command, ...args].map(quoteForCmd).join(' ');
}

/**
 * Windows 에서 이 명령이 .cmd/.bat 래퍼라 셸이 필요한지 판단한다.
 * PATH 를 순서대로 훑으며 같은 폴더 안에서는 Windows 처럼 .com/.exe 를 .bat/.cmd 보다 먼저 본다.
 * 어디에도 없으면 false — spawn 이 ENOENT 를 내고 호출 쪽이 "스폰 실패"로 알린다.
 */
export function needsShell(command, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return false;
  const ext = path.extname(command).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') return true;
  if (ext) return false;                                        // .exe 처럼 확장자가 명시된 실행 파일
  if (command.includes('/') || command.includes('\\')) return false; // 경로가 있는데 확장자가 없음 → 그대로
  const dirs = String(env.PATH || env.Path || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    if (exists(path.join(dir, command + '.com')) || exists(path.join(dir, command + '.exe'))) return false;
    if (exists(path.join(dir, command + '.bat')) || exists(path.join(dir, command + '.cmd'))) return true;
  }
  return false;
}

/** child_process.spawn 대체 — 셸이 필요한 래퍼만 한 줄 명령으로, 나머지는 셸 없이 */
export function spawnCommand(command, args = [], options = {}) {
  if (needsShell(command)) {
    return spawn(buildCommandLine(command, args), { ...options, shell: true, windowsHide: true });
  }
  return spawn(command, args, { ...options, shell: false });
}

/** 명령을 끝까지 실행하고 stdout 을 돌려준다. 종료코드가 0 이 아니면 stderr 꼬리를 담아 거부한다. */
export function runCommand(cmd, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawnCommand(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('시간 초과: ' + cmd)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(new Error(`${cmd} 스폰 실패: ${e.message}`)); });
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 종료코드 ${code}: ${err.slice(-500)}`));
    });
  });
}

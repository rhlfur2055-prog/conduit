import { describe, it, expect } from 'vitest';
import { quoteForCmd, buildCommandLine, needsShell, runCommand } from '../../server/spawn.js';

describe('quoteForCmd — Windows 셸용 인자 따옴표 처리', () => {
  it('안전한 문자만 있으면 그대로', () => {
    expect(quoteForCmd('npx')).toBe('npx');
    expect(quoteForCmd('-y')).toBe('-y');
    expect(quoteForCmd('@modelcontextprotocol/server-filesystem')).toBe('@modelcontextprotocol/server-filesystem');
    expect(quoteForCmd('C:/workflow/flowforge/examples/sample-mcp-server.mjs')).toBe('C:/workflow/flowforge/examples/sample-mcp-server.mjs');
    expect(quoteForCmd('C:\\data')).toBe('C:\\data');
  });

  it('공백·특수문자가 있으면 따옴표로 감싼다', () => {
    expect(quoteForCmd('C:/My Data')).toBe('"C:/My Data"');
    expect(quoteForCmd('a&b')).toBe('"a&b"');
    expect(quoteForCmd('--props={"a":1}')).toBe('"--props={\\"a\\":1}"');
    expect(quoteForCmd('')).toBe('""');
  });

  it('안쪽 따옴표는 이스케이프', () => {
    expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe('buildCommandLine', () => {
  it('명령과 인자를 한 줄로', () => {
    expect(buildCommandLine('npx', ['-y', '@modelcontextprotocol/server-filesystem', 'C:/My Data']))
      .toBe('npx -y @modelcontextprotocol/server-filesystem "C:/My Data"');
    expect(buildCommandLine('node', [])).toBe('node');
  });
});

describe('needsShell — .cmd/.bat 래퍼만 셸이 필요하다', () => {
  // 가짜 PATH: C:\node 에 npx.cmd 와 node.exe, C:\tools 에 ffmpeg.exe, C:\dup 에 foo.exe 와 foo.cmd
  const files = new Set([
    'C:\\node\\npx.cmd', 'C:\\node\\node.exe',
    'C:\\tools\\ffmpeg.exe', 'C:\\tools\\ffprobe.exe',
    'C:\\dup\\foo.exe', 'C:\\dup\\foo.cmd',
    'C:\\first\\bar.cmd', 'C:\\second\\bar.exe',
  ]);
  const win = { platform: 'win32', env: { PATH: 'C:\\node;C:\\tools;C:\\dup;C:\\first;C:\\second' }, exists: (p) => files.has(p) };

  it('npx 는 .cmd 래퍼라 셸 필요, ffmpeg·node 는 실행 파일이라 불필요', () => {
    expect(needsShell('npx', win)).toBe(true);
    expect(needsShell('ffmpeg', win)).toBe(false);
    expect(needsShell('node', win)).toBe(false);
  });

  it('같은 폴더에 둘 다 있으면 Windows 처럼 .exe 가 이긴다', () => {
    expect(needsShell('foo', win)).toBe(false);
  });

  it('PATH 순서대로 먼저 나오는 폴더가 이긴다', () => {
    expect(needsShell('bar', win)).toBe(true); // C:\first\bar.cmd 가 C:\second\bar.exe 보다 앞
  });

  it('확장자나 경로가 명시되면 PATH 를 보지 않는다', () => {
    expect(needsShell('C:\\node\\npx.cmd', win)).toBe(true);
    expect(needsShell('C:\\tools\\ffmpeg.exe', win)).toBe(false);
    expect(needsShell('C:\\somewhere\\tool', win)).toBe(false);
  });

  it('PATH 어디에도 없으면 셸 없이 (spawn 이 ENOENT 를 낸다)', () => {
    expect(needsShell('nope', win)).toBe(false);
  });

  it('Windows 가 아니면 항상 false', () => {
    expect(needsShell('npx', { ...win, platform: 'linux' })).toBe(false);
  });
});

describe('runCommand — 실제 프로세스', () => {
  it('node 를 셸 없이 띄우고 stdout 을 돌려준다 (공백 있는 인자도 그대로)', async () => {
    const out = await runCommand(process.execPath, ['-e', 'console.log(process.argv[1])', 'hello world'], {});
    expect(out.trim()).toBe('hello world');
  });

  it('종료코드가 0 이 아니면 stderr 를 담아 거부한다', async () => {
    await expect(runCommand(process.execPath, ['-e', 'console.error("bad"); process.exit(3)'], {})).rejects.toThrow(/종료코드 3: bad/);
  });

  it('없는 명령은 스폰 실패로 거부한다', async () => {
    await expect(runCommand('definitely-not-a-command-xyz', [], {})).rejects.toThrow(/스폰 실패/);
  });
});

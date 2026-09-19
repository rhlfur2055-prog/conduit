import { describe, it, expect } from 'vitest';
import { quoteForCmd, buildCommandLine } from '../../server/mcp.js';

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

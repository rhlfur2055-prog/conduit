#!/usr/bin/env node
// ============================================================
// 최소 MCP 서버 예제 — stdio 전송, 도구 2개(echo, add)
// Conduit 의 MCP 클라이언트 테스트/데모 용.
// 등록: 자격 증명 → MCP 서버 → command: node, args: <이 파일 경로>
// ============================================================
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

const TOOLS = [
  {
    name: 'echo',
    description: '입력 문자열을 그대로 돌려준다',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: '두 숫자를 더한다',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
];

rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }

  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'conduit-sample', version: '1.0.0' },
    } });
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  } else if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params || {};
    let text;
    if (name === 'echo') text = String(a.text ?? '');
    else if (name === 'add') text = String(Number(a.a) + Number(a.b));
    else return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: '알 수 없는 도구: ' + name } });
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], isError: false } });
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: '미지원 메서드' } });
  }
});

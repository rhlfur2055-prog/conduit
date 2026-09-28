// 엔드투엔드: 실제 Conduit 서버를 임시 포트에 띄우고, 이 패키지를 자식 프로세스로 실행한 뒤
// MCP 클라이언트(SDK)로 stdio 를 통해 tools/list · tools/call 을 검증한다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'conduit-workflows-mcp.js');
const KEY = 'bridge-test-key';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-mcp-test-'));
process.env.CONDUIT_DATA_DIR = dataDir;
process.env.CONDUIT_API_KEY = KEY;
const { app } = await import('../../../server/index.js');

let server;
let base;
let workflowId;

/** 이 패키지를 자식 프로세스로 띄우고 MCP 클라이언트로 연결한다 */
async function connectBridge(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...getDefaultEnvironment(), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // 테스트용 워크플로: 주문 배열 → 금액 > 30000 만 출력
  const res = await fetch(base + '/api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      name: 'MCP 브리지 테스트',
      nodes: [
        { id: 't', data: { kind: 'manualTrigger', params: { json: '[]' } } },
        { id: 'if', data: { kind: 'ifNode', params: { field: 'amount', op: '>', value: '30000' } } },
        { id: 'out', data: { kind: 'output', params: {} } },
      ],
      edges: [{ id: 'e1', source: 't', target: 'if' }, { id: 'e2', source: 'if', target: 'out', sourceHandle: 'true' }],
    }),
  });
  workflowId = (await res.json()).id;
}, 20000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 윈도우: 아직 잡힌 DB 핸들 */ }
});

describe('stdio 브리지 ↔ 실제 Conduit 서버', () => {
  it('tools/list 에 Conduit 워크플로가 도구로 나타난다', async () => {
    const client = await connectBridge({ CONDUIT_URL: base, CONDUIT_API_KEY: KEY });
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === `run_${workflowId}`);
      expect(tool).toBeTruthy();
      expect(tool.description).toContain('MCP 브리지 테스트');
      expect(tool.inputSchema.properties.input).toBeTruthy();
    } finally {
      await client.close();
    }
  }, 20000);

  it('tools/call 로 워크플로를 실행하고 출력 노드 결과를 받는다', async () => {
    const client = await connectBridge({ CONDUIT_URL: base, CONDUIT_API_KEY: KEY });
    try {
      const r = await client.callTool({
        name: `run_${workflowId}`,
        arguments: { input: [{ amount: 99000 }, { amount: 100 }] },
      });
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.content[0].text)).toEqual({ amount: 99000 });
    } finally {
      await client.close();
    }
  }, 20000);

  it('없는 도구는 isError 결과로 돌아온다 (프로세스는 살아 있다)', async () => {
    const client = await connectBridge({ CONDUIT_URL: base, CONDUIT_API_KEY: KEY });
    try {
      const r = await client.callTool({ name: 'run_nope', arguments: {} });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/run_nope/);
      // 그 뒤에도 정상 요청이 된다
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 20000);

  it('키가 틀리면 tools/list 가 CONDUIT_API_KEY 안내와 함께 실패한다', async () => {
    const client = await connectBridge({ CONDUIT_URL: base, CONDUIT_API_KEY: 'wrong' });
    try {
      await expect(client.listTools()).rejects.toThrow(/CONDUIT_API_KEY/);
    } finally {
      await client.close();
    }
  }, 20000);

  it('Conduit 이 꺼져 있으면 연결 불가 메시지로 실패한다', async () => {
    const client = await connectBridge({ CONDUIT_URL: 'http://127.0.0.1:1', CONDUIT_API_KEY: KEY });
    try {
      await expect(client.listTools()).rejects.toThrow(/연결할 수 없습니다/);
    } finally {
      await client.close();
    }
  }, 20000);
});

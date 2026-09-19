// ============================================================
// MCP 클라이언트 — stdio 전송(JSON-RPC 2.0, 개행 구분)
// MCP 서버는 크리덴셜(type='mcp')에 등록: { command, args }
//   예) command: "npx", args: "-y @modelcontextprotocol/server-filesystem C:/data"
// 프로세스는 이름별로 1개만 띄우고 재사용한다.
// ============================================================
import { spawnCommand } from './spawn.js';
import { Credentials } from './store.js';

const clients = new Map(); // name -> client | Promise<client>

function getConfig(name) {
  const list = Credentials.all().filter((c) => c.type === 'mcp');
  const c = name ? list.find((x) => x.name === name) : list[0];
  if (!c) return null;
  try {
    return { name: c.name, ...Credentials.reveal(c.id) };
  } catch {
    return null;
  }
}

const send = (client, msg) => client.proc.stdin.write(JSON.stringify(msg) + '\n');

function request(client, method, params, timeoutMs = 20000) {
  const id = client.nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`MCP ${method} 응답 시간 초과`));
    }, timeoutMs);
    client.pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    send(client, { jsonrpc: '2.0', id, method, params });
  });
}

async function connect(cfg) {
  const args = typeof cfg.args === 'string'
    ? cfg.args.split(/\s+/).filter(Boolean)
    : (cfg.args || []);
  const proc = spawnCommand(cfg.command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const client = { proc, pending: new Map(), nextId: 1, buffer: '' };

  proc.stdout.on('data', (d) => {
    client.buffer += d.toString();
    let idx;
    while ((idx = client.buffer.indexOf('\n')) >= 0) {
      const line = client.buffer.slice(0, idx).trim();
      client.buffer = client.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && client.pending.has(msg.id)) {
          const p = client.pending.get(msg.id);
          client.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'MCP 오류'));
          else p.resolve(msg.result);
        }
      } catch { /* 서버의 비-JSON 출력 무시 */ }
    }
  });
  proc.stderr.on('data', () => { /* 로그 소음 무시 */ });
  proc.on('exit', () => {
    for (const [, p] of client.pending) p.reject(new Error('MCP 프로세스가 종료됐습니다'));
    client.pending.clear();
    clients.delete(cfg.name);
  });

  await request(client, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'conduit', version: '1.0.0' },
  });
  send(client, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return client;
}

async function getClient(name) {
  const cfg = getConfig(name);
  if (!cfg?.command) return null;
  if (!clients.has(cfg.name)) {
    const p = connect(cfg).catch((e) => { clients.delete(cfg.name); throw e; });
    clients.set(cfg.name, p);
  }
  return clients.get(cfg.name);
}

export async function mcpListTools(credentialName) {
  const client = await getClient(credentialName);
  if (!client) return { simulated: true, note: 'MCP 크리덴셜(type=mcp, command/args) 없음' };
  const r = await request(client, 'tools/list', {});
  return {
    ok: true,
    tools: (r.tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
  };
}

export async function mcpCallTool(credentialName, tool, args) {
  const client = await getClient(credentialName);
  if (!client) return { simulated: true, note: 'MCP 크리덴셜(type=mcp, command/args) 없음' };
  const r = await request(client, 'tools/call', { name: tool, arguments: args || {} });
  const text = (r.content || [])
    .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
    .join('\n');
  return { ok: !r.isError, tool, result: text };
}

#!/usr/bin/env node
// stdio MCP 서버 진입점.
//   CONDUIT_URL      Conduit 서버 주소 (기본 http://localhost:8787)
//   CONDUIT_API_KEY  서버에 키가 설정돼 있으면 같은 값
// stdout 은 MCP 프로토콜 채널이므로 사람용 로그는 전부 stderr 로 쓴다.
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createConduitClient } from '../src/conduit.js';
import { createServer } from '../src/server.js';

const { name, version } = createRequire(import.meta.url)('../package.json');
const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(version);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`${name} ${version}
Conduit 워크플로를 MCP 도구로 노출하는 stdio 서버.

환경변수
  CONDUIT_URL      Conduit 서버 주소 (기본 http://localhost:8787)
  CONDUIT_API_KEY  서버의 CONDUIT_API_KEY 와 같은 값 (서버에 키가 설정된 경우)

Claude Desktop (claude_desktop_config.json)
  { "mcpServers": { "conduit": { "command": "npx", "args": ["-y", "${name}"],
      "env": { "CONDUIT_URL": "http://localhost:8787" } } } }

Claude Code
  claude mcp add conduit -e CONDUIT_URL=http://localhost:8787 -- npx -y ${name}
`);
  process.exit(0);
}

const url = process.env.CONDUIT_URL || 'http://localhost:8787';
const apiKey = process.env.CONDUIT_API_KEY || '';
const conduit = createConduitClient({ url, apiKey });
const log = (...a) => console.error(`[${name}]`, ...a);

log(`Conduit ${conduit.base}${apiKey ? ' · API 키 사용' : ''}`);
// 시작 시 한 번 확인만 하고 실패해도 계속 뜬다 — 클라이언트가 tools/list 를 부를 때 자세한 오류를 받는다
conduit.health()
  .then((h) => {
    log(`연결됨 · 인증 ${h.auth === 'api-key' ? 'API 키 필요' : '로컬 전용'} · 코드 실행 ${h.code === 'on' ? '켜짐' : '꺼짐'}`);
    if (h.auth === 'api-key' && !apiKey) log('경고: 서버가 API 키를 요구하는데 CONDUIT_API_KEY 가 비어 있습니다.');
  })
  .catch((e) => log('경고:', e.message));

const server = createServer(conduit, { name, version });
await server.connect(new StdioServerTransport());

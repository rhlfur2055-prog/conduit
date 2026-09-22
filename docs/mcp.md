# MCP 지원 (양방향)

Conduit 워크플로를 Claude 의 도구로 노출하고, 반대로 외부 MCP 도구를 노드에서 부른다.

## MCP 지원 (양방향)

Conduit는 **MCP(Model Context Protocol)** 를 양쪽 방향으로 지원합니다.

### 1) Conduit → MCP 서버 사용 (클라이언트)

외부 MCP 서버(stdio)의 도구를 워크플로/에이전트에서 호출합니다.

- **등록**: 자격 증명 → `MCP 서버 (stdio)` → `command`(예: `npx` 또는 `node`) + `args`
  - 예: `npx` / `-y @modelcontextprotocol/server-filesystem C:/data`
  - 데모: `node` / `C:/workflow/flowforge/examples/sample-mcp-server.mjs` (echo·add 도구 포함)
- **MCP 도구 호출 노드** (연동 카테고리): 도구 이름 비우면 목록 조회, 지정하면 호출. 인자는 JSON + 표현식 지원.
- **에이전트 도구**: `mcp_list_tools` · `mcp_call` — 에이전트가 스스로 MCP 도구를 탐색·호출.
- 프로세스는 서버 이름별 1개를 띄워 재사용하고, initialize 핸드셰이크 후 `tools/list`·`tools/call` JSON-RPC 로 통신.

검증됨: 샘플 서버 접속 → 도구 목록(echo·add) → 표현식 인자로 `add(2,3)` 호출 → `"5"` ✅

### 2) Claude → Conduit 사용 (서버)

Conduit 자체가 MCP 서버가 되어, **저장된 워크플로가 MCP 도구(`run_<id>`)로 노출**됩니다.

```bash
claude mcp add --transport http conduit http://localhost:8787/mcp
# CONDUIT_API_KEY 를 설정했다면 헤더를 함께
claude mcp add --transport http conduit http://localhost:8787/mcp --header "Authorization: Bearer <키>"
```

**stdio 로만 MCP 서버를 붙일 수 있는 클라이언트**(Claude Desktop 설정 파일, Cursor 등)에는 패키지 [`conduit-workflows-mcp`](../packages/conduit-workflows-mcp) 를 씁니다. Conduit 의 `/mcp` 앞에 붙는 얇은 stdio 다리이고, 도구 정의는 Conduit 한 곳에만 있습니다.

> **아직 npm 에 게시하지 않았습니다.** 게시 전에는 아래 예시의 `npx -y conduit-workflows-mcp` 자리에
> `node <이 저장소 경로>/packages/conduit-workflows-mcp/bin/conduit-workflows-mcp.js` 를 씁니다 (먼저 그 폴더에서 `npm install`).

```json
{ "mcpServers": { "conduit": {
    "command": "npx", "args": ["-y", "conduit-workflows-mcp"],
    "env": { "CONDUIT_URL": "http://localhost:8787", "CONDUIT_API_KEY": "<키를 설정한 경우>" } } } }
```

```bash
claude mcp add conduit -e CONDUIT_URL=http://localhost:8787 -- npx -y conduit-workflows-mcp
```

이후 Claude Code/Desktop 에서 "conduit의 run_… 도구로 ○○ 워크플로 실행해줘"라고 하면
Claude 가 `tools/call` 로 워크플로를 실행하고 출력 노드 결과를 돌려받습니다.

검증됨: `initialize` → `tools/list`(워크플로 3개 노출) → `tools/call(input={amount:7777})` → `{"amount":7777,"ok":true}` ✅

# conduit-workflows-mcp

[Conduit](https://github.com/rhlfur2055-prog/conduit)에 저장한 워크플로를 **MCP 도구**로 노출하는 stdio 서버입니다. Claude Desktop·Claude Code·Cursor 등 MCP 클라이언트에서 "주문 분류 워크플로 돌려줘"라고 말하면, 클라이언트가 이 서버를 거쳐 Conduit 의 워크플로를 실행하고 출력 노드 결과를 받아옵니다.

```
Claude Desktop ──stdio──▶ conduit-workflows-mcp ──HTTP──▶ Conduit 서버 (/mcp)
```

Conduit 서버에는 이미 HTTP MCP 엔드포인트(`/mcp`)가 있습니다. 이 패키지는 그 앞에 붙는 얇은 다리로, **stdio 로만 MCP 서버를 붙일 수 있는 클라이언트**(Claude Desktop 설정 파일 등)에서 Conduit 을 쓰게 해 줍니다. 도구 정의는 Conduit 한 곳에만 있고, 이 서버는 `tools/list`·`tools/call` 을 그대로 전달합니다.

> **아직 npm 에 게시하지 않았습니다.** 게시 전에는 아래의 `npx -y conduit-workflows-mcp` 자리에
> `node <저장소 경로>/packages/conduit-workflows-mcp/bin/conduit-workflows-mcp.js` 를 씁니다 (이 폴더에서 `npm install` 먼저).

## 설치 없이 바로

Conduit 서버가 `http://localhost:8787` 에 떠 있다면:

```bash
npx -y conduit-workflows-mcp
```

## 클라이언트 설정

**Claude Desktop** — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "conduit": {
      "command": "npx",
      "args": ["-y", "conduit-workflows-mcp"],
      "env": {
        "CONDUIT_URL": "http://localhost:8787",
        "CONDUIT_API_KEY": "서버의 CONDUIT_API_KEY 와 같은 값 (키를 설정한 경우)"
      }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add conduit -e CONDUIT_URL=http://localhost:8787 -- npx -y conduit-workflows-mcp
```

**Cursor / 그 밖의 MCP 클라이언트** — `command: npx`, `args: ["-y", "conduit-workflows-mcp"]`, 환경변수는 위와 같습니다.

## 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `CONDUIT_URL` | `http://localhost:8787` | Conduit 서버 주소 |
| `CONDUIT_API_KEY` | (없음) | Conduit 서버에 `CONDUIT_API_KEY` 가 설정돼 있으면 같은 값. 키 없는 로컬 서버에는 필요 없음 |

## 동작

- `tools/list` — 요청마다 Conduit 에서 새로 가져옵니다. Conduit 에 워크플로를 저장하면 **재시작 없이** 다음 목록에 바로 나타납니다. 도구 이름은 `run_<워크플로 id>`, 설명에 워크플로 이름과 노드 수가 들어갑니다.
- `tools/call` — `input` 인자를 워크플로의 트리거 노드에 주입해 실행하고, 출력 노드의 결과를 텍스트(JSON)로 돌려줍니다. 워크플로 안에서 노드가 실패하면 `isError: true` 로 표시됩니다.
- 연결이 안 되거나 인증이 틀리면 **원인과 고칠 방법이 담긴 메시지**가 클라이언트에 그대로 전달됩니다 (예: "CONDUIT_API_KEY 를 서버의 키와 같은 값으로 설정하세요").
- 사람용 로그는 전부 stderr 로 씁니다. stdout 은 MCP 프로토콜 채널이라 건드리지 않습니다.

## 직접 확인해 보기

```bash
npx -y conduit-workflows-mcp --help
```

저장소를 받아서 테스트를 돌리면, 실제 Conduit 서버를 임시 포트에 띄우고 이 패키지를 자식 프로세스로 실행해 MCP 클라이언트로 `tools/list`·`tools/call` 을 검증합니다 (`packages/conduit-workflows-mcp/test/`).

## 라이선스

MIT

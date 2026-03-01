[← Documentation Index](./index.md)

# tool-kit — Project Specification

## 1. Overview

**tool-kit** is a TypeScript CLI AI agent with two distinct operating modes:

| Mode | Description |
|------|-------------|
| **Interactive** | Lightweight developer terminal — REPL session, one-shot queries, file editing, git ops |
| **One-shot** | Single query with streaming response, exits on completion — useful for scripted use in CI/CD |

The project also serves as the **monorepo home for all MCP tool servers**. The MCP servers live in `mcp/` alongside the CLI and backend, making the workspace fully self-contained.

The project ships two independently deployable artifacts:

| Artifact | Description |
|----------|-------------|
| `dist/server.js` | Express backend — owns the LiteLLM connection, MCP server lifecycle, and streaming API |
| `dist/cli.js` | Thin CLI client — HTTP streaming, session persistence, terminal UI |

---

## 2. Design Goals & Principles

### Composability
The server exposes a clean HTTP streaming API (`POST /api/chat/stream`). The CLI is one client; a future web UI, a CI/CD webhook handler, or a monitoring daemon are equally valid clients. No component assumes it is the only consumer.

### Separation of Concerns

```
Transport (CLI)  ─────────────────────────────────────────────────
    knows: server URL, session state, terminal rendering
    does not know: LiteLLM, MCP, tool routing

AI + Tool Orchestration (Server) ────────────────────────────────
    knows: LiteLLM, MCP protocol, tool-call loop
    does not know: who called it or how output is displayed

Tool Execution (MCP Servers) ─────────────────────────────────────
    knows: their own domain (bash, git, file editing)
    does not know: the AI model or the CLI
```

### Portability
All MCP server paths are configured via `config/mcp-servers.json` and resolved from environment variables. No paths are hardcoded in source. The same image runs in dev, staging, and production with different configs.

### Lightweight
No long-running MCP daemons. Each tool call spawns a fresh process, communicates over stdio, and is killed on response. Server startup is fast; container boot-to-ready is measured in seconds.

---

## 3. Use Cases

### 3.1 Development Assistant (Interactive Terminal)
```bash
tool-kit                            # interactive REPL
tool-kit "what tests are failing?"  # one-shot query
```
Human-in-the-loop session. Context persists across the working day. Rich terminal output with tool call display.

### 3.2 CI/CD Integration (One-Shot)
```bash
tool-kit "review the diff in PR #42 and summarise security concerns"
```
Exits cleanly with output streamed to stdout. Suitable for CI pipelines.

### 3.3 Docker Containerised Worker
Run the server in a container; call it from any HTTP client (another service, a webhook, a future web UI).

```bash
docker run -p 3333:3333 \
  -e OPENAI_API_KEY=... \
  -e OPENAI_BASE_URL=... \
  -e API_TOKEN=... \
  tool-kit-server
```

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  src/cli/                                                        │
│                                                                  │
│  Interactive:  tool-kit            — REPL                       │
│  One-shot:     tool-kit "query"    — stream + exit              │
│                                                                  │
│    cli.ts      — commander entry point                          │
│    client.ts   — HTTP POST, axios stream parsing                │
│    display.ts  — chalk/ora terminal rendering                   │
│    session.ts  — ~/.tool-kit-sessions/ JSON persistence         │
└───────────────────────────┬─────────────────────────────────────┘
                            │ POST /api/chat/stream
                            │ Bearer {API_TOKEN}
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  src/server/                                                     │
│                                                                  │
│    server.ts      — Express app, /api/chat/stream + /health     │
│    ai.service.ts  — OpenAI SDK → LiteLLM, tool-call loop       │
│    mcp.service.ts — JSON-RPC 2.0 over stdio, tool routing      │
│    config.ts      — env vars, mcp-servers.json loader          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ OpenAI-compatible streaming API
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  LiteLLM Proxy  (OPENAI_BASE_URL)                               │
│  Default model: anthropic.claude-4.5-sonnet                     │
└─────────────────────────────────────────────────────────────────┘
                            │ stdio — child_process.spawn per call
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  mcp/  (co-located in this workspace)                           │
│    bash-server/           — shell command execution             │
│    octokit-mcp-server/    — GitHub SDK (PRs, issues, repos)    │
│    file-editor-mcp-server/ — diff / apply / rollback / search  │
│    + additional servers from ssit/mcp                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Repository Structure (Monorepo)

```
tool-kit/
├── src/
│   ├── cli/
│   │   ├── cli.ts          # commander entry, mode dispatch
│   │   ├── client.ts       # HTTP POST, axios stream parsing
│   │   ├── display.ts      # chalk/ora terminal rendering
│   │   └── session.ts      # ~/.tool-kit-sessions/ JSON persistence
│   └── server/
│       ├── server.ts       # Express app bootstrap
│       ├── ai.service.ts   # LiteLLM integration, tool-call loop
│       ├── mcp.service.ts  # MCP stdio JSON-RPC client
│       └── config.ts       # env + mcp-servers.json
├── mcp/                    # MCP tool servers
│   ├── bash-server/
│   ├── octokit-mcp-server/
│   └── file-editor-mcp-server/
├── config/
│   └── mcp-servers.json    # MCP server paths — ${VAR} substitution
├── dist/                   # tsc output (CommonJS ES6)
├── docs/
│   ├── index.md
│   ├── ai-agent.md         # reference architecture (ssit-terminal-ai)
│   └── spec.md             # this document
├── Dockerfile
├── code.code-workspace
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

Each MCP server under `mcp/` is an independent Node project with its own `package.json`, `tsconfig.json`, and `build/` output. They are not bundled into the root `package.json`.

---

## 6. Key TypeScript Interfaces

### 6.1 Streaming Protocol

```typescript
// Newline-delimited JSON — server → client
type StreamChunk =
  | { type: 'content';     data: string }
  | { type: 'tool_call';   data: ToolCallChunk }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'complete';    data: null }
  | { type: 'error';       data: string }

interface ToolCallChunk {
  id: string;
  name: string;         // "{serverName}_{toolName}"
  arguments: Record<string, unknown>;
}

interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
}
```

### 6.2 API Request

```typescript
// POST /api/chat/stream
interface ChatRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  model?: string;        // default: "anthropic.claude-4.5-sonnet"
  temperature?: number;  // default: 0.7
  maxTokens?: number;    // default: 4096
}
```

### 6.3 Session

```typescript
interface Session {
  sessionId: string;             // uuid
  sessionKey: string;            // "{sha1(cwd)}_{YYYY-MM-DD}"
  workingDirectory: string;
  startedAt: string;             // ISO 8601
  lastActivity: string;          // ISO 8601
  messages: SessionMessage[];
  toolCalls: ToolCallRecord[];
  commandsExecuted: CommandRecord[];
  filesViewed: string[];
}

interface SessionMessage {
  timestamp: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ToolCallRecord {
  timestamp: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: string;
  resultLength: number;
}

interface CommandRecord {
  timestamp: string;
  command: string;
  exitCode: number;
  output: string;
  outputLength: number;
}
```

### 6.4 MCP Configuration

```typescript
interface McpServerConfig {
  command: string;
  args: string[];
  transport: 'stdio';
  cwd?: string;
  env?: Record<string, string>;
}

interface McpServersConfig {
  mcpServers: Record<string, McpServerConfig>;
}
```

---

## 7. Backend: `src/server/`

### 7.1 `server.ts` — Express App

Routes:
- `POST /api/chat/stream` — main AI streaming endpoint (auth required)
- `GET /health` — returns `{ status: 'ok', uptime: number }` (no auth, for Docker healthcheck)

Auth middleware: validates `Authorization: Bearer {API_TOKEN}` against `process.env.API_TOKEN`.

Response headers: `Content-Type: application/x-ndjson`, `Transfer-Encoding: chunked`.

### 7.2 `ai.service.ts` — LiteLLM Integration & Tool-Call Loop

```
Initialise:
  apiKey  = process.env.OPENAI_API_KEY
  baseURL = process.env.OPENAI_BASE_URL

streamChat(request, res):
  1. Load MCP tools via mcp.service.listAllTools()
  2. Call openai.chat.completions.create({ stream: true, tools, ...request })
  3. Accumulate delta chunks; emit { type: 'content', data } for text deltas
  4. On finish_reason === 'tool_calls':
       a. Emit { type: 'tool_call', data: toolCall } for each call
       b. Call mcp.service.callTool(name, args)
       c. Emit { type: 'tool_result', data: result }
       d. Append tool results to messages; go to step 2
  5. On finish_reason === 'stop': emit { type: 'complete', data: null }
  6. On error: emit { type: 'error', data: message }
```

**Loop ceiling:** 20 tool-call rounds max per request.

### 7.3 `mcp.service.ts` — MCP stdio Client

Spawn → write JSON-RPC to stdin → read response from stdout → kill.

```typescript
class McpService {
  // All tools across all configured servers, OpenAI-compatible format.
  // Tool names prefixed: "{serverName}_{toolName}"
  listAllTools(): Promise<OpenAI.ChatCompletionTool[]>

  // Route by splitting prefixed name on first "_"
  callTool(prefixedName: string, args: Record<string, unknown>): Promise<string>
}
```

Timeouts: `tools/list` → 5 s, `tools/call` → 30 s.

### 7.4 `config.ts`

Validates on startup — throws immediately if invalid. Performs `${VAR}` substitution in MCP server args/paths.

| Item | Source | Required |
|------|--------|----------|
| `OPENAI_API_KEY` | env | Yes |
| `OPENAI_BASE_URL` | env | Yes |
| `API_TOKEN` | env | Yes |
| `PORT` | env | No (default `3333`) |
| `MCP_CONFIG_PATH` | env | No (default `config/mcp-servers.json`) |
| MCP config file | `MCP_CONFIG_PATH` | Yes |

---

## 8. CLI: `src/cli/`

### 8.1 `cli.ts` — Entry Point

```
tool-kit [query]            # one-shot (stream response, then exit)
tool-kit                    # interactive REPL (no query arg)

Options:
  -s, --server <url>    Backend URL         (default: http://localhost:3333)
  -t, --token <token>   Bearer token        (default: $API_TOKEN)
  -m, --model <model>   LiteLLM model       (default: anthropic.claude-4.5-sonnet)
      --new-session     Force fresh session
  -V, --version
  -h, --help
```

Interactive REPL commands:

| Command | Description |
|---------|-------------|
| `.session` | Print session stats |
| `.clear` | Clear session messages |
| `.tools` | Show tool call history |
| `exit` / `quit` | Exit |

### 8.2 `client.ts` — HTTP Streaming Client

```typescript
interface StreamCallbacks {
  onContent(delta: string): void;
  onToolCall(chunk: ToolCallChunk): void;
  onToolResult(result: ToolResult): void;
  onComplete(): void;
  onError(message: string): void;
}

async function streamQuery(
  serverUrl: string,
  token: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  model: string,
  callbacks: StreamCallbacks
): Promise<void>
```

### 8.3 `display.ts` — Terminal Rendering

- `printContent(delta)` — inline text stream
- `printToolCall(chunk)` — bordered tool-call block
- `printError(message)` — red error

```
╭─ 🔧 Tool Call ─────────────────────────────────────────────────
│  bash_execute_command
│
│  Parameters:  { "command": "ls -la src/" }
│
│  ✅ Result:
│    total 24
│    drwxrwxr-x ...
╰────────────────────────────────────────────────────────────────
```

### 8.4 `session.ts` — Session Persistence

```
Storage: ~/.tool-kit-sessions/{sha1(cwd)}_{YYYY-MM-DD}.json
```

- Auto-load today's session for current directory on startup
- Auto-save after every response
- Delete sessions older than 7 days on startup
- Up to 50 messages forwarded to AI; full history written to file
- Command output truncated to 10 KB per entry

---

## 9. MCP Servers (Monorepo)

Each server in `mcp/` is independently buildable:

```bash
cd mcp/bash-server && npm install && npx tsc
cd mcp/octokit-mcp-server && npm install && npx tsc
cd mcp/file-editor-mcp-server && npm install && npx tsc
```

### Servers

| Server | Path | Purpose |
|--------|------|---------|
| `bash` | `mcp/bash-server/build/index.js` | Shell execution (replaces dedicated web-scraper — use `curl`) |
| `octokit` | `mcp/octokit-mcp-server/build/index.js` | GitHub SDK |
| `file-editor` | `mcp/file-editor-mcp-server/build/file-editor-mcp.js` | Intelligent file editing |

---

## 10. MCP Server Configuration

`config/mcp-servers.json` (path overridable via `MCP_CONFIG_PATH`):

```json
{
  "mcpServers": {
    "bash": {
      "command": "node",
      "args": ["${MCP_ROOT}/bash-server/build/index.js"],
      "transport": "stdio"
    },
    "octokit": {
      "command": "node",
      "args": ["${MCP_ROOT}/octokit-mcp-server/build/index.js"],
      "transport": "stdio"
    },
    "file-editor": {
      "command": "node",
      "args": ["${MCP_ROOT}/file-editor-mcp-server/build/index.js"],
      "transport": "stdio",
      "cwd": "${MCP_ROOT}/file-editor-mcp-server"
    }
  }
}
```

`MCP_ROOT` defaults to `<project-root>/mcp` in development. Override in Docker to point at the mounted path.

---

## 11. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | LiteLLM proxy API key |
| `OPENAI_BASE_URL` | Yes | — | LiteLLM proxy base URL |
| `API_TOKEN` | Yes | — | Bearer token for CLI → backend auth |
| `PORT` | No | `3333` | Backend listen port |
| `MCP_CONFIG_PATH` | No | `config/mcp-servers.json` | Path to MCP config file |
| `MCP_ROOT` | No | `<project-root>/mcp` | Base path for all MCP server binaries |

---

## 12. Dependencies

### Runtime (root package)

| Package | Purpose |
|---------|---------|
| `express` | Backend HTTP server |
| `openai` | LiteLLM proxy client (OpenAI-compatible SDK) |
| `commander` | CLI argument parsing |
| `axios` | HTTP streaming client |
| `chalk` | Coloured terminal output |
| `ora` | Loading spinner |
| `uuid` | Session ID generation |

### Dev (root package)

| Package | Purpose |
|---------|---------|
| `typescript` | Compiler |
| `@types/node` | Node type definitions |
| `@types/express` | Express type definitions |
| `@types/uuid` | uuid type definitions |
| `eslint` + `@typescript-eslint/*` | Linting |

MCP servers each manage their own dependencies independently.

---

## 13. Docker Deployment

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY dist/        ./dist/
COPY mcp/         ./mcp/
COPY config/      ./config/
COPY package.json ./
RUN npm install --omit=dev
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://localhost:3333/health || exit 1
EXPOSE 3333
CMD ["node", "dist/server.js"]
```

MCP server binaries are pre-built (`build/` directories committed or built in a multi-stage Dockerfile). `MCP_ROOT` defaults to `/app/mcp` inside the container.

---

## 14. Implementation Phases

### Phase 1 — MCP Servers (complete)
- `bash-server`, `octokit-mcp-server`, `file-editor-mcp-server` are in `mcp/`, built, and verified
- `code.code-workspace` references all three as workspace folders

### Phase 2 — Backend Core

1. Install runtime dependencies; remove `app.ts` placeholder
2. `src/server/config.ts` — env validation, `mcp-servers.json` loading with `${VAR}` substitution
3. `src/server/mcp.service.ts` — stdio JSON-RPC client (`listAllTools`, `callTool`)
4. `src/server/ai.service.ts` — LiteLLM streaming + tool-call loop
5. `src/server/server.ts` — Express app, `/api/chat/stream`, `/health`
6. Smoke-test: `curl` the stream endpoint with a bash tool call

### Phase 3 — CLI Core

1. `src/cli/session.ts` — load/save/cleanup
2. `src/cli/client.ts` — axios stream + chunk parser
3. `src/cli/display.ts` — chalk/ora rendering
4. `src/cli/cli.ts` — commander entry, one-shot + interactive modes
5. Context injection in system prompt (cwd, user, git status, session history)
6. Smoke-test: `npx ts-node src/cli/cli.ts "list files"`

### Phase 4 — Polish & Packaging

1. Interactive REPL session commands (`.session`, `.clear`, `.tools`)
2. `package.json` bin entries: `tool-kit` + `tool-kit-server`
3. `Dockerfile` + `.dockerignore`
4. `config/mcp-servers.json` with `${MCP_ROOT}` references

---

## 15. Non-Goals (initial implementation)

- HTTPS / TLS (run behind a reverse proxy or Docker network)
- Multi-user auth or RBAC
- Web UI (future client of the same server API)
- Persistent database (sessions are flat JSON files)
- Autonomous agent loop (future phase)

---

[← Documentation Index](./index.md)

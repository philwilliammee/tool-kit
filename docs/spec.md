[← Documentation](./README.md)

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
| `dist/server/server.js` | Express backend — owns the LiteLLM connection, MCP server lifecycle, and streaming API |
| `dist/cli/cli.js` | Thin CLI client — HTTP streaming, session persistence, terminal UI |

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
│  Model: $MODEL env var (default: anthropic.claude-4.5-sonnet)  │
└─────────────────────────────────────────────────────────────────┘
                            │ stdio — child_process.spawn per call
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  mcp/  (co-located in this workspace)                           │
│    bash-server/            — shell command execution            │
│    octokit-mcp-server/     — GitHub SDK (PRs, issues, repos)   │
│    file-editor-mcp-server/ — diff / apply / rollback / search  │
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
│   │   ├── session.ts      # ~/.tool-kit-sessions/ JSON persistence
│   │   ├── agents.ts       # AGENTS.md loader (user instructions)
│   │   └── skills.ts       # skill discovery, frontmatter parsing, rendering
│   └── server/
│       ├── server.ts       # Express app bootstrap
│       ├── ai.service.ts   # LiteLLM integration, tool-call loop + hooks
│       ├── mcp.service.ts  # MCP stdio JSON-RPC client
│       ├── hooks.service.ts # lifecycle hook execution (command + HTTP)
│       └── config.ts       # env + mcp-servers.json
├── .tool-kit/              # project-level extensibility config (optional, committable)
│   ├── AGENTS.md           # project standing instructions (injected into every system prompt)
│   ├── settings.json       # hook configuration
│   └── skills/<name>/      # project-scoped skills (SKILL.md + optional scripts)
├── mcp/                    # MCP tool servers
│   ├── bash-server/
│   ├── octokit-mcp-server/
│   └── file-editor-mcp-server/
├── config/
│   └── mcp-servers.json    # MCP server paths — ${VAR} substitution
├── dist/                   # tsc output (CommonJS ES6)
├── docs/
│   ├── README.md           # docs index
│   ├── spec.md             # this document
│   └── archive/            # historical reference docs
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
  model?: string;              // default: $MODEL env var, fallback "anthropic.claude-4.5-sonnet"
  temperature?: number;        // default: 0.7
  maxTokens?: number;          // default: 4096
  workingDirectory?: string;   // for hook context; defaults to process.cwd()
}
```

### 6.3 Session

```typescript
interface Session {
  sessionId: string;                // uuid
  sessionKey: string;               // "{sha1(cwd)}_{YYYY-MM-DD}"
  workingDirectory: string;
  startedAt: string;                // ISO 8601
  lastActivity: string;             // ISO 8601
  messages: SessionMessage[];
  toolCalls: ToolCallRecord[];
  filesViewed: string[];
  skillInjections: SkillInjection[]; // skills invoked this session
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

interface SkillInjection {
  name: string;
  content: string;    // fully rendered "[skill: name]\n..." block
  injectedAt: string; // ISO 8601
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
  1. Instantiate HooksService(workingDirectory)
  2. Load MCP tools via mcp.service.listAllTools()
  3. Fire UserPromptSubmit hook; if contextInjection → prepend system message
  4. Call openai.chat.completions.create({ stream: true, tools, ...request })
  5. Accumulate delta chunks; emit { type: 'content', data } for text deltas
  6. On finish_reason === 'tool_calls':
       a. Emit { type: 'tool_call', data: toolCall } for each call
       b. Fire PreToolUse hook (matcher on tool name)
          - If decision === 'block': content = '[blocked] reason', skip MCP call
          - If contextInjection: prepend system message
       c. Call mcp.service.callTool(name, args)
       d. Fire PostToolUse hook; if contextInjection → append to tool result
       e. On callTool error: fire PostToolUseFailure (async); content = 'Error: ...'
       f. Emit { type: 'tool_result', data: result }
       g. Append tool results to messages; go to step 4
  7. On finish_reason === 'stop': emit { type: 'complete', data: null }; fire Stop (async)
  8. On error: emit { type: 'error', data: message }
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
  -s, --server <url>    Backend URL         (default: $TOOL_KIT_SERVER or http://localhost:3333)
  -t, --token <token>   Bearer token        (default: $API_TOKEN)
  -m, --model <model>   LiteLLM model       (default: $MODEL or anthropic.claude-4.5-sonnet)
      --new-session     Force fresh session
  -V, --version
  -h, --help
```

Interactive REPL commands:

| Command | Description |
|---------|-------------|
| `.session` | Print session stats |
| `.clear` | Clear session messages and skill injections |
| `.tools` | Show tool call history |
| `.skills` | List discovered skills (name + description) |
| `.hooks` | Show active hook configuration |
| `/skill-name [args]` | Invoke a skill — renders and injects into context |
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

interface QueryOptions {
  serverUrl: string;
  token: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  model: string;
  callbacks: StreamCallbacks;
  workingDirectory?: string;  // forwarded to server for hook context
}

async function streamQuery(opts: QueryOptions): Promise<void>
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
      "transport": "stdio",
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "file-editor": {
      "command": "node",
      "args": ["${MCP_ROOT}/file-editor-mcp-server/build/file-editor-mcp.js"],
      "transport": "stdio",
      "cwd": "${MCP_ROOT}/file-editor-mcp-server",
      "env": { "WORKSPACE_ROOT": "${WORKSPACE_ROOT}" }
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
| `MODEL` | No | `anthropic.claude-4.5-sonnet` | LiteLLM model string |
| `API_TOKEN` | Yes | — | Bearer token for CLI → backend auth (any shared secret in dev) |
| `PORT` | No | `3333` | Backend listen port |
| `MCP_CONFIG_PATH` | No | `config/mcp-servers.json` | Path to MCP config file |
| `MCP_ROOT` | No | `<project-root>/mcp` | Base path for all MCP server binaries |
| `GITHUB_TOKEN` | No | — | GitHub PAT — passed to the octokit MCP server |
| `WORKSPACE_ROOT` | No | `$HOME` | Root path the file-editor MCP server can access |
| `TOOL_KIT_SERVER` | No | `http://localhost:3333` | CLI default backend URL (overrides built-in default; `--server` flag takes precedence) |

---

## 12. Dependencies

### Runtime (root package)

| Package | Purpose |
|---------|---------|
| `express` | Backend HTTP server |
| `openai` | LiteLLM proxy client (OpenAI-compatible SDK) |
| `commander` | CLI argument parsing |
| `axios` | HTTP streaming client + hook HTTP handler |
| `chalk` | Coloured terminal output |
| `ora` | Loading spinner |
| `uuid` | Session ID generation |
| `js-yaml` | SKILL.md frontmatter parsing |

### Dev (root package)

| Package | Purpose |
|---------|---------|
| `typescript` | Compiler |
| `@types/node` | Node type definitions |
| `@types/express` | Express type definitions |
| `@types/uuid` | uuid type definitions |
| `@types/js-yaml` | js-yaml type definitions |
| `eslint` + `@typescript-eslint/*` | Linting |

MCP servers each manage their own dependencies independently.

---

## 13. Docker Deployment

Multi-stage build — compiles TypeScript and all three MCP servers inside the builder stage, then copies only the compiled output and production `node_modules` into a lean final image:

```dockerfile
# Stage 1: Builder — install all deps and compile everything
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
# ... install + build each MCP server ...
COPY tsconfig.json ./src/ ./
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Final image
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache bash   # required by bash MCP server
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY config/ ./config/
# MCP servers: build output + production node_modules only
COPY --from=builder /app/mcp/*/build ./mcp/*/build
COPY --from=builder /app/mcp/*/node_modules ./mcp/*/node_modules
EXPOSE 3333
CMD ["node", "dist/server/server.js"]
```

`MCP_ROOT` defaults to `/app/mcp` inside the container. Env vars are injected at runtime via Docker `-e` or a secrets manager.

---

## 14. Implementation Status

All phases are complete. The project is built, tested, and running.

### Phase 1 — MCP Servers ✅
- `bash-server`, `octokit-mcp-server`, `file-editor-mcp-server` in `mcp/`, built, and verified
- `code.code-workspace` references all three as workspace folders

### Phase 2 — Backend Core ✅
- `src/server/config.ts` — env validation, `mcp-servers.json` loading with `${VAR}` substitution
- `src/server/mcp.service.ts` — stdio JSON-RPC client (`listAllTools`, `callTool`)
- `src/server/ai.service.ts` — LiteLLM streaming + tool-call loop (max 20 iterations)
- `src/server/server.ts` — Express app, `/api/chat/stream`, `/health`

### Phase 3 — CLI Core ✅
- `src/cli/session.ts` — load/save/cleanup (`~/.tool-kit-sessions/`)
- `src/cli/client.ts` — axios stream + NDJSON chunk parser
- `src/cli/display.ts` — chalk/ora rendering with bordered tool-call boxes
- `src/cli/cli.ts` — commander entry, one-shot + interactive REPL

### Phase 4 — Polish & Packaging ✅
- Interactive REPL using event-driven `readline.on('line')` pattern with keep-alive
- `package.json` bin entries: `tool-kit` + `tool-kit-server`
- Multi-stage `Dockerfile` + `.dockerignore`
- `config/mcp-servers.json` with `${MCP_ROOT}` references
- `MODEL` env var for configurable model with sonnet 4.5 fallback

### Phase 5 — Skills, Hooks & User Instructions ✅
- `src/cli/agents.ts` — loads `~/.tool-kit/AGENTS.md`, `.tool-kit/AGENTS.md`, `.tool-kit/AGENTS.local.md`; injected into every system prompt under `## User Instructions`
- `src/cli/skills.ts` — three-tier skill discovery; YAML frontmatter parsing; `` !`cmd` ``, `$ARGUMENTS`, `$N`, `${VAR}` substitution; `/skill-name` injection
- `src/server/hooks.service.ts` — merges three settings.json tiers; fires `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` events; command hooks (spawn + stdin/stdout JSON) and HTTP hooks (axios POST)
- `src/cli/cli.ts` updated — `/skill-name [args]`, `.skills`, `.hooks` REPL commands; skill injections persisted in session
- `src/server/ai.service.ts` updated — full hook wiring in agentic loop
- `.gitignore` updated — `.tool-kit/skills.local/`, `.tool-kit/settings.local.json`, `.tool-kit/AGENTS.local.md`

### Phase 6 — Skill Auto-Invocation, SessionStart Hook, `once` Flag, `--skill` Flag ✅

- `src/server/skills.service.ts` — new class-based server-side skill loading; mirrors CLI `skills.ts` but instantiated per request from `workingDirectory`
- `src/server/ai.service.ts` updated — `SkillsService` + `Skill` LLM function tool; LLM can auto-invoke skills; emits `skill_invoke` stream chunk; fires `SessionStart` hook on first query
- `src/server/hooks.service.ts` updated — `once` flag per handler (deduped within a request cycle); `registerSkillHooks()` activates skill-scoped frontmatter hooks on invocation
- `src/cli/client.ts` updated — `skill_invoke` stream chunk type; `isNewSession` + `sessionId` sent in every request; optional `onSkillInvoke` callback
- `src/cli/cli.ts` updated — `onSkillInvoke` callback persists auto-invoked skills to session; `isFirstQuery` tracking; `--skill <name>` flag pre-injects a skill in one-shot and interactive modes

---

## 15. Non-Goals (initial implementation)

- HTTPS / TLS (run behind a reverse proxy or Docker network)
- Multi-user auth or RBAC
- Web UI (future client of the same server API)
- Persistent database (sessions are flat JSON files)
- Autonomous agent loop (future phase)

---

[← Documentation](./README.md)

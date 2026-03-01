[← Documentation Index](./index.md)

# AI Agent — `ssit-terminal-ai` (`/bin/ai`)

## Overview

`/bin/ai` is the **SSIT Terminal AI Assistant**, a Node.js CLI tool installed globally as the npm package `ssit-terminal-ai` (v2.0.0). It provides an interactive, context-aware AI assistant directly in the terminal. The CLI connects to a backend Express server that proxies requests to an AI model through a **LiteLLM** proxy and executes tools via **MCP (Model Context Protocol)** servers over stdio.

---

## Package Details

| Property | Value |
|----------|-------|
| Package Name | `ssit-terminal-ai` |
| Version | `2.0.0` |
| Binary Name | `ai` |
| Binary Location | `/home/ds123/.nvm/versions/node/v22.17.0/bin/ai` |
| Package Root | `/home/ds123/.nvm/versions/node/v22.17.0/lib/node_modules/ssit-terminal-ai/` |
| Entry Point | `bin/ai.js` |
| License | MIT |

### Key Dependencies

| Package | Purpose |
|---------|---------|
| `commander` | CLI argument parsing |
| `axios` | HTTP streaming requests to backend |
| `chalk` | Colored terminal output |
| `ora` | Loading spinner |
| `readline` | Interactive mode REPL |

---

## Project Structure

```
ssit-terminal-ai/
├── bin/
│   └── ai.js                  # CLI entry point (commander)
├── lib/
│   ├── ai-terminal-client.js  # Main client: query processing, streaming
│   ├── session-manager.js     # Session persistence (~/.ssit-ai-sessions/)
│   ├── tool-display.js        # Rich terminal UI for tool call display
│   └── config.js              # Configuration defaults
├── package.json
├── README.md
├── USAGE.md
├── IMPLEMENTATION_SUMMARY.md
├── ROADMAP.md
└── TOOL_DISPLAY_FIXES.md
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     User Terminal                        │
│                                                          │
│  $ ai "what files are here?"                            │
│                                                          │
│  bin/ai.js (commander CLI)                              │
│       │                                                  │
│  lib/ai-terminal-client.js                              │
│    ├── session-manager.js  (~/.ssit-ai-sessions/)       │
│    └── tool-display.js     (rich terminal UI)           │
└────────────────────┬─────────────────────────────────────┘
                     │ HTTP POST /api/ai-chat/stream
                     │ Bearer token auth
                     ▼
┌──────────────────────────────────────────────────────────┐
│          SSIT Projects Task Manager Backend              │
│          (Express server, default: https://localhost:4201)│
│                                                          │
│  ai-chat.controller.ts                                  │
│       │                                                  │
│  ai-chat.service.ts   (AiChatService)                   │
│    ├── Uses OpenAI SDK with LiteLLM baseURL             │
│    ├── Streaming tool_call loop                         │
│    ├── MCPToolIntegrationService                        │
│    └── ToolHandlers (built-in fallback)                 │
└────────────────────┬─────────────────────────────────────┘
                     │ OpenAI-compatible API (streaming)
                     ▼
┌──────────────────────────────────────────────────────────┐
│                  LiteLLM Proxy                           │
│  OPENAI_BASE_URL (e.g. https://litellm.example.com)     │
│  Routes to: Claude, GPT-4o, etc.                        │
└──────────────────────────────────────────────────────────┘
```

### MCP Server Integration (from backend)

```
AiChatService
     │ tools/list (JSON-RPC 2.0 over stdio)
     ▼
MCPToolIntegrationService
     │ spawn child processes per-call
     ├── octokit          (GitHub SDK)
     ├── bash             (Shell execution)
     ├── sql-agent        (Natural language SQL)
     ├── task-runner      (npm audit automation)
     ├── task-scheduler   (Workflow management)
     ├── projects-db      (Project CRUD)
     ├── todo             (Todo management)
     ├── file-editor      (Intelligent file editing)
     ├── google-search    (Enterprise web search)
     ├── ldap-tool        (LDAP directory lookup)
     └── angular-cli      (Angular modernization)
```

---

## LiteLLM API Integration

The backend uses the **OpenAI Node.js SDK** configured to point at a LiteLLM proxy:

```typescript
// server/modules/ai-chat/ai-chat.service.ts
this.openai = new OpenAI({
  apiKey: config.liteLLMOpenAI.apiKey,   // OPENAI_API_KEY env var
  baseURL: config.liteLLMOpenAI.baseUrl, // OPENAI_BASE_URL env var
});
```

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | API key for LiteLLM proxy authentication | Yes |
| `OPENAI_BASE_URL` | LiteLLM proxy base URL | Yes |
| `AI_DEBUG_API_TOKEN` | Bearer token for CLI → backend auth | Yes |

### Supported Models (via LiteLLM routing)

| Model String | Provider |
|-------------|----------|
| `anthropic.claude-4.5-sonnet` | Anthropic (default) |
| `anthropic.claude-4-sonnet` | Anthropic |
| `openai.gpt-5-chat` | OpenAI |
| `openai.gpt-5` | OpenAI |
| `openai.gpt-4o` | OpenAI |

### Tool Calling Override

The backend supports a **model override** for tool calling:

```typescript
// In app.config.ts
aiToolCalling: {
  overrideEnabled: false,           // Set true to use separate model for tools
  overrideModel: 'openai.gpt-4o'   // Model used for tool calls when override is on
}
```

When enabled, the tool-calling model handles `tools/list` and `tools/call`, while the original (conversation) model analyzes tool results and generates the final response.

---

## MCP Server Protocol

### How MCP Servers Are Discovered and Called

The `MCPToolIntegrationService` communicates with MCP servers using **JSON-RPC 2.0 over stdio**. Each call spawns a fresh child process:

#### Tool Discovery (`tools/list`)

```json
// Request sent to child process stdin:
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }

// Response parsed from stdout:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "execute_command",
        "description": "Execute a bash command",
        "inputSchema": {
          "type": "object",
          "properties": { "command": { "type": "string" } },
          "required": ["command"]
        }
      }
    ]
  }
}
```

#### Tool Execution (`tools/call`)

```json
// Request sent to child process stdin:
{
  "jsonrpc": "2.0",
  "id": 847291,
  "method": "tools/call",
  "params": {
    "name": "execute_command",
    "arguments": { "command": "ls -la" }
  }
}

// Response parsed from stdout:
{
  "jsonrpc": "2.0",
  "id": 847291,
  "result": {
    "content": [{ "type": "text", "text": "total 8\ndrwxr-xr-x ..." }]
  }
}
```

### Tool Naming Convention

Tools exposed to the AI are prefixed with their server name:

```
{serverName}_{toolName}
```

Examples:
- `bash_execute_command`
- `file-editor_search_code_context`
- `octokit_create_pull_request`

The backend parses this to route to the correct MCP server:

```typescript
const parts = toolName.split('_');
const serverName = parts[0];           // "bash"
const actualToolName = parts.slice(1).join('_'); // "execute_command"
```

### MCP Server Configuration

Servers are configured in `config/mcp-servers.json` (relative to the backend's working directory):

```json
{
  "mcpServers": {
    "bash": {
      "command": "node",
      "args": ["/home/ds123/ssit/mcp/bash-server/build/index.js"],
      "transport": "stdio"
    },
    "file-editor": {
      "command": "node",
      "args": ["/home/ds123/ssit/ssit-projects-task-manager/dist/modules/mcp-servers/file-editor-mcp/file-editor-mcp.js"],
      "transport": "stdio",
      "cwd": "/home/ds123/ssit/ssit-projects-task-manager",
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

### Timeouts

| Operation | Timeout |
|-----------|---------|
| Tool discovery (`tools/list`) | 5 seconds |
| Tool execution (`tools/call`) | 30 seconds |

---

## Built-in Tool Set (Fallback)

If no MCP tools are available, the backend falls back to these built-in tools:

| Tool | Description |
|------|-------------|
| `get_projects` | List projects with pagination and search |
| `get_project_details` | Detailed info for a specific project |
| `get_tasks` | All tasks with type/workflow filter |
| `get_queue_status` | Project queue status and items |
| `get_security_vulnerabilities` | Security vulnerability data by severity |
| `get_system_stats` | Overall system metrics |

---

## MCP Servers Available

| Server | Transport | Description |
|--------|-----------|-------------|
| `octokit` | stdio | GitHub SDK operations (PRs, issues, repos) |
| `bash` | stdio | Shell command execution on the server host |
| `sql-agent` | stdio | Natural language → SQL query execution |
| `task-runner` | stdio | npm audit automation and log management |
| `task-scheduler` | stdio | Workflow task selection and progress tracking |
| `projects-db` | stdio | Database-backed project CRUD and queue mgmt |
| `todo` | stdio | Todo item management with priority/status |
| `file-editor` | stdio | Intelligent file editing with diff/backup/rollback |
| `google-search` | stdio | Enterprise web search and URL context analysis |
| `ldap-tool` | stdio | LDAP directory user search |
| `angular-cli` | stdio | Angular CLI modernization tools |
| `web-scrapper` | stdio | Web scraping / content extraction |

### File Editor MCP Tools (Detail)

The `file-editor` MCP server is built with `@modelcontextprotocol/sdk` and exposes:

| Tool | Description |
|------|-------------|
| `search_code_context` | Find functions, classes, or patterns in files |
| `generate_diff` | Generate minimal diff for a change |
| `apply_diff` | Apply a diff with automatic backup |
| `validate_change` | Validate syntax/linting/tests before applying |
| `batch_edit` | Make multiple coordinated edits atomically |
| `rollback` | Undo changes using automatic backups |

---

## Streaming Response Protocol

The CLI makes a single HTTP POST to `/api/ai-chat/stream` and receives a newline-delimited JSON stream. Each line is a `StreamChunk` object:

```typescript
{ type: 'content',    data: string }   // Text delta to display
{ type: 'tool_call',  data: ToolCallObject } // Tool being called
{ type: 'tool_result', data: any }     // Tool execution result
{ type: 'complete',   data: null }     // Stream ended normally
{ type: 'error',      data: string }   // Error message
```

### API Request Format

```typescript
POST /api/ai-chat/stream
Authorization: Bearer {AI_DEBUG_API_TOKEN}
Content-Type: application/json

{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "previous message" },
    { "role": "assistant", "content": "previous response" },
    { "role": "user",   "content": "current query" }
  ],
  "model": "anthropic.claude-4.5-sonnet",
  "temperature": 0.7,
  "max_tokens": 2000
}
```

---

## Session Management

Sessions persist conversation state automatically, keyed by `workingDirectory + date`:

### Storage Location

```
~/.ssit-ai-sessions/
  {hash}_{YYYY-MM-DD}.json
```

### Session File Schema

```json
{
  "sessionId": "uuid",
  "sessionKey": "hash_date",
  "workingDirectory": "/path/to/project",
  "startedAt": "2025-11-01T10:00:00Z",
  "lastActivity": "2025-11-01T10:15:00Z",
  "messages": [
    { "timestamp": "...", "role": "user|assistant", "content": "..." }
  ],
  "toolCalls": [
    { "timestamp": "...", "tool": "bash_execute_command",
      "arguments": {}, "result": "...", "resultLength": 1234 }
  ],
  "commandsExecuted": [
    { "timestamp": "...", "command": "npm install",
      "exitCode": 0, "output": "...", "outputLength": 1234 }
  ],
  "filesViewed": ["src/index.ts", "package.json"],
  "context": { "projectInfo": null, "gitStatus": null, "initialFileList": [] }
}
```

### Session Lifecycle

- **Auto-load**: On startup, loads today's session for current directory
- **Auto-save**: After every query response
- **Auto-cleanup**: Sessions older than 7 days are deleted on startup
- **Max size**: Command outputs truncated to 10KB; session files soft-capped at 10MB

---

## CLI Usage

### Command Line Options

```bash
ai [query] [options]

Options:
  -s, --server <url>     Backend server URL  (default: https://localhost:4201)
  -t, --token <token>    Bearer token         (default: $AI_DEBUG_API_TOKEN)
  -m, --model <model>    LiteLLM model string (default: anthropic.claude-4.5-sonnet)
  -c, --context <lines>  bash_history lines   (default: 10)
  --no-confirm           Skip command execution confirmation
  --no-history           Omit terminal history from context
  --new-session          Force a fresh session
  -V, --version          Show version (2.0.0)
  -h, --help             Show help
```

### Interactive Session Commands

| Command | Description |
|---------|-------------|
| `.session` | Show session stats (messages, tools, commands, files) |
| `.clear` | Clear current session messages |
| `.tools` | Display tool call history for this session |
| `.open <path>` | Open and display a file (tracks in session) |
| `exit` / `quit` | Exit the assistant |

### Configuration File

`~/.ssit-ai-config.json` (optional, overrides defaults):

```json
{
  "serverUrl": "https://localhost:4201",
  "model": "anthropic.claude-4.5-sonnet",
  "contextLines": 10,
  "includeHistory": true,
  "confirmExecution": true
}
```

---

## Context Sent to AI

Every query includes a rich system prompt with:

- Current working directory
- User and hostname
- Shell, platform, architecture
- Node.js version
- Session timestamp and timezone
- System memory (total/free)
- Session history summary (message count, tool calls, recent commands/files)
- Last 10 bash history lines (configurable)
- Last 10 conversation messages from session

---

## Tool Display Format

Tool calls are rendered in the terminal with rich borders:

```
╭─ 🔧 Tool Call ──────────────────────────────────────────
│
│ bash_execute_command
│
│ Parameters:
│ {
│   "command": "ls -la src/"
│ }
│
│ ✅ Result:
│   total 24
│   drwxrwxr-x 3 ds123 ds123 4096 ...
│
╰─────────────────────────────────────────────────────────
```

---

## Implementation Notes for This Workspace

### Integration Goal

The `tool-kit` project-code-workspace aims to implement the `/bin/ai` agent pattern: a CLI-accessible AI agent with a standard developer tool set (git SDK, file editor, bash) backed by LiteLLM and MCP servers.

### Key Design Principles from `/bin/ai`

1. **Stateless CLI, Stateful Sessions** — The CLI itself is lightweight; state lives in `~/.ssit-ai-sessions/` JSON files keyed by directory + date.

2. **Backend Handles AI + Tools** — The CLI is a thin HTTP client; the backend server owns the LiteLLM connection and MCP server lifecycle.

3. **MCP via stdio, On-Demand** — No long-running MCP server daemons. Each tool call spawns a fresh process, sends a JSON-RPC request, and kills the process on response.

4. **OpenAI SDK → LiteLLM** — Using the OpenAI SDK with `baseURL` override is the correct integration pattern. LiteLLM translates to any provider.

5. **Tool Name Namespacing** — Prefix all MCP tool names with `{serverName}_` to allow the backend to route without ambiguity.

6. **Streaming First** — Use newline-delimited JSON streaming (`responseType: 'stream'` with `axios`) for real-time response display.

7. **Graceful Fallback** — When MCP tools are unavailable, fall back to built-in tool handlers so the assistant remains functional.

### Minimum Required MCP Servers for Developer Workflow

For a standard development workspace the following MCP servers are the core tool set:

| Server | Purpose | Location |
|--------|---------|----------|
| `bash` | Execute shell commands | `/home/ds123/ssit/mcp/bash-server/build/index.js` |
| `octokit` | Git/GitHub SDK operations | `/home/ds123/ssit/mcp/octokit-mcp-server/build/index.js` |
| `file-editor` | Intelligent file editing | `/home/ds123/ssit/ssit-projects-task-manager/dist/modules/mcp-servers/file-editor-mcp/file-editor-mcp.js` |

These three form the core "developer agent" tool set referenced in the project goal.

---

## References

| Resource | Path |
|----------|------|
| CLI entry point | `/home/ds123/.nvm/versions/node/v22.17.0/lib/node_modules/ssit-terminal-ai/bin/ai.js` |
| Main client | `…/ssit-terminal-ai/lib/ai-terminal-client.js` |
| Session manager | `…/ssit-terminal-ai/lib/session-manager.js` |
| Backend AI service | `/home/ds123/ssit/ssit-projects-task-manager/server/modules/ai-chat/ai-chat.service.ts` |
| MCP integration | `…/ai-chat/mcp-tool-integration.service.ts` |
| MCP server config | `/home/ds123/ssit/ssit-projects-task-manager/config/mcp-servers.json` |
| MCP servers source | `…/ssit-projects-task-manager/server/modules/mcp-servers/` |
| File editor MCP | `…/mcp-servers/file-editor-mcp/file-editor-mcp.ts` |
| App config (LiteLLM) | `…/ssit-projects-task-manager/server/app.config.ts` |
| Tool handlers (built-in) | `…/ai-chat/tool-handlers.ts` |
| MCP servers README | `…/mcp-servers/README.md` |
| Package README | `…/ssit-terminal-ai/README.md` |
| Implementation summary | `…/ssit-terminal-ai/IMPLEMENTATION_SUMMARY.md` |

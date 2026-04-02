[← Documentation Index](./index.md)

# Phase 7 — Architecture Improvements

## Context

tool-kit currently has three significant performance/reliability problems that surface as sessions grow:
1. MCP servers are spawned and killed for every tool call — high latency, wasteful
2. Context management is a dumb 50-message slice — no token awareness, no graceful degradation
3. Large tool outputs are hard-truncated — the LLM silently loses data

Additionally, users asked for: sub-agent spawning, a richer message type system for smart compaction, file read deduplication, and improved REPL commands.

Branch: `architecture/phase7-improvements`

---

## Critical Files

| File | Role |
|------|------|
| `src/server/mcp.service.ts` | MCP lifecycle — rewrite to persistent connections |
| `src/server/ai.service.ts` | Core loop — integrate file cache, output store, built-in tools |
| `src/server/server.ts` | Make McpService a module singleton, add shutdown hook |
| `src/cli/session.ts` | Add message `type`, archive support |
| `src/cli/cli.ts` | New REPL commands, improved `/compact` |

New files:
- `src/server/mcp-connection.ts` — persistent stdio connection
- `src/server/tool-output-store.ts` — large result storage
- `src/server/file-cache.ts` — file read deduplication
- `src/server/built-in-tools.ts` — Agent sub-agent tool

---

## Implementation Plan

### Step 1: Persistent MCP Connections

**New file: `src/server/mcp-connection.ts`**

```ts
class McpConnection {
  private child: ChildProcess | null
  private buffer: string
  private pending: Map<number, { resolve, reject }>
  private nextId: number

  connect(): Promise<void>            // spawn, attach stdout handler
  send<T>(method, params): Promise<T> // assign id, write to stdin, register pending
  close(): void
  reconnect(): Promise<void>          // close + connect, re-register pending as errors
  get isAlive(): boolean
}
```

Stdout handler: split on `\n`, parse JSON, match `msg.id` to pending map, resolve/reject.

On process exit/crash: mark dead, reject all in-flight promises, auto-reconnect on next send.

**Refactor: `src/server/mcp.service.ts`**

```ts
class McpService {
  private connections: Map<serverName, McpConnection>
  private toolCache: OpenAI.ChatCompletionTool[] | null  // cache after first listAllTools

  async init(): Promise<void>                     // connect all servers in parallel
  async listAllTools(): Promise<...>              // return cached; rebuild if null
  async callTool(name, args): Promise<string>     // route to connection.send()
  async close(): Promise<void>                    // gracefully close all connections
}
```

**Modify: `src/server/server.ts`**

Move `McpService` to module-level singleton. Call `mcp.init()` on startup. Hook `process.on('SIGTERM')` / `SIGINT` to call `mcp.close()`.

```ts
const mcp = new McpService();
mcp.init().catch(err => console.error('[mcp] init failed:', err.message));
const ai = new AiService(mcp);   // inject mcp dependency
```

**Modify: `src/server/ai.service.ts`**

Accept `McpService` as constructor arg instead of creating its own.

---

### Step 2: Rich Message Types

**Modify: `src/cli/session.ts`**

Add `type` to `SessionMessage`:

```ts
type MessageType =
  | 'user'
  | 'assistant'
  | 'system'           // injected context (hooks, skills)
  | 'compact_summary'  // LLM-generated compaction summary
  | 'compact_boundary' // marker written before compaction

interface SessionMessage {
  timestamp: string
  role: 'user' | 'assistant' | 'system'
  type: MessageType
  content: string
}
```

`getApiMessages()` shape is unchanged (still returns `OpenAI.ChatCompletionMessageParam[]`). Internally, smart compaction can skip/collapse messages by type.

For backward compat, sessions without `type` default based on `role`.

---

### Step 3: File State Cache

**New file: `src/server/file-cache.ts`**

```ts
class FileStateCache {
  private cache: Map<string, { hash: string; mtime: number; lineCount: number; turn: number }>

  // Returns a stub string if file is cached and mtime unchanged; null otherwise.
  tryStub(filePath: string, currentTurn: number): string | null

  // Cache the result of a file read.
  set(filePath: string, content: string, turn: number): void

  // Extract file path from a tool call. Returns null if not a read operation.
  static extractPath(toolName: string, args: Record<string, unknown>): string | null
}
```

**Path extraction rules:**
- `file-editor_search_code_context`: `args.file_path`
- `bash_bash`: regex on `args.command` matching `cat <path>`, `head -n N <path>`, `tail ...`

**Stub check:** stat the file for mtime. If unchanged → return stub. Otherwise call through and update cache.

**Stub format:**
```
[File cached from turn N (M lines). Content unchanged since last read.
 Reference it directly or re-read to refresh.]
```

**In `AiService.streamChat()`:** before `mcp.callTool()` check `fileCache.tryStub()`. Skip the MCP call if stub returned. After a real call, `fileCache.set()`.

---

### Step 4: Large Tool Output Storage

**New file: `src/server/tool-output-store.ts`**

```ts
const INLINE_THRESHOLD = 8 * 1024  // 8 KB

class ToolOutputStore {
  // dir: ~/.tool-kit-sessions/tool-outputs/<sessionId>/
  constructor(sessionId: string)

  // Returns stub if content > threshold (writes file), otherwise null.
  maybeStore(toolName: string, content: string): string | null
}
```

**Stub format:**
```
[Large output stored at /path/to/file.txt (N lines, X KB).
 Read specific sections: lines 1-50 = summary; use bash with line ranges for details.]
```

File naming: `<toolName>-<uuid>.txt`

**In `AiService.streamChat()`:** after `mcp.callTool()` returns content, call `store.maybeStore()`. Use stub as content if non-null.

---

### Step 5: Conversation Archival & Improved `/compact`

**Modify: `src/cli/session.ts`**

Add `archivePath?: string` to `Session`. Add `archiveSession()`:

```ts
function archiveSession(session: Session): string {
  // Write messages as JSONL to ~/.tool-kit-sessions/<key>-archive-<ts>.jsonl
  // Each line: { turn: N, role, type, content, timestamp }
  // Returns the archive file path
}
```

**Modify: `src/cli/cli.ts` — `/compact` command**

Updated flow:
1. Archive messages to JSONL → get `archivePath`
2. Send compaction prompt to LLM — include archive path and instruction to embed line references:
   ```
   Summarize this conversation. The full transcript is archived at {archivePath}.
   Include line references for major sections: "Lines 1-N: [topic]"
   so context can be reloaded by reading specific line ranges from the archive.
   ```
3. Replace `session.messages` with a single `compact_summary` entry:
   ```ts
   { role: 'system', type: 'compact_summary',
     content: `[Compacted from N messages. Archive: ${archivePath}]\n\n${summary}` }
   ```
4. Set `session.archivePath = archivePath`

The AI reloads context by calling `bash_bash` with `sed -n 'X,Yp' <archivePath>`.

---

### Step 6: Sub-agent Built-in Tool

**New file: `src/server/built-in-tools.ts`**

```ts
export const AGENT_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'Agent',
    description: 'Run a sub-agent to handle a focused task. Returns the final answer ' +
      'after the agent completes all its tool calls. Use for parallelizable work or ' +
      'tasks that need isolated context.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the sub-agent' },
        model:  { type: 'string', description: 'Optional model override' }
      },
      required: ['prompt']
    }
  }
}
```

**In `AiService`:**

- Add `private depth: number` (default 0, max 2)
- When `tc.name === 'Agent'`: if depth >= 2 return error string; otherwise `new AiService(this.mcp, this.depth + 1)` and call `runToCompletion(prompt, model)`
- `runToCompletion(prompt, model): Promise<string>` — simplified loop, collects content into a string, returns final assistant message (no `res` streaming)

Sub-agents share the `McpService` singleton — no extra processes.

---

### Step 7: REPL Commands

**Modify: `src/cli/cli.ts`**

| Command | Action |
|---------|--------|
| `/compact` | Archive + summarize (improved above) |
| `/cost` | Print session token totals (prompt / completion / total) |
| `/model <name>` | Switch model for subsequent queries |
| `/memory` | Print AGENTS.md contents (project → global fallback) |
| `/history [n]` | Show last N conversation turns (default 10) |
| `/clear` | Reset messages + skill injections |
| `/session` | Print session stats |
| `/tools` | Fetch and list all available MCP tools from server |

Keep existing `.clear`, `.session`, `.tools` dot-aliases for backward compat.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/server/mcp-connection.ts` | **NEW** — McpConnection class |
| `src/server/tool-output-store.ts` | **NEW** — large output storage |
| `src/server/file-cache.ts` | **NEW** — file read dedup cache |
| `src/server/built-in-tools.ts` | **NEW** — Agent tool definition + runToCompletion |
| `src/server/mcp.service.ts` | **REWRITE** — persistent connection pool, cached tool list |
| `src/server/ai.service.ts` | **MODIFY** — inject McpService, file cache, output store, Agent tool, depth |
| `src/server/server.ts` | **MODIFY** — McpService singleton, init on start, shutdown hooks |
| `src/cli/session.ts` | **MODIFY** — MessageType, archiveSession(), archivePath on Session |
| `src/cli/cli.ts` | **MODIFY** — new /commands, improved /compact with archival |

---

## Out of Scope (Phase 7)

- Permission model changes
- Memory auto-extraction (agent manages AGENTS.md via existing bash/file-editor tools)
- SSE/WebSocket transports
- Ink/React terminal UI

---

## Verification

1. `npm run start` — confirm MCP servers connected at startup in logs
2. Multi-tool REPL session — `ps aux | grep node` shows no extra short-lived processes
3. `/compact` — JSONL archive written to `~/.tool-kit-sessions/`, summary has line refs
4. Large output (e.g., `cat` a big file) — stored to `~/.tool-kit-sessions/tool-outputs/`, stub in conversation
5. Read same file twice — second read returns `[File cached from turn N]` stub
6. `Agent` tool called — sub-agent runs silently, parent receives final answer as tool result
7. `/cost` — shows token breakdown
8. `/model claude-3-haiku` — next query uses new model

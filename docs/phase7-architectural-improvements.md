# Phase 7 — Architecture Improvements

## Context

tool-kit currently has three significant performance/reliability problems that surface as sessions grow:

1. MCP servers are spawned and killed for every tool call — high latency, wasteful
2. Context management is a dumb 50-message slice — no token awareness, no graceful degradation
3. Large tool outputs are hard-truncated — the LLM silently loses data

Additionally, users asked for: sub-agent spawning, a richer message type system for smart compaction, file read deduplication, and improved REPL commands.

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

  connect(): Promise<void>       // spawn, attach stdout handler, send init if needed
  send<T>(method, params): Promise<T>  // assign id, write to stdin, register pending
  close(): void
  reconnect(): Promise<void>     // close + connect, re-register pending as errors
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

  async init(): Promise<void>          // connect all servers in parallel
  async listAllTools(): Promise<...>   // return cached; rebuild if null
  async callTool(name, args): Promise<string>  // route to connection.send()
  async close(): Promise<void>         // gracefully close all connections
}
```

**Modify: `src/server/server.ts`**

Move `McpService` to module-level singleton. Call `mcp.init()` on startup. Hook `process.on('SIGTERM')` and `SIGINT` to call `mcp.close()`.

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
  | 'system'          // injected context (hooks, skills)
  | 'compact_summary' // LLM-generated compaction summary
  | 'compact_boundary' // marker written before compaction

interface SessionMessage {
  timestamp: string
  role: 'user' | 'assistant' | 'system'
  type: MessageType
  content: string
}
```

`getApiMessages()` already returns `OpenAI.ChatCompletionMessageParam[]` — no change to that shape. But internally, smart compaction can skip/collapse messages by type.

For backward compat, existing sessions without `type` default to `'user'` or `'assistant'` based on `role`.

---

### Step 3: File State Cache

**New file: `src/server/file-cache.ts`**

```ts
class FileStateCache {
  private cache: Map<string, { hash: string; lineCount: number; turn: number }>

  // Called before a tool call. Returns a stub string if file is cached and unchanged.
  // Returns null if not cached or file has changed (allow the real call through).
  tryStub(filePath: string, currentTurn: number): string | null

  // Called after a tool returns file content. Cache the result.
  set(filePath: string, content: string, turn: number): void

  // Extract file path from tool call args (null if not a file-read operation)
  static extractPath(toolName: string, args: Record<string, unknown>): string | null
}
```

**Path extraction rules:**

- `file-editor_search_code_context`: use `args.file_path`
- `bash_bash`: regex match on `args.command` — patterns like `cat <path>`, `head -n N <path>`, `tail ...`

**Stub check:** stat the file for current mtime. If mtime matches cached mtime → return stub. Otherwise call through and update cache.

**Stub string format:**

```
[File cached from turn N (M lines). Content unchanged since last read. Reference it or re-read to refresh.]
```

**In `AiService.streamChat()`:** before `mcp.callTool()`, call `fileCache.tryStub()`. If non-null, skip the MCP call and use the stub as content. After a real call, call `fileCache.set()`.

---

### Step 4: Large Tool Output Storage

**New file: `src/server/tool-output-store.ts`**

```ts
const INLINE_THRESHOLD = 8 * 1024  // 8 KB

class ToolOutputStore {
  private dir: string  // ~/.tool-kit-sessions/tool-outputs/<sessionId>/

  constructor(sessionId: string)

  // If content > threshold, write to file and return a stub.
  // Otherwise return null (pass content through unchanged).
  maybeStore(toolName: string, content: string): string | null
}
```

**Stub format:**

```
[Large output stored at /path/to/file.txt (N lines, X KB).
 Read specific sections: lines 1-50 = summary, use bash cat with line ranges for details.]
```

File naming: `<toolName>-<uuid>.txt`

**In `AiService.streamChat()`:** after getting `content` from `mcp.callTool()`, call `store.maybeStore()`. If non-null, use stub as content.

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

1. Archive current messages to JSONL → get `archivePath`
2. Count lines in archive file per major turn block
3. Send compaction prompt to LLM:

   ```
   Summarize this conversation. The full transcript is archived at {archivePath}.
   Include line references: "Lines 1-{N}: [topic]" for each major section,
   so context can be reloaded by reading specific line ranges.
   Conversation:
   {messageText}
   ```

4. Replace `session.messages` with a single `compact_summary` message:

   ```ts
   { role: 'system', type: 'compact_summary', content: `[Compacted from N messages. Archive: ${archivePath}]\n\n${summary}` }
   ```

5. Set `session.archivePath = archivePath`

The AI can then reload context by calling `bash_bash` with `sed -n 'X,Yp' <archivePath>` or the file-editor to view specific line ranges from the JSONL archive.

---

### Step 6: Sub-agent Built-in Tool

**New file: `src/server/built-in-tools.ts`**

Exports the Agent tool definition and executor:

```ts
export const AGENT_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'Agent',
    description: 'Run a sub-agent to handle a focused task. Returns the final answer after the agent completes all its tool calls. Use for parallelizable work or tasks that need isolated context.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the sub-agent' },
        model: { type: 'string', description: 'Optional model override' }
      },
      required: ['prompt']
    }
  }
}
```

**In `AiService`:**

Add `private depth: number` (default 0, max 2).

When `tc.name === 'Agent'`:

```ts
if (this.depth >= 2) {
  content = '[error] Maximum sub-agent depth reached.'
} else {
  const subAi = new AiService(this.mcp, this.depth + 1)
  content = await subAi.runToCompletion(prompt, model ?? req.model)
}
```

Add `runToCompletion(prompt, model)`: calls a simplified version of `streamChat` that collects content into a string (no streaming to `res`) and returns the final assistant message.

Sub-agents share the same `McpService` singleton → same connections, no extra processes.

---

### Step 7: REPL Commands

**Modify: `src/cli/cli.ts`**

Add these commands (replacing `.`-prefixed with `/`-prefixed for consistency, keep `.` aliases):

| Command | Action |
|---------|--------|
| `/compact` | Archive + summarize (already exists, improved above) |
| `/cost` | Print `session.totalTokens` with prompt/completion breakdown |
| `/model <name>` | Update `model` var in REPL closure, print confirmation |
| `/memory` | Print contents of `AGENTS.md` from project or global `~/.tool-kit/` |
| `/history [n]` | Print last N conversation turns (default 10) |
| `/clear` | Reset messages + skill injections (alias of `.clear`) |
| `/session` | Print session stats (alias of `.session`) |
| `/tools` | List available MCP tools (call `mcp.listAllTools()` via server) |

Token display: the `buildPrompt()` function already shows `totalTokens`. Extend to show prompt+completion when available by storing last usage on session.

---

## File Change Summary

| File | Change |
|------|--------|
| `src/server/mcp-connection.ts` | **NEW** — McpConnection class |
| `src/server/tool-output-store.ts` | **NEW** — large output storage |
| `src/server/file-cache.ts` | **NEW** — file read dedup cache |
| `src/server/built-in-tools.ts` | **NEW** — Agent tool definition + executor |
| `src/server/mcp.service.ts` | **REWRITE** — use McpConnection pool, cache tool list |
| `src/server/ai.service.ts` | **MODIFY** — inject McpService, file cache, output store, Agent tool, depth |
| `src/server/server.ts` | **MODIFY** — McpService singleton, init on start, shutdown hook |
| `src/cli/session.ts` | **MODIFY** — add MessageType, archiveSession(), archivePath on Session |
| `src/cli/cli.ts` | **MODIFY** — new /commands, improved /compact with archival |

---

## What We Are NOT Changing

- Permission model (out of scope)
- Memory extraction automation (user said use existing tools — AGENTS.md managed via bash/file-editor by the agent itself, system prompt will mention this)
- SSE or WebSocket transports (keep simple HTTP NDJSON)
- Ink/React terminal UI

---

## Verification

1. Start server: `npm run start` — confirm MCP connections logged at startup
2. Interactive REPL: run a task using multiple tool calls, confirm no extra processes per call (`ps aux | grep node`)
3. `/compact` on a long session — verify JSONL archive written to `~/.tool-kit-sessions/`, summary references line numbers
4. Large bash output (e.g., `cat` a large file) — verify output stored to `~/.tool-kit-sessions/tool-outputs/`, stub in conversation
5. Read the same file twice — second read returns the stub (check `[File cached from turn N]` in output)
6. Call `Agent` tool — verify sub-agent runs silently, parent receives final answer
7. `/cost` command — shows token counts
8. `/model claude-3-haiku` — next query uses new model

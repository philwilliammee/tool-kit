[← Documentation](./README.md)

# tool-kit — Phase 6: Skills Auto-Invocation & Hooks Phase 2

> **Status**: Design — not yet implemented.

---

## 1. Scope

Phase 6 completes the skills and hooks systems by adding the server-side pieces that Phase 5 deferred.

| Feature | Description |
|---------|-------------|
| **Skill auto-invocation** | The LLM can invoke skills itself via a `Skill` tool when the task matches a skill's description. Server-side rendering; no user typing required. |
| **Skill-scoped hooks** | A skill's `hooks:` frontmatter registers lifecycle hooks that are active for the remainder of the session once the skill is invoked. |
| **`SessionStart` hook** | Fires once when a new session begins. Can inject context (e.g. load environment state) before the first message reaches the LLM. |
| **`--skill` flag (one-shot)** | Pre-load a named skill in one-shot mode: `tool-kit --skill git-context "summarise changes"`. |
| **`once` flag on handlers** | A hook handler that fires at most once per request cycle. Useful for setup hooks that should not repeat on every tool call. |

### Out of scope (Phase 7+)

- `SessionEnd` hook — requires server-side session lifetime tracking
- `context: fork` — isolated subagent execution for skills
- Prompt/agent hook types — hooks that invoke the LLM for evaluation
- Enterprise/managed skill distribution

---

## 2. Skill Auto-Invocation

### 2.1 Concept

When `disable-auto-invoke` is `false` (the default), the server exposes a `Skill` tool to the LLM alongside the MCP tools. The LLM calls it when it judges a skill's description to be relevant to the user's request. The server renders the skill and injects it as a system message, then continues the agentic loop with the enriched context.

```
User: "what branch am I on and what changed recently?"

LLM decides to call: Skill({ name: "git-context" })

Server renders git-context skill:
  [skill: git-context]
  - Branch: main
  - Status: M src/server/ai.service.ts
  - Recent commits: f08206c feat: phase 5 ...

LLM now has git state — answers the user's question.
```

### 2.2 `Skill` Tool Definition

The server adds a single `Skill` tool to the tools array when at least one auto-invocable skill is available.

```typescript
{
  type: 'function',
  function: {
    name: 'Skill',
    description:
      'Invoke a skill to inject specialised context and instructions into the conversation. ' +
      'Use when the user\'s request matches one of the available skill descriptions.\n\n' +
      'Available skills:\n' +
      skills.map(s => `- ${s.name}: ${s.description}`).join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The skill name to invoke',
          enum: skills.map(s => s.name),
        },
        arguments: {
          type: 'string',
          description: 'Optional arguments passed to the skill ($ARGUMENTS substitution)',
        },
      },
      required: ['name'],
    },
  },
}
```

The `description` field embeds all skill names and descriptions so the LLM can choose the right one. The `enum` constraint on `name` prevents hallucinated skill names.

### 2.3 Server-Side Skill Loading

Skills are loaded server-side from `workingDirectory` (already passed in `ChatRequest`) using the same three-tier discovery logic as the CLI:

```
~/.tool-kit/skills/<name>/SKILL.md       (global)
<cwd>/.tool-kit/skills/<name>/SKILL.md   (project)
<cwd>/.tool-kit/skills.local/<name>/     (project-local)
```

A new `src/server/skills.service.ts` duplicates the discovery and rendering logic from `src/cli/skills.ts` for use inside the agentic loop. The two share the same substitution semantics; the implementation can be extracted to a shared module in a future refactor.

### 2.4 Agentic Loop Changes

When the server receives a `Skill` tool call from the LLM:

```
LLM calls Skill({ name: "git-context", arguments: "" })
  → server renders skill (run !`cmd`, apply $ARGUMENTS, ${VAR})
  → emit { type: 'skill_invoke', data: { name, content } }  ← new event type
  → inject rendered content as system message
  → activate skill-scoped hooks (see Section 3)
  → continue agentic loop — LLM now has skill context
```

The `skill_invoke` event is streamed to the CLI so it can display a confirmation (e.g. `[skill: git-context] injected`) and persist the injection in the session file (matching the behaviour of manual `/skill-name` invocation).

### 2.5 Streaming Protocol Addition

```typescript
type StreamChunk =
  | { type: 'content';      data: string }
  | { type: 'tool_call';    data: ToolCallChunk }
  | { type: 'tool_result';  data: ToolResult }
  | { type: 'skill_invoke'; data: { name: string; content: string } }  // NEW
  | { type: 'complete';     data: null }
  | { type: 'error';        data: string }
```

---

## 3. Skill-Scoped Hooks

### 3.1 Concept

A skill's `hooks:` frontmatter field defines handlers that become active once the skill is invoked — either automatically (via the `Skill` tool) or manually (via `/skill-name` in the REPL). They remain active for the duration of the session.

```yaml
---
name: deploy
disable-auto-invoke: true
hooks:
  PreToolUse:
    - matcher: "bash_.*"
      type: command
      command: "${TOOL_KIT_SKILL_DIR}/hooks/audit-deploy.sh"
---
Deploy $ARGUMENTS to production...
```

### 3.2 Activation

**Auto-invocation (server-side):** When the server handles a `Skill` tool call, it loads the skill's frontmatter `hooks:` and merges them into the active `HooksService` for the remainder of the request.

**Manual invocation (CLI-side):** The CLI already sends skill content as system messages with the `[skill: name]` prefix. On the server, before processing, inspect incoming messages for `[skill: name]` prefixes, load those skills' frontmatter hooks, and merge them into `HooksService`.

### 3.3 `HooksService` Changes

`HooksService` gains a `registerSkillHooks(skill: Skill)` method that merges the skill's frontmatter hook groups into the in-memory settings, respecting the same event/group/handler structure.

```typescript
class HooksService {
  // existing
  constructor(cwd: string)
  async fire(event, input, toolName?): Promise<HookOutput>

  // new
  registerSkillHooks(skillName: string, hooks: Record<string, HookGroup[]>): void
}
```

---

## 4. `SessionStart` Hook

### 4.1 Concept

Fires once at the start of a new session. Useful for injecting one-time context — current environment, cluster name, active feature flags, etc.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".tool-kit/hooks/env-context.sh"
          }
        ]
      }
    ]
  }
}
```

### 4.2 Implementation

The CLI already knows whether a session is new. It passes `isNewSession: boolean` in the `ChatRequest` body. The server fires `SessionStart` once, before `UserPromptSubmit`, when `isNewSession === true`.

**Hook input:**
```json
{
  "event": "SessionStart",
  "session_id": "abc123",
  "working_directory": "/home/user/project",
  "resumed": false
}
```

`resumed` is `false` for brand-new sessions; `true` when loading an existing session from disk (i.e. `--new-session` was not passed and a session file existed).

**Hook output:** same as other events — `contextInjection` is prepended as a system message before the first LLM call.

### 4.3 Request Body Addition

```typescript
interface ChatRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  isNewSession?: boolean;   // NEW — triggers SessionStart hook
  sessionId?: string;       // NEW — passed from CLI for hook input context
}
```

---

## 5. `--skill` Flag (One-Shot Mode)

Allows pre-loading a skill in one-shot mode without a REPL session.

```bash
tool-kit --skill git-context "summarise recent changes"
tool-kit --skill deploy "staging"
```

### 5.1 Behaviour

1. Load the named skill from the three-tier discovery.
2. Render it with the query as `$ARGUMENTS`.
3. Add the rendered content as a system message before the query.
4. Run the one-shot query as normal.

If the named skill is not found, print an error and exit 1.

### 5.2 CLI Changes

Add `--skill <name>` option to the `commander` program. In `oneShotMode`, if `skill` is set: call `loadSkills(cwd)`, call `renderSkill(skill, query, ctx)`, prepend as system message, then pass the original query as the user message.

---

## 6. `once` Flag on Hook Handlers

A handler with `"once": true` fires at most once within a single request cycle (one call to `streamChat`). Subsequent matching events in the same request skip the handler.

```json
{
  "type": "command",
  "command": ".tool-kit/hooks/setup.sh",
  "once": true
}
```

### 6.1 Use Case

A `PreToolUse` hook that injects a one-time setup note before the first bash command — but shouldn't repeat before every subsequent bash call.

### 6.2 Implementation

`HooksService` maintains a `Set<string>` of fired handler fingerprints per instance. The fingerprint is a hash of `event + command/url`. Before running a handler, check if its fingerprint is in the set. If so, skip. After running, add to the set.

Since `HooksService` is instantiated once per `streamChat` call, "once per request" is the natural scope. True once-per-session semantics (across multiple user messages) would require session state and is deferred to Phase 7.

### 6.3 Handler Config Addition

```typescript
interface CommandHandlerConfig {
  type: 'command';
  command: string;
  timeout?: number;
  async?: boolean;
  once?: boolean;   // NEW
}

interface HttpHandlerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  once?: boolean;   // NEW
}
```

---

## 7. Files to Create / Modify

### New files

| File | Purpose |
|------|---------|
| `src/server/skills.service.ts` | Server-side skill discovery, frontmatter parsing, and rendering. Mirrors `src/cli/skills.ts` for use in the agentic loop. |

### Modified files

| File | Changes |
|------|---------|
| `src/server/hooks.service.ts` | Add `registerSkillHooks()`. Add `once` handler fingerprint tracking. |
| `src/server/ai.service.ts` | Load skills server-side. Add `Skill` tool. Handle `Skill` tool calls (render, emit `skill_invoke`, activate skill hooks, inject system message). Fire `SessionStart` when `isNewSession`. Pass `sessionId` from request. |
| `src/cli/client.ts` | Add `isNewSession` and `sessionId` to `QueryOptions`. Handle new `skill_invoke` stream event. |
| `src/cli/cli.ts` | Pass `isNewSession` and `sessionId` to `streamQuery`. Add `--skill <name>` option. Handle `skill_invoke` events (display confirmation, persist to session). |

---

## 8. Updated Agentic Loop

```
Client sends request (messages, workingDirectory, isNewSession, sessionId)
  → HooksService instantiated with cwd
  → SkillsService loads skills from cwd (for auto-invocation)
  → Scan messages for [skill: name] → registerSkillHooks for each
  → if isNewSession: fire SessionStart hook; prepend contextInjection
  → fire UserPromptSubmit hook; prepend contextInjection

  → tools = MCP tools + (Skill tool if auto-invocable skills exist)

Loop:
  → LLM responds
  → if tool_calls:
      for each call:
        if call.name === 'Skill':
          render skill
          registerSkillHooks for invoked skill
          emit { type: 'skill_invoke', data: { name, content } }
          inject [skill: name] system message
          continue loop (no MCP call)
        else:
          PreToolUse → PostToolUse / PostToolUseFailure (existing)
  → if stop: emit complete; fire Stop hook async
```

---

## 9. Design Decisions

| Decision | Rationale |
|----------|-----------|
| Server-side skill loading (duplicate of CLI) | Keeps the server self-contained. The server already has `workingDirectory`; reading skills from the same paths is consistent. A shared module refactor can follow in Phase 7. |
| `Skill` tool description embeds all skill names | The LLM sees names and descriptions in one place, making selection reliable without a separate tool-discovery step. |
| `enum` constraint on `name` parameter | Prevents the LLM from inventing skill names. Hard fail = clear error; easier to debug than a silent miss. |
| `skill_invoke` stream event | CLI needs to know a skill was auto-invoked so it can persist the injection in the session file and display feedback to the user, matching the manual `/skill-name` UX. |
| `once` scoped to request, not session | Server is stateless. True session scope requires storing state between requests; that complexity belongs in Phase 7 alongside `SessionEnd`. |
| `isNewSession` passed from CLI | CLI already knows (it either loaded an existing session file or created a fresh one). Avoids duplicating session detection logic server-side. |

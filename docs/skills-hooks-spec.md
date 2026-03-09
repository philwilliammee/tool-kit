[← Documentation](./README.md)

# tool-kit — Skills & Hooks Specification

> **Status**: Phase 1 implemented. Auto-invocation via LLM Skill tool, skill-scoped hooks, SessionStart/SessionEnd hooks, and `--skill` one-shot flag are deferred to Phase 2.

## 1. Overview

Skills and hooks are two complementary extensibility systems that let developers customize how the agent behaves without modifying server code.

| System | What it does |
|--------|-------------|
| **Skills** | Markdown files that inject reusable instructions and context into the AI conversation. Invoked with `/skill-name` or loaded automatically by the LLM when relevant. |
| **User Instructions** | Plain markdown files (`AGENTS.md`) that are always loaded into the system prompt. The permanent home for standing preferences, personal rules, and working-style constraints — no scripting required. |
| **Hooks** | Shell scripts or HTTP endpoints that fire at specific lifecycle events. They can inject dynamic context into the conversation or block a tool call before it executes. |

They compose: a skill can register hooks that are active only while that skill is running, and user instructions are always present as a baseline that skills and hooks build on top of.

---

## 2. Skills

### 2.1 Concept

A skill is a directory that contains a `SKILL.md` file. The YAML frontmatter describes the skill; the markdown body is the instruction text injected into the AI context when the skill is invoked. Supporting files (templates, scripts, examples) may live alongside `SKILL.md` and are referenced from it.

### 2.2 Directory Layout

```
<skill-name>/
├── SKILL.md           # required — frontmatter + instructions
├── template.md        # optional — template for Claude to fill in
├── examples/
│   └── sample.md      # optional — example output
└── scripts/
    └── helper.sh      # optional — script Claude can execute
```

### 2.3 SKILL.md Format

```yaml
---
name: git-context
description: >
  Injects current git state into the conversation.
  Use when the user asks about recent changes, the current branch,
  or the state of the working tree.
disable-auto-invoke: false
user-invocable: true
hooks:
  PreToolUse:
    - matcher: "bash_.*"
      type: command
      command: "${TOOL_KIT_SKILL_DIR}/hooks/log-bash.sh"
      async: true
---

## Current repository state

- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Recent commits: !`git log --oneline -5`

$ARGUMENTS
```

### 2.4 Frontmatter Fields

| Field | Default | Description |
|-------|---------|-------------|
| `name` | directory name | Skill identifier, becomes the `/name` command. Lowercase letters, numbers, hyphens only (max 64 chars). |
| `description` | first paragraph of body | Shown to the LLM so it can decide when to auto-invoke the skill. The more specific, the better. |
| `disable-auto-invoke` | `false` | If `true`, only the user can invoke the skill. The LLM never loads it automatically. Use for skills with side effects like `/deploy`. |
| `user-invocable` | `true` | If `false`, the skill is hidden from CLI autocomplete and `/` listings. The LLM may still load it automatically unless `disable-auto-invoke` is also `true`. |
| `hooks` | `{}` | Hooks scoped to this skill's lifetime. Same schema as `settings.json` hook handlers. Registered on invocation, de-registered at session end. See [Section 4](#4-hooks). |

### 2.5 String Substitutions

Before the skill content is injected, the following substitutions are applied in order:

| Variable | Description |
|----------|-------------|
| `!`command`` | Runs the shell command and replaces the placeholder with its stdout. Executes before any other substitution. |
| `$ARGUMENTS` | All arguments passed when invoking the skill (`/skill-name <args>`). If absent from content, appended as `ARGUMENTS: <value>`. |
| `$0`, `$1`, … | Positional argument by 0-based index. |
| `${TOOL_KIT_SKILL_DIR}` | Absolute path to the skill's directory. Use to reference bundled scripts. |
| `${TOOL_KIT_SESSION_ID}` | Current session ID. |
| `${TOOL_KIT_WORKING_DIR}` | The working directory of the current session. |

The `!`command`` substitution runs in the working directory of the session, not the skill directory. Use `${TOOL_KIT_SKILL_DIR}` to reference scripts bundled with the skill.

### 2.6 Skill Discovery

Skills are loaded at session start from three locations. Higher priority wins when two skills share the same name.

| Priority | Location | Scope | Committed to repo |
|----------|----------|-------|-------------------|
| 1 (highest) | `.tool-kit/skills.local/<name>/SKILL.md` | Project-local, customer/user-specific | No — gitignored |
| 2 | `.tool-kit/skills/<name>/SKILL.md` | Project — shared with the team | Yes |
| 3 | `~/.tool-kit/skills/<name>/SKILL.md` | Global — personal, all projects on this machine | No — outside repo |

The `skills.local/` tier is the **customer isolation layer**. Developers who clone the repo can add their own skills there — personal integrations, internal tool connectors, proprietary context files — without ever touching committed source files. When they run `git pull`, their local skills are untouched because the path is gitignored.

The repo ships with the following entries in `.gitignore`:

```
.tool-kit/skills.local/
.tool-kit/settings.local.json
.tool-kit/AGENTS.local.md
```

All three local variants live inside the project directory, are fully functional at runtime, and are invisible to git — following the same isolation pattern.

### 2.7 Invocation

**Manual (user)**
In the REPL, type `/skill-name [arguments]`. In one-shot mode, pass `--skill <name> [arguments]`.

**Automatic (server)**
When `disable-auto-invoke` is `false` (the default), skill names and descriptions are included in the system prompt. The LLM can invoke a skill via the `Skill` tool when it judges the description to be relevant.

### 2.8 Context Injection

When a skill is invoked:

1. `!`command`` blocks are executed and their stdout inserted.
2. `$ARGUMENTS` and positional `$N` variables are substituted.
3. `${VAR}` variables are substituted.
4. The rendered content is injected into the conversation as a `system`-role message with prefix `[skill: <name>]`.

```
[skill: git-context]
## Current repository state
- Branch: main
- Status: M src/server/server.ts
- Recent commits: a1b2c3 fix streaming bug
```

---

## 3. User Instructions

### 3.1 Concept

User instructions are plain markdown files that are **always** loaded into the system prompt at session start — no invocation, no scripting, no configuration required. They are the right place for standing preferences, personal working rules, and permanent constraints that should apply to every conversation.

The distinction from other mechanisms:

| Mechanism | Guaranteed present | Requires scripting | Dynamic (computed at runtime) |
|-----------|--------------------|--------------------|-------------------------------|
| **User instructions** | Yes — always in system prompt | No — plain markdown | No |
| Skills | Only when invoked | No | Via `!`cmd`` |
| Hooks | Only when event fires | Yes | Yes |

### 3.2 File Locations

Instructions files are loaded from two locations and concatenated in priority order. Both may exist simultaneously.

| Priority | Location | Scope | Committed to repo |
|----------|----------|-------|-------------------|
| 1 | `~/.tool-kit/AGENTS.md` | Global — applies to all projects on this machine | No — outside repo |
| 2 | `.tool-kit/AGENTS.md` | Project — applies to this project only | Yes (or `.local` variant, see below) |

For project-level instructions that should not be committed, use `.tool-kit/AGENTS.local.md` (gitignored). This follows the same isolation pattern as `settings.local.json` and `skills.local/`.

The repo ships with these entries in `.gitignore`:

```
.tool-kit/skills.local/
.tool-kit/settings.local.json
.tool-kit/AGENTS.local.md
```

### 3.3 Format

Instructions files are plain markdown. No frontmatter, no special syntax. Write directly to the LLM.

**`~/.tool-kit/AGENTS.md` example:**

```markdown
## My working preferences

- Never checkout or commit directly to the `main` or `master` branch. Always create a feature branch.
- Prefer small, focused commits. One logical change per commit.
- When suggesting shell commands, explain what each flag does if it's not obvious.
- I work in TypeScript. Default to strict types; avoid `any`.
- When editing files, show the diff before applying it and ask for confirmation.
```

**`.tool-kit/AGENTS.md` example (project-level):**

```markdown
## Project conventions

- This repo uses conventional commits: `feat:`, `fix:`, `chore:`, `docs:` prefixes required.
- Never modify files in `dist/` directly — they are build artefacts.
- The test command is `npm test`. Always run it before suggesting a commit.
- GitHub token is scoped read-only; do not attempt write operations on other repos.
```

### 3.4 Injection into the System Prompt

Both files are read at session start and injected as a single `system`-role block, user-global first, project-level second:

```
[agents: user]
## My working preferences
- Never checkout or commit directly to the `main` or `master` branch...
...

[agents: project]
## Project conventions
- This repo uses conventional commits...
...
```

This block is part of the base system prompt and persists for the entire session. It is not re-injected per message (unlike `UserPromptSubmit` hook context), so it does not inflate the conversation history.

### 3.5 Relationship to Hooks

Instructions cover the **static** case: things that are always true regardless of runtime state. Hooks cover the **dynamic** case: things that depend on current conditions.

Use instructions for:
- Personal preferences and working style
- Hard rules ("never touch main", "always run tests before committing")
- Project conventions and constraints

Use hooks for:
- Current git state (branch, dirty files)
- Environment-specific context (which cluster, which stage)
- Conditionally blocking tool calls

---

## 4. Hooks

### 4.1 Concept

Hooks are shell commands or HTTP endpoints that fire automatically at specific points in the agent's lifecycle. A hook can:

- **Inject context** — add information into the conversation that the LLM will see.
- **Block a tool call** — prevent an MCP tool from executing, with a reason.
- **Log or audit** — fire asynchronously to record activity externally.

### 4.2 Configuration Files

Hooks are configured in JSON settings files. All three levels are merged at session start; project-local settings override global settings for the same event.

| Location | Scope | Committable |
|----------|-------|-------------|
| `~/.tool-kit/settings.json` | All projects on this machine | No |
| `.tool-kit/settings.json` | This project | Yes |
| `.tool-kit/settings.local.json` | This project, local overrides | No (gitignored) |

**Top-level settings.json schema:**

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<regex string, omit to match all>",
        "hooks": [
          {
            "type": "command | http",
            "...handler fields..."
          }
        ]
      }
    ]
  }
}
```

### 4.3 Hook Events

| Event | Fires when | Matcher support |
|-------|------------|-----------------|
| `SessionStart` | A new session is created or an existing one is resumed | No — always fires |
| `UserPromptSubmit` | The user submits a prompt, before it is sent to the LLM | No — always fires |
| `PreToolUse` | Before an MCP tool call executes. Can block the call. | Yes — matches on tool name |
| `PostToolUse` | After an MCP tool call succeeds | Yes — matches on tool name |
| `PostToolUseFailure` | After an MCP tool call returns an error | Yes — matches on tool name |
| `Stop` | After the LLM finishes a full response turn | No — always fires |
| `SessionEnd` | When the session is cleared or expires | No — always fires |

### 4.4 Matcher Patterns

The `matcher` field is a regex string matched against the full MCP tool name (`{serverName}_{toolName}`).

| Pattern | Matches |
|---------|---------|
| `bash_.*` | All bash-server tools |
| `octokit_create_.*` | All octokit create operations |
| `file-editor_.*` | All file-editor tools |
| `bash_run_command\|octokit_create_issue` | Exact union of two tools |

Omit `matcher` (or use `"*"`) to match every occurrence of the event.

### 4.5 Hook Input

The server sends event context as JSON to the hook. For command hooks it arrives on **stdin**. For HTTP hooks it is the **POST body**.

**SessionStart**
```json
{
  "event": "SessionStart",
  "session_id": "2026-03-09_main",
  "working_directory": "/home/user/project",
  "resumed": false
}
```

**UserPromptSubmit**
```json
{
  "event": "UserPromptSubmit",
  "session_id": "2026-03-09_main",
  "working_directory": "/home/user/project",
  "message": "summarise the last 5 commits"
}
```

**PreToolUse / PostToolUse / PostToolUseFailure**
```json
{
  "event": "PreToolUse",
  "session_id": "2026-03-09_main",
  "working_directory": "/home/user/project",
  "tool_name": "bash_run_command",
  "tool_input": { "command": "npm test" }
}
```

`PostToolUse` adds `"tool_result"` (the tool's output string). `PostToolUseFailure` adds `"error"` (the error message).

**Stop**
```json
{
  "event": "Stop",
  "session_id": "2026-03-09_main",
  "working_directory": "/home/user/project"
}
```

### 4.6 Hook Output

Hooks return JSON on **stdout** (command) or in the **response body** (HTTP). Exit code 0 = proceed; non-zero = error (logged, execution continues unless `PreToolUse` blocks).

**Inject context into the conversation**

The `contextInjection` field adds a system-level note that the LLM sees before its next response. Valid on any event.

```json
{
  "contextInjection": "Note: the active git branch is 'main' and there are 3 uncommitted files."
}
```

The server inserts it as a `system`-role message prefixed with `[hook: <EventName>]`:

```
[hook: UserPromptSubmit] Note: the active git branch is 'main' and there are 3 uncommitted files.
```

**Block a tool call (PreToolUse only)**

```json
{
  "decision": "block",
  "reason": "Destructive shell command blocked by policy hook."
}
```

The server surfaces `reason` as the tool result so the LLM can explain the block to the user.

**No action**

Exit 0 with no output, or return `{}`.

### 4.7 Handler Types

#### Command Hook

```json
{
  "type": "command",
  "command": ".tool-kit/hooks/inject-git-state.sh",
  "timeout": 30,
  "async": false
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"command"` |
| `command` | yes | Shell command executed in the session's working directory |
| `timeout` | no | Seconds before cancellation. Default: 30 |
| `async` | no | If `true`, runs without blocking. No context injection possible. Default: `false` |

#### HTTP Hook

```json
{
  "type": "http",
  "url": "http://localhost:9000/hooks/pre-tool",
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"],
  "timeout": 10
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | `"http"` |
| `url` | yes | Endpoint that receives a POST with the event JSON as the body |
| `headers` | no | Additional request headers. `$VAR` and `${VAR}` syntax resolved from `allowedEnvVars` |
| `allowedEnvVars` | no | Environment variables that may be interpolated into header values |
| `timeout` | no | Seconds before cancellation. Default: 10 |

Non-2xx responses, connection failures, and timeouts are non-blocking errors — execution continues. To block a tool call, return a 2xx response with `decision: "block"` in the body.

---

## 5. Skills as Hook Providers

A skill's `hooks` frontmatter key registers hooks that are active only while that skill is in scope (from invocation until the session ends or is cleared). This lets a skill extend not just the LLM's knowledge but also the agent's runtime behaviour.

**Example: a deploy skill that audits bash commands**

```yaml
---
name: deploy
description: Deploys the application to production. Use only when the user explicitly asks to deploy.
disable-auto-invoke: true
hooks:
  PreToolUse:
    - matcher: "bash_.*"
      type: command
      command: "${TOOL_KIT_SKILL_DIR}/hooks/audit-deploy-command.sh"
---

Deploy $ARGUMENTS to production:

1. Run the test suite — `npm test`
2. Build the project — `npm run build`
3. Push to the deployment target
4. Verify the deployment succeeded
```

When `/deploy staging` is invoked:
1. The skill content (with `$ARGUMENTS` = `staging`) is injected into the conversation.
2. The `PreToolUse` hook is registered for this session.
3. Before every subsequent `bash_*` tool call, `audit-deploy-command.sh` is run and can inject context or block the command.

---

## 6. Server Integration

### 6.1 Startup Sequence

```
1. Load settings.json files (global, project, local) → merge hooks config
2. Load AGENTS.md files (global, project, local) → build static instruction block
3. Scan global, project, and local skill directories → build skill registry
4. Register SessionStart hooks → execute, inject context if any
5. Build system prompt:
   - Base instructions
   - User instructions block ([agents: user] + [agents: project])
   - Skill descriptions (for skills where disable-auto-invoke = false)
   - SessionStart context injections
```

### 6.2 Agentic Loop

```
User submits prompt
  → UserPromptSubmit hooks fire
  → contextInjection prepended to conversation as system note
  → messages sent to LLM

LLM returns tool call
  → PreToolUse hooks fire (matching on tool_name)
  → if decision = "block": return block reason as tool result, loop continues
  → if contextInjection: prepend note to conversation before tool result
  → execute MCP tool via stdio

MCP tool returns
  → PostToolUse (or PostToolUseFailure) hooks fire
  → if contextInjection: append note to tool result message
  → return result to LLM

LLM finishes response turn (no more tool calls)
  → Stop hooks fire (async, no injection needed)
```

### 6.3 Skill Invocation (in the loop)

When the LLM calls the `Skill` tool (or the user types `/skill-name`):

```
1. Locate SKILL.md for the given name
2. Run !`command` substitutions
3. Apply $ARGUMENTS and ${VAR} substitutions
4. Register any hooks defined in skill frontmatter
5. Inject rendered content as [skill: <name>] system message
6. Continue agentic loop — LLM now has skill context
```

---

## 7. CLI Integration

### 7.1 REPL Commands

| Command | Description |
|---------|-------------|
| `/skill-name [args]` | Invoke a skill with optional arguments |
| `.skills` | List all discovered skills (name + description) |
| `.hooks` | Show active hook registrations for this session |

### 7.2 One-Shot Mode

```bash
# Invoke a skill explicitly in one-shot mode
node dist/cli/cli.js --skill git-context "summarise recent changes"
```

---

## 8. Project Layout (additions)

```
project/
├── .tool-kit/
│   ├── settings.json              # hook config — committed, team-shared
│   ├── settings.local.json        # hook config — gitignored, customer/local overrides
│   ├── AGENTS.md            # project standing instructions — committed, team-shared
│   ├── AGENTS.local.md      # project instructions — gitignored, customer/local
│   ├── skills/                    # committed skills — pulled with repo updates
│   │   └── <skill-name>/
│   │       ├── SKILL.md           # required
│   │       └── hooks/             # optional scripts for skill-scoped hooks
│   └── skills.local/              # gitignored skills — customer/user-specific
│       └── <skill-name>/
│           ├── SKILL.md
│           └── ...

~/.tool-kit/
├── settings.json                  # global hook config — machine-wide, never in repo
├── AGENTS.md                # global standing instructions — machine-wide, never in repo
└── skills/
    └── <skill-name>/              # global skills — machine-wide, never in repo
        └── SKILL.md
```

**Customer isolation summary** — a developer clones the repo and adds customisations without ever creating a merge conflict:

| What | Where | Pulled by `git pull`? |
|------|-------|-----------------------|
| Team skills, shared hooks, project instructions | `.tool-kit/skills/`, `.tool-kit/settings.json`, `.tool-kit/AGENTS.md` | Yes |
| Personal project skills, hooks, instructions | `.tool-kit/skills.local/`, `.tool-kit/settings.local.json`, `.tool-kit/AGENTS.local.md` | No (gitignored) |
| Machine-wide skills, hooks, instructions | `~/.tool-kit/` | No (outside repo) |

---

## 9. Example: context-injecting hook

This example injects the current git branch and dirty-file count into every conversation before the LLM sees the user's message.

**.tool-kit/settings.json**
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".tool-kit/hooks/git-state.sh"
          }
        ]
      }
    ]
  }
}
```

**.tool-kit/hooks/git-state.sh**
```bash
#!/usr/bin/env bash
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
DIRTY=$(git status --short 2>/dev/null | wc -l | tr -d ' ')

jq -n --arg b "$BRANCH" --arg d "$DIRTY" \
  '{"contextInjection": ("Git: branch=" + $b + ", " + $d + " modified files.")}'
```

The LLM now sees:
```
[hook: UserPromptSubmit] Git: branch=main, 3 modified files.
```
before every user message, without the user having to mention it.

---

## 10. Design Decisions & Constraints

| Decision | Rationale |
|----------|-----------|
| Skills are markdown files, not code | Any team member can read, write, and review them in a pull request without understanding TypeScript. |
| Hooks use shell scripts / HTTP | Keeps the server dependency-free. Any language can implement a hook; no SDK required. |
| Context injection is `system`-role | Ensures hook context is authoritative (not user-attributable) and survives context compaction better than injecting into the last user message. |
| Skill-scoped hooks are session-lifetime | Simplifies state management. A skill's hooks cannot outlive the session, preventing stale registrations. |
| `disable-auto-invoke` defaults to `false` | Most skills are informational; requiring explicit opt-in for auto-invoke would make them less useful out of the box. Side-effect skills (deploy, commit) should always set it to `true`. |
| MCP tool names as matcher target | tool-kit already names tools `{serverName}_{toolName}`, so hooks naturally compose with the existing MCP routing logic. |

---

## 11. Out of Scope (Phase 1)

The following are noted for future phases:

- **Prompt / agent hook types** — hooks that invoke the LLM for evaluation (vs. a shell script). Complex; deferred.
- **Skill `context: fork`** — running a skill in an isolated subagent context. Requires subagent support.
- **`once` flag** — a hook that fires only once per session then de-registers itself.
- **Enterprise / managed skills** — organisation-wide skill distribution.
- **Skill auto-discovery from subdirectories** — scanning nested `.tool-kit/skills/` for monorepo packages.

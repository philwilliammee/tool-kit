# tool-kit

A super lightweight TypeScript AI agent built for cloud-based automated development. It ships with three core developer tools — **bash** (shell execution), **file-editor** (diff-based file editing with rollback), and **octokit** (GitHub API) — and can be extended with any MCP server. Run it interactively as a developer REPL, invoke it one-shot from a CI script, or call its HTTP API from any client.

The backend connects to any **OpenAI-compatible API** — LiteLLM, OpenAI directly, Azure OpenAI, Ollama, Anthropic via proxy, or any other compatible endpoint. Point `OPENAI_BASE_URL` at whatever you're running.

## How it compares

| | tool-kit | [Claude Code](https://claude.ai/code) | [OpenClaw](https://openclaw.ai) |
|---|---|---|---|
| **Focus** | Developer coding agent | Developer coding agent | Personal automation assistant |
| **Source** | Open source | Closed source | Open source |
| **Transport** | HTTP API (CLI is one client) | Tightly coupled CLI | Multi-channel (WhatsApp, Telegram, Discord…) |
| **Model** | Any OpenAI-compatible API | Claude only | Multiple models with failover |
| **Tools** | Bash, GitHub, file editing (MCP) | File editing, bash, web search | Browser, email, calendar, shell, plugins |
| **Hosting** | Self-hosted server + CLI | Managed by Anthropic | Local-first, self-hosted |
| **Extend** | Add MCP servers | Limited | Community skills / plugins |

**tool-kit** is a super lightweight agent designed to run in a cloud environment: open source and self-hosted like OpenClaw, but narrowly focused on automated software development like Claude Code. Its built-in bash, file-editor, and GitHub tools give the agent everything it needs to read code, open pull requests, run commands, and edit files — all from a single deployable server. The HTTP API boundary means any client — CLI, web UI, CI script — can drive the same backend.

```
CLI  ──POST /api/chat/stream──▶  Express backend  ──▶  OpenAI-compatible API
                                        │                (LiteLLM, OpenAI, Ollama, …)
                              stdio (per tool call)
                                        │
                             ┌──────────┴──────────┐
                        bash-server     octokit     file-editor
```

## Quick start

```bash
# 1. Copy environment config and fill in your values
cp .env.example .env

# 2. Install root dependencies
npm install

# 3. Build MCP servers
for dir in mcp/bash-server mcp/octokit-mcp-server mcp/file-editor-mcp-server; do
  (cd "$dir" && npm install && npm run build)
done

# 4. Build the main project
npm run build

# 5. Start the backend server (keep this running)
npm run start

# 6. In a second terminal — one-shot query
node --env-file=.env dist/cli/cli.js "what branch am I on?"

# 7. Or launch the interactive REPL
node --env-file=.env dist/cli/cli.js
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | API key for your OpenAI-compatible endpoint |
| `OPENAI_BASE_URL` | Yes | Base URL of your OpenAI-compatible endpoint (LiteLLM, OpenAI, Ollama, etc.) |
| `API_TOKEN` | Yes | Shared secret for CLI → backend auth |
| `MODEL` | No | LiteLLM model string (default: `anthropic.claude-4.5-sonnet`) |
| `GITHUB_TOKEN` | No | GitHub PAT for the octokit MCP server |
| `WORKSPACE_ROOT` | No | Root path the file-editor can access (default: `$HOME`) |

See `.env.example` for a full template.

## Interactive REPL commands

| Command | Description |
|---------|-------------|
| `.session` | Show session stats (messages, tool calls) |
| `.clear` | Clear session message history |
| `.tools` | List tool calls made this session |
| `exit` / `quit` | Exit |

## Documentation

| Document | Description |
|----------|-------------|
| [docs/spec.md](./docs/spec.md) | Architecture, TypeScript interfaces, API contract, env vars, MCP config |
| [docs/README.md](./docs/README.md) | Docs index |

## MCP Servers

| Server | Description |
|--------|-------------|
| [mcp/bash-server](./mcp/bash-server/README.md) | Shell command execution with safety controls |
| [mcp/octokit-mcp-server](./mcp/octokit-mcp-server/README.md) | GitHub API — repos, issues, pull requests |
| [mcp/file-editor-mcp-server](./mcp/file-editor-mcp-server/README.md) | Intelligent file editing — diff, apply, rollback, search |

See [mcp/README.md](./mcp/README.md) for the protocol reference and instructions for adding new servers.

## Project layout

```
tool-kit/
├── src/
│   ├── cli/        # CLI client (commander, axios streaming, session, display)
│   └── server/     # Express backend (LiteLLM, MCP service, config)
├── mcp/            # MCP tool servers (each independently buildable)
├── config/         # mcp-servers.json — MCP binary paths, ${VAR} substitution
├── dist/           # Compiled output (tsc)
└── docs/           # Project documentation and spec
```

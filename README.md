# tool-kit

A super lightweight TypeScript AI agent built for cloud-based automated development. It ships with three core developer tools — **bash** (shell execution), **file-editor** (diff-based file editing with rollback), and **octokit** (GitHub API) — and can be extended with any MCP server. Run it interactively as a developer REPL, invoke it one-shot from a CI script, or call its HTTP API from any client.

The backend connects to any **OpenAI-compatible API** — LiteLLM, OpenAI directly, Azure OpenAI, Ollama, Anthropic via proxy, or any other compatible endpoint. Point `OPENAI_BASE_URL` at whatever you're running.

## How it compares

| | tool-kit | [pi-mono](https://github.com/badlogic/pi-mono) |
|---|---|---|
| **Focus** | Coding agent for cloud-based dev automation | Full AI agent ecosystem (coding agent + Slack bot + TUI/web UI libs + GPU pod management) |
| **Source** | Open source (MIT) | Open source (MIT) |
| **Transport** | HTTP API — any client (CLI, CI script, web UI) drives the same backend | Tightly coupled CLI per package |
| **Model** | Any OpenAI-compatible endpoint (`OPENAI_BASE_URL`) | Unified multi-provider API (`pi-ai`: OpenAI, Anthropic, Google) |
| **Tools** | Bash, GitHub (octokit), file editing via MCP | Coding agent CLI, Slack delegation bot, vLLM pod management |
| **Hosting** | Single deployable server + thin CLI client | Library packages, local-first |
| **Extend** | Add MCP servers (standard protocol) | Add NPM packages |

**tool-kit** does one thing: give a cloud-hosted coding agent reliable tools to read code, run commands, edit files, and open pull requests. Where pi-mono is a full ecosystem spanning Slack bots, TUI/web UI libraries, and GPU pod management, tool-kit stays narrowly focused so you can deploy a single Express server and drive it from any client — CLI, CI pipeline, or web UI — over a plain HTTP streaming API. Extension is via MCP servers rather than custom NPM packages, so any MCP-compatible tool drops straight in.

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

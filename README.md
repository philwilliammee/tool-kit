# tool-kit

A TypeScript CLI AI agent backed by LiteLLM and MCP servers. Run it interactively as a developer assistant, or invoke it one-shot from a script or CI pipeline.

```
CLI  ──POST /api/chat/stream──▶  Express backend  ──▶  LiteLLM proxy
                                        │
                              stdio (per tool call)
                                        │
                             ┌──────────┴──────────┐
                        bash-server     octokit     file-editor
```

## Quick start

```bash
# Install dependencies
npm install

# Build
npx tsc

# Start the backend server
node dist/server.js

# One-shot query
node dist/cli.js "what branch am I on?"

# Interactive REPL
node dist/cli.js
```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | LiteLLM proxy API key |
| `OPENAI_BASE_URL` | LiteLLM proxy base URL |
| `API_TOKEN` | Bearer token for CLI → backend auth |

## Documentation

| Document | Description |
|----------|-------------|
| [docs/spec.md](./docs/spec.md) | Full project specification — architecture, TypeScript interfaces, API contract, MCP config, implementation phases |
| [docs/ai-agent.md](./docs/ai-agent.md) | Reference documentation for the `ssit-terminal-ai` `/bin/ai` agent this project is modelled on |
| [docs/index.md](./docs/index.md) | Docs table of contents |

## MCP Servers

| Server | Description |
|--------|-------------|
| [mcp/README.md](./mcp/README.md) | MCP server overview — protocol, build instructions, adding new servers |
| [mcp/bash-server](./mcp/bash-server/README.md) | Shell command execution with safety controls |
| [mcp/octokit-mcp-server](./mcp/octokit-mcp-server/README.md) | GitHub API — repos, issues, pull requests |
| [mcp/file-editor-mcp-server](./mcp/file-editor-mcp-server/README.md) | Intelligent file editing — diff, apply, rollback, search |

## Build MCP servers

```bash
for dir in mcp/bash-server mcp/octokit-mcp-server mcp/file-editor-mcp-server; do
  (cd "$dir" && npm install && npm run build)
done
```

## Project layout

```
tool-kit/
├── src/
│   ├── cli/        # CLI client (commander, axios streaming, session, display)
│   └── server/     # Express backend (LiteLLM, MCP service, config)
├── mcp/            # MCP tool servers (each independently buildable)
├── config/         # mcp-servers.json (MCP binary paths, ${VAR} substitution)
├── dist/           # Compiled output
└── docs/           # Architecture docs and project spec
```

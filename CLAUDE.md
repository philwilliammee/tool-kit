# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build TypeScript to dist/
npx tsc

# Build and run
npm run start

# Lint
npx eslint .

# Build all MCP servers
for dir in mcp/bash-server mcp/octokit-mcp-server mcp/file-editor-mcp-server; do
  (cd "$dir" && npm install && npm run build)
done
```

There is no test framework configured yet.

## Code Style

Use default Prettier configuration (no custom `.prettierrc` in this repo). TypeScript compiles to CommonJS ES6 targeting `dist/`.

### Environment Variables

Never use fallback values for required environment variables. Assert the variable is set and throw a clear error if not:

```ts
// ✅ correct
const BASE_URL = process.env.OPENAI_BASE_URL;
if (!BASE_URL) throw new Error('OPENAI_BASE_URL environment variable is required');

// ❌ wrong — hides misconfiguration with a silent default
const BASE_URL = process.env.OPENAI_BASE_URL || 'http://localhost:11434';
```

This applies to all MCP servers, the CLI, and the backend server. Fail fast with a clear message rather than silently running against the wrong endpoint.

## Project Purpose

This workspace is a **CLI AI agent** with two operating modes — interactive developer REPL and one-shot query — backed by a LiteLLM proxy and MCP servers over stdio.

It is also the **monorepo home for all MCP tool servers**, which live in `mcp/` alongside the CLI and backend source.

Full reference documentation lives in `docs/`:

- `docs/spec.md` — full project specification (architecture, interfaces, phases)
- `docs/index.md` — documentation table of contents
- `docs/archive/` — historical reference material (not part of active docs)

## Architecture

```
CLI (thin HTTP client)
  └─ POST /api/chat/stream  →  Express backend  (src/server/)
                                   ├─ OpenAI SDK (baseURL = LiteLLM proxy)
                                   └─ MCP servers (JSON-RPC 2.0 over stdio, spawned per call)
```

- **LiteLLM**: Use the OpenAI SDK with `baseURL` set to `OPENAI_BASE_URL`. Default model: `anthropic.claude-4.5-sonnet`.
- **MCP tools**: Spawn a child process per call; send `tools/list` to discover, `tools/call` to execute. Name tools as `{serverName}_{toolName}`.
- **Streaming**: Backend streams newline-delimited JSON (`content`, `tool_call`, `tool_result`, `complete`, `error` events).
- **Sessions**: Persist conversation state to `~/.tool-kit-sessions/` keyed by `workingDirectory + date`.

## MCP Servers

All servers live in `mcp/` and are independently buildable Node/TypeScript projects.

| Server | Binary | Purpose |
|--------|--------|---------|
| `bash` | `mcp/bash-server/build/index.js` | Shell command execution |
| `octokit` | `mcp/octokit-mcp-server/build/index.js` | GitHub SDK |
| `file-editor` | `mcp/file-editor-mcp-server/build/file-editor-mcp.js` | Intelligent file editing |

MCP server configuration: `config/mcp-servers.json` (uses `${VAR}` substitution). See `docs/spec.md` for the full schema.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | LiteLLM proxy API key |
| `OPENAI_BASE_URL` | LiteLLM proxy base URL |
| `MODEL` | LiteLLM model string (default: `anthropic.claude-4.5-sonnet`) |
| `API_TOKEN` | Bearer token for CLI → backend authentication |
| `PORT` | Server port (default: `3333`) |
| `MCP_ROOT` | Base path for MCP server binaries (default: `<project-root>/mcp`) |
| `GITHUB_TOKEN` | GitHub personal access token for the octokit MCP server |
| `WORKSPACE_ROOT` | Root path the file-editor MCP server can access (default: `$HOME`) |

> **Development**: set `API_TOKEN` to any shared secret string in your local `.env` file (e.g. `API_TOKEN=dev-secret`). Pass the same value to the CLI with `--token` or the `API_TOKEN` env var. In production, inject it via Docker `-e` or a secrets manager — never commit the real value.

---

## Documentation Structure — Maintain This As You Work

This project uses a **layered README index** pattern. Every directory that contains meaningful content has a `README.md`, and every README links upward to the project root. **When adding new features, directories, or MCP servers, update the relevant indexes.**

### Index hierarchy

```
README.md                          ← project root — indexes everything
├── docs/README.md                 ← indexes all docs/ files
│   ├── docs/spec.md
│   ├── docs/index.md
│   └── docs/archive/              ← historical reference (not indexed)
└── mcp/README.md                  ← indexes all MCP servers
    ├── mcp/bash-server/README.md
    ├── mcp/octokit-mcp-server/README.md
    └── mcp/file-editor-mcp-server/README.md
```

### Rules

1. **New MCP server** → add a `README.md` in the server directory, add a row to `mcp/README.md`, add a row to the MCP Servers table in the root `README.md`, and register it in `config/mcp-servers.json`.

2. **New doc file in `docs/`** → add an entry to `docs/README.md` and `docs/index.md`.

3. **New top-level directory** → add a `README.md` to that directory and a link to it from the root `README.md`.

4. **Spec changes** → if you change the architecture, interfaces, env vars, or phases, update `docs/spec.md` to match. The spec is the source of truth for implementation decisions.

5. **Back-links** → every `docs/*.md` file starts with `[← Documentation Index](./index.md)`. Every `mcp/*/README.md` implicitly belongs to the `mcp/README.md` index. Keep these navigable.

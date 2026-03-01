# mcp/

MCP (Model Context Protocol) servers for tool-kit. Each server is an independent Node/TypeScript project that communicates over stdio using JSON-RPC 2.0.

## Servers

| Server | Purpose | Entry Point |
|--------|---------|-------------|
| [`bash-server`](./bash-server/) | Shell command execution with safety controls | `build/index.js` |
| [`octokit-mcp-server`](./octokit-mcp-server/) | GitHub API — repos, issues, PRs | `build/index.js` |
| [`file-editor-mcp-server`](./file-editor-mcp-server/) | Intelligent file editing — diff, apply, rollback | `build/file-editor-mcp.js` |

## Build all servers

```bash
for dir in bash-server octokit-mcp-server file-editor-mcp-server; do
  echo "Building $dir..."
  (cd "$dir" && npm install && npm run build)
done
```

## Adding a new server

1. Create a directory under `mcp/`
2. Add `package.json` with `@modelcontextprotocol/sdk` as a dependency
3. Write a `src/index.ts` entry point using `StdioServerTransport`
4. Add `tsconfig.json` that outputs to `build/`
5. Register it in `../config/mcp-servers.json`
6. Write a `README.md` documenting its tools and parameters

## Protocol

All servers speak JSON-RPC 2.0 over stdin/stdout:

```json
// Discover tools
{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }

// Call a tool
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "execute_command", "arguments": { "command": "ls" } } }
```

Tool names are exposed to the AI as `{serverName}_{toolName}` and routed by splitting on the first `_`.

# octokit-mcp-server

MCP server for GitHub API operations using Octokit. Exposes convenience tools for the most common operations plus a generic `github_api` escape hatch for anything else.

## Build

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your token:

```bash
cp .env.example .env
```

`.env`:
```
GITHUB_TOKEN=your_github_personal_access_token_here
```

Environment variables loaded via Node 22's built-in `--env-file=.env` flag (no dotenv dependency).

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub personal access token (or use `GITHUB_AUTH_TOKEN`) |
| `MCP_TRANSPORT` | No | `stdio` (default), `http`, or `sse` |
| `MCP_PORT` | No | Port for HTTP/SSE transport (default: `3006`) |

## Transport

The default transport is `stdio` — the mode used by tool-kit's MCP service. HTTP and SSE transports are available for standalone use.

```bash
# stdio (default — used by tool-kit)
npm start

# HTTP
npm run start:http

# SSE
npm run start:sse
```

## Tools

| Tool | Description |
|------|-------------|
| `github_api` | Execute any GitHub REST API operation by path |
| `github_get_repo` | Get repository metadata |
| `github_list_issues` | List issues (filter by state) |
| `github_create_issue` | Create an issue |
| `github_list_pulls` | List pull requests |
| `github_create_pull` | Create a pull request |
| `github_search_repos` | Search repositories |
| `github_get_user` | Get authenticated user info |

### `github_api` — Generic operation

```json
{
  "operation": "GET /repos/{owner}/{repo}/contents/{path}",
  "parameters": { "owner": "acme", "repo": "myapp", "path": "src/index.ts" }
}
```

### `github_create_pull`

```json
{
  "owner": "acme",
  "repo": "myapp",
  "title": "Fix auth bug",
  "head": "fix/auth",
  "base": "main",
  "body": "Resolves #42",
  "draft": false
}
```

### `github_list_issues`

```json
{ "owner": "acme", "repo": "myapp", "state": "open" }
```

## Response format

```json
{
  "data": {},
  "status": 200,
  "rateLimit": { "limit": 5000, "remaining": 4980, "reset": 1700000000, "used": 20 }
}
```

Errors return `{ "error": true, "message": "...", "status": 404 }`.

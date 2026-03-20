# file-editor-mcp-server

MCP server for stateless file editing. Uses direct string replacement — no diff IDs, no session state. Safe across MCP server restarts.

## Build

```bash
npm install
npm run build
```

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKSPACE_ROOT` | No | Root path the server is allowed to access (default: `$HOME`) |

## Tools

### `search_code_context`

Find exact current content in a file before editing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute or relative path to the file |
| `search_type` | string | Yes | `function`, `class`, `lines`, or `pattern` |
| `search_query` | string | Yes | Name, line range (e.g. `10-25`), or regex pattern |
| `context_lines` | number | No | Lines of context around match (default: 3) |
| `include_imports` | boolean | No | Include import block in result |

### `edit_file`

Stateless string-replacement edit. Finds `old_string` in the file and replaces it with `new_string`. Replaces the first occurrence only. No IDs or prior calls needed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `old_string` | string | Yes | Exact text to replace (must exist in file) |
| `new_string` | string | Yes | Replacement text |
| `create_backup` | boolean | No | Save a `.bak` before editing (default: true) |

### `batch_edit`

Apply multiple file operations atomically across files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operations` | array | Yes | List of operations (see below) |
| `atomic` | boolean | No | Roll back all if any operation fails (default: true) |
| `validate_all` | boolean | No | Validate all operations before applying any (default: true) |

Each operation: `{ file_path, operation, old_string?, new_string?, new_path?, new_content? }`

`operation` values: `edit` (requires `old_string` + `new_string`), `create` (requires `new_content`), `delete`, `rename` (requires `new_path`).

### `rollback_changes`

Restore files from backups created by `edit_file` or `batch_edit`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `backup_paths` | string[] | Yes | Backup file paths returned by the edit operations |

## Typical workflow

```
search_code_context  →  find the exact text to change
edit_file            →  replace old_string with new_string (backup created automatically)
rollback_changes     →  undo if something went wrong
```

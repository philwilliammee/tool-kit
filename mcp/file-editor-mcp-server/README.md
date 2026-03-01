# file-editor-mcp-server

MCP server for intelligent file editing. Instead of reading and rewriting whole files, it works with minimal diffs — search for context, generate a diff, validate it, and apply it. Backups are created automatically; changes can be rolled back.

## Build

```bash
npm install
npm run build
```

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKSPACE_ROOT` | No | Root path the server is allowed to access (default: `$HOME`) |

Set `WORKSPACE_ROOT` to restrict file access to a specific directory tree. When used via tool-kit, this is passed automatically from `config/mcp-servers.json`.

## Tools

### `search_code_context`

Find a function, class, or pattern in a file before editing it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute or relative path to the file |
| `search_type` | string | Yes | `function`, `class`, `lines`, or `pattern` |
| `search_query` | string | Yes | Name, line range (e.g. `10-25`), or regex pattern |
| `context_lines` | number | No | Lines of context around match (default: 5) |
| `include_imports` | boolean | No | Include import block in result |

### `generate_diff`

Generate a minimal unified diff between old and new content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Target file |
| `old_content` | string | Yes | Current content of the section |
| `new_content` | string | Yes | Replacement content |
| `algorithm` | string | No | `unified` (default), `line`, `word`, `character` |
| `validate_before` | boolean | No | Check the diff is applicable before returning |

Returns a `diff_id` that can be passed directly to `apply_diff`.

### `apply_diff`

Apply a diff to a file, optionally creating a backup.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Target file |
| `diff_id` | string | No | ID from `generate_diff` |
| `diff_content` | string | No | Raw diff content (alternative to `diff_id`) |
| `create_backup` | boolean | No | Save a backup before applying (default: true) |
| `force` | boolean | No | Apply even if validation warnings exist |

### `validate_change`

Check a proposed change without applying it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Target file |
| `diff_id` | string | No | Diff to validate |
| `new_content` | string | No | Full new content to validate |
| `validation_type` | string | Yes | `syntax`, `linter`, `tests`, or `all` |
| `language` | string | No | Language hint for syntax checking |

### `batch_edit`

Apply multiple file operations atomically.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `operations` | array | Yes | List of `{ file_path, operation, diff_content?, new_path?, new_content? }` |
| `atomic` | boolean | No | Roll back all changes if any operation fails (default: true) |
| `validate_all` | boolean | No | Validate all operations before applying any |

`operation` values: `edit`, `create`, `delete`, `rename`.

### `rollback`

Restore files from backups created by `apply_diff` or `batch_edit`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `backup_paths` | string[] | Yes | Backup file paths returned by the apply operations |

## Typical workflow

```
search_code_context  →  find the exact lines to change
generate_diff        →  produce a minimal diff (get diff_id)
validate_change      →  optional: check syntax/lint before applying
apply_diff           →  apply with automatic backup
rollback             →  undo if something went wrong
```

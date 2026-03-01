# bash-server

MCP server for secure shell command execution. Provides a single `bash` tool with a command blocklist, directory sandboxing, and timeout protection.

## Build

```bash
npm install
npm run build
```

## Configuration

The sandbox root path and blocked command list are configured in `src/index.ts`. By default execution is restricted to the user's home directory.

## Tool: `bash`

Execute a shell command.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | Shell command to execute |
| `type` | string | No | Hint: `file`, `git`, `npm`, `general` |
| `args` | string[] | No | Additional arguments appended to command |
| `cwd` | string | No | Working directory for this call |
| `setCwd` | string | No | Persist working directory for future calls |
| `timeout` | number | No | Max execution time in ms (default: 30000, max: 300000) |
| `env` | object | No | Additional environment variables |
| `shell` | string | No | Shell binary (default: `/bin/bash`) |

### Examples

```json
{ "command": "ls -la", "type": "file" }
```

```json
{ "command": "git log --oneline -10", "type": "git", "cwd": "/workspace/myrepo" }
```

```json
{ "command": "npm test", "type": "npm", "timeout": 120000 }
```

## Blocked commands

The server blocks commands that could damage the system or escalate privileges: `sudo`, `rm -rf /`, `dd`, `shred`, `mkfs`, `systemctl`, `iptables`, `apt`, `yum`, `ssh`, `scp`, and similar.

## Resources

- `bash://cwd` — Current persistent working directory
- `bash://security` — Active security policy and blocklist

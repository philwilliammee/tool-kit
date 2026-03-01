import { spawn } from 'child_process';
import { config, McpServerConfig } from './config';
import OpenAI from 'openai';

const LIST_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;

function jsonRpc<T>(serverCfg: McpServerConfig, method: string, params: object, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1_000_000);
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    const child = spawn(serverCfg.command, serverCfg.args, {
      cwd: serverCfg.cwd,
      env: { ...process.env, ...(serverCfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let settled = false;

    const done = (err?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(result as T);
    };

    const timer = setTimeout(() => done(new Error(`MCP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            if (msg.error) done(new Error(msg.error.message ?? 'MCP error'));
            else done(undefined, msg.result);
          }
        } catch { /* not a relevant JSON line */ }
      }
    });

    child.on('error', err => done(err));
    child.on('close', code => {
      if (!settled) done(new Error(`MCP process exited with code ${code} before responding`));
    });

    child.stdin.write(request);
  });
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

interface ToolsListResult {
  tools: McpTool[];
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
}

export class McpService {
  async listAllTools(): Promise<OpenAI.ChatCompletionTool[]> {
    const all: OpenAI.ChatCompletionTool[] = [];
    for (const [serverName, serverCfg] of Object.entries(config.mcpServers)) {
      try {
        const result = await jsonRpc<ToolsListResult>(serverCfg, 'tools/list', {}, LIST_TIMEOUT_MS);
        for (const tool of result.tools ?? []) {
          all.push({
            type: 'function',
            function: {
              name: `${serverName}_${tool.name}`,
              description: tool.description,
              parameters: tool.inputSchema as OpenAI.FunctionParameters,
            },
          });
        }
      } catch (err) {
        console.error(`[mcp] Failed to list tools from ${serverName}:`, (err as Error).message);
      }
    }
    return all;
  }

  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const separatorIdx = prefixedName.indexOf('_');
    if (separatorIdx === -1) throw new Error(`Invalid tool name (no server prefix): ${prefixedName}`);

    const serverName = prefixedName.slice(0, separatorIdx);
    const toolName = prefixedName.slice(separatorIdx + 1);
    const serverCfg = config.mcpServers[serverName];

    if (!serverCfg) throw new Error(`Unknown MCP server: ${serverName}`);

    const result = await jsonRpc<ToolCallResult>(
      serverCfg,
      'tools/call',
      { name: toolName, arguments: args },
      CALL_TIMEOUT_MS,
    );

    return (result.content ?? [])
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join('\n');
  }
}

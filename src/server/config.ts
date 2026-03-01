import * as path from 'path';
import * as fs from 'fs';

export interface McpServerConfig {
  command: string;
  args: string[];
  transport: 'stdio';
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpServersConfig {
  mcpServers: Record<string, McpServerConfig>;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function substituteVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
}

function loadMcpConfig(configPath: string): Record<string, McpServerConfig> {
  if (!fs.existsSync(configPath)) {
    throw new Error(`MCP config file not found: ${configPath}`);
  }
  const raw: McpServersConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const result: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(raw.mcpServers)) {
    result[name] = {
      ...server,
      args: server.args.map(substituteVars),
      cwd: server.cwd ? substituteVars(server.cwd) : undefined,
      env: server.env
        ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, substituteVars(v)]))
        : undefined,
    };
  }
  return result;
}

// Resolve MCP_ROOT before loading the MCP config so ${MCP_ROOT} substitution works.
const projectRoot = path.join(__dirname, '../../');
process.env.MCP_ROOT = process.env.MCP_ROOT ?? path.join(projectRoot, 'mcp');

const mcpConfigPath = process.env.MCP_CONFIG_PATH ?? path.join(projectRoot, 'config/mcp-servers.json');

export const config = {
  openai: {
    apiKey: requireEnv('OPENAI_API_KEY'),
    baseURL: requireEnv('OPENAI_BASE_URL'),
  },
  apiToken: requireEnv('API_TOKEN'),
  port: parseInt(process.env.PORT ?? '3333', 10),
  mcpServers: loadMcpConfig(mcpConfigPath),
};

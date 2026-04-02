import { config, McpServerConfig } from "./config";
import { McpConnection } from "./mcp-connection";
import OpenAI from "openai";

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
  private connections = new Map<string, McpConnection>();
  private toolCache: OpenAI.ChatCompletionTool[] | null = null;

  /** Connect all configured MCP servers in parallel. Call once at startup. */
  async init(): Promise<void> {
    const entries = Object.entries(config.mcpServers);
    await Promise.all(
      entries.map(async ([name, cfg]: [string, McpServerConfig]) => {
        const conn = new McpConnection(cfg);
        try {
          await conn.connect();
          this.connections.set(name, conn);
          console.error(`[mcp] Connected: ${name}`);
        } catch (err) {
          console.error(
            `[mcp] Failed to connect ${name}: ${(err as Error).message}`,
          );
        }
      }),
    );
  }

  /** List all tools across all servers. Cached after the first successful call. */
  async listAllTools(): Promise<OpenAI.ChatCompletionTool[]> {
    if (this.toolCache) return this.toolCache;

    const all: OpenAI.ChatCompletionTool[] = [];
    for (const [serverName, conn] of this.connections) {
      try {
        const result = await conn.send<ToolsListResult>("tools/list", {});
        for (const tool of result.tools ?? []) {
          all.push({
            type: "function",
            function: {
              name: `${serverName}_${tool.name}`,
              description: tool.description,
              parameters: tool.inputSchema as OpenAI.FunctionParameters,
            },
          });
        }
      } catch (err) {
        console.error(
          `[mcp] Failed to list tools from ${serverName}: ${(err as Error).message}`,
        );
      }
    }

    // Only cache when we have active connections; avoids permanently caching
    // an empty list if called before init() completes.
    if (this.connections.size > 0) {
      this.toolCache = all;
    }
    return all;
  }

  /** Invalidate the tool cache (e.g. after a reconnect). */
  invalidateToolCache(): void {
    this.toolCache = null;
  }

  /** Route a prefixed tool call (`serverName_toolName`) to the right connection. */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const separatorIdx = prefixedName.indexOf("_");
    if (separatorIdx === -1) {
      throw new Error(`Invalid tool name (no server prefix): ${prefixedName}`);
    }

    const serverName = prefixedName.slice(0, separatorIdx);
    const toolName = prefixedName.slice(separatorIdx + 1);
    const conn = this.connections.get(serverName);

    if (!conn) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    const result = await conn.send<ToolCallResult>("tools/call", {
      name: toolName,
      arguments: args,
    });

    return (result.content ?? [])
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("\n");
  }

  /** Gracefully close all connections. */
  async close(): Promise<void> {
    for (const [name, conn] of this.connections) {
      conn.close();
      console.error(`[mcp] Closed: ${name}`);
    }
    this.connections.clear();
    this.toolCache = null;
  }
}

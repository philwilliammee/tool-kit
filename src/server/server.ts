import express, { Request, Response, NextFunction } from "express";
import { config } from "./config";
import { McpService } from "./mcp.service";
import { AiService } from "./ai.service";

const app = express();
app.use(express.json());

// Module-level singletons — MCP connections are shared across all requests.
const mcp = new McpService();
const ai = new AiService(mcp);

// Connect MCP servers before accepting requests; non-fatal if a server fails.
const mcpReady = mcp.init().catch((err) =>
  console.error("[mcp] init error:", (err as Error).message),
);

// Graceful shutdown — close MCP connections before exiting.
async function shutdown(): Promise<void> {
  console.error("[server] Shutting down…");
  await mcp.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// Auth middleware
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== config.apiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Health check — no auth required (used by Docker HEALTHCHECK)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// List available MCP tools — used by /tools REPL command
app.get("/api/tools", requireAuth, async (_req: Request, res: Response) => {
  try {
    const tools = await mcp.listAllTools();
    res.json({ tools: tools.map((t) => ({ name: t.function.name, description: t.function.description })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Main streaming endpoint
app.post(
  "/api/chat/stream",
  requireAuth,
  async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();

    try {
      await ai.streamChat(req.body, res);
    } catch (err) {
      const msg = (err as Error).message;
      res.write(JSON.stringify({ type: "error", data: msg }) + "\n");
    } finally {
      res.end();
    }
  },
);

mcpReady.then(() => {
  app.listen(config.port, () => {
    console.log(`tool-kit server listening on port ${config.port}`);
  });
});

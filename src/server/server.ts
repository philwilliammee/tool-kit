import express, { Request, Response, NextFunction } from "express";
import { config } from "./config";
import { AiService } from "./ai.service";

const app = express();
app.use(express.json());

const ai = new AiService();

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

app.listen(config.port, () => {
  console.log(`tool-kit server listening on port ${config.port}`);
});

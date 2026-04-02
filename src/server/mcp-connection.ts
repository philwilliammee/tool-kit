import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { McpServerConfig } from "./config";

const CALL_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private alive = false;
  private reconnecting = false;

  constructor(private readonly cfg: McpServerConfig) {}

  get isAlive(): boolean {
    return this.alive;
  }

  async connect(): Promise<void> {
    this.child = spawn(this.cfg.command, this.cfg.args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.alive = true;
    this.buffer = "";

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          if (msg.id != null) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.error) {
                p.reject(new Error(msg.error.message ?? "MCP error"));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch {
          // not a JSON-RPC response line — ignore
        }
      }
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error(`[mcp:${this.cfg.command}] ${msg}`);
    });

    this.child.on("close", (code) => {
      this.alive = false;
      // Reject all pending requests
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new Error(`MCP process exited (code ${code}) before responding`),
        );
        this.pending.delete(id);
      }
      if (!this.reconnecting) {
        console.error(`[mcp] Process exited with code ${code}. Will reconnect on next call.`);
      }
    });

    this.child.on("error", (err) => {
      this.alive = false;
      console.error(`[mcp] Process error: ${err.message}`);
    });
  }

  async send<T>(method: string, params: object): Promise<T> {
    if (!this.alive) {
      await this.reconnect();
    }

    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        timer,
      });

      try {
        this.child!.stdin.write(request);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Failed to write to MCP stdin: ${(err as Error).message}`));
      }
    });
  }

  async reconnect(): Promise<void> {
    this.reconnecting = true;
    this.close();
    await this.connect();
    this.reconnecting = false;
    console.error(`[mcp] Reconnected.`);
  }

  close(): void {
    this.alive = false;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
  }
}

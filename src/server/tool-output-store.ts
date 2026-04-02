import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";

const INLINE_THRESHOLD = 8 * 1024; // 8 KB — outputs larger than this are stored to disk

/**
 * Stores large tool outputs to disk and returns a lightweight stub.
 * This prevents the LLM context from being flooded by verbose command output.
 * The agent can read specific sections of the stored file using bash line ranges.
 */
export class ToolOutputStore {
  private dir: string;

  constructor(sessionId: string) {
    // Sanitize sessionId to prevent path traversal — allow only safe characters
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid sessionId: contains unsafe characters`);
    }
    this.dir = path.join(
      os.homedir(),
      ".tool-kit-sessions",
      "tool-outputs",
      sessionId,
    );
  }

  /**
   * If content exceeds the inline threshold, write it to a file and return a stub.
   * Returns null if content is small enough to pass through unchanged.
   */
  maybeStore(toolName: string, content: string): string | null {
    if (Buffer.byteLength(content, "utf-8") <= INLINE_THRESHOLD) return null;

    fs.mkdirSync(this.dir, { recursive: true });

    const safeName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${safeName}-${uuidv4()}.txt`;
    const filePath = path.join(this.dir, fileName);
    fs.writeFileSync(filePath, content, "utf-8");

    const lines = content.split("\n");
    const kb = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);
    const preview = lines.slice(0, 20).join("\n");

    return (
      `[Large output stored at ${filePath} (${lines.length} lines, ${kb} KB).\n` +
      ` Read specific sections with bash: sed -n 'X,Yp' "${filePath}"\n` +
      ` First 20 lines preview:\n${preview}${lines.length > 20 ? `\n… (${lines.length - 20} more lines)` : ""}]`
    );
  }
}

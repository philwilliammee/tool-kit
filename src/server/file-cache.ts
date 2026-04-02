import * as fs from "fs";
import * as crypto from "crypto";

/**
 * Per-request file state cache. Tracks the content hash and mtime of files
 * that have been read during this session. When the AI requests the same file
 * again and it hasn't changed on disk, we return a lightweight stub instead of
 * re-sending the full content, saving tokens.
 */

interface CacheEntry {
  hash: string;
  mtime: number;
  lineCount: number;
  turn: number;
}

// Patterns for bash read commands — extract the file path argument.
// Tolerates flags (e.g. -n), numeric values (e.g. 50), and quoted paths.
// The path is captured as the final non-flag argument.
const BASH_READ_PATTERNS = [
  /^\s*cat\s+(?:-\S+\s+|\d+\s+)*(['"]?)([^\s'"]+)\1\s*$/,
  /^\s*head\s+(?:-\S+\s+|\d+\s+)*(['"]?)([^\s'"]+)\1\s*$/,
  /^\s*tail\s+(?:-\S+\s+|\d+\s+)*(['"]?)([^\s'"]+)\1\s*$/,
];

export class FileStateCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Attempt to return a stub for a file read.
   * Returns null if the file is not cached or has changed on disk.
   */
  tryStub(filePath: string, currentTurn: number): string | null {
    const entry = this.cache.get(filePath);
    if (!entry) return null;

    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === entry.mtime) {
        return (
          `[File cached from turn ${entry.turn} (${entry.lineCount} lines). ` +
          `Content unchanged since last read. ` +
          `Reference it directly or re-read to refresh.]`
        );
      }
      // File changed — invalidate
      this.cache.delete(filePath);
    } catch {
      // File no longer accessible — invalidate
      this.cache.delete(filePath);
    }

    return null;
  }

  /**
   * Cache the result of a file read operation.
   * Call this after the real MCP call returns content.
   */
  set(filePath: string, content: string, turn: number): void {
    try {
      const stat = fs.statSync(filePath);
      const hash = crypto.createHash("sha1").update(content).digest("hex");
      const lineCount = content.split("\n").length;
      this.cache.set(filePath, { hash, mtime: stat.mtimeMs, lineCount, turn });
    } catch {
      // If we can't stat the file now, don't cache — not a fatal error
    }
  }

  /**
   * Extract a file path from a tool call if it is a read operation.
   * Returns null for non-read tools or unrecognised argument shapes.
   */
  static extractPath(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    // file-editor search_code_context
    if (toolName === "file-editor_search_code_context") {
      return typeof args.file_path === "string" ? args.file_path : null;
    }

    // bash cat / head / tail
    if (toolName === "bash_bash") {
      const cmd = typeof args.command === "string" ? args.command.trim() : "";
      for (const pattern of BASH_READ_PATTERNS) {
        const m = pattern.exec(cmd);
        if (m) {
          // Last capture group is the path (after optional flag groups)
          const filePath = m[m.length - 1];
          return filePath ?? null;
        }
      }
    }

    return null;
  }
}

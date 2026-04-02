import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";

const SESSION_DIR = path.join(os.homedir(), ".tool-kit-sessions");
const MAX_AGE_DAYS = 7;
const MAX_MESSAGES_TO_AI = 50;
const MAX_OUTPUT_BYTES = 10_240;

/**
 * Discriminates the purpose of a message so compaction and display
 * can treat them differently without parsing content.
 *
 * - user / assistant  : normal conversation turns
 * - system            : injected context (hooks, skills, env info)
 * - compact_summary   : LLM-generated compaction summary
 * - compact_boundary  : tombstone marking where a compaction occurred
 */
export type MessageType =
  | "user"
  | "assistant"
  | "system"
  | "compact_summary"
  | "compact_boundary";

export interface SessionMessage {
  timestamp: string;
  role: "user" | "assistant" | "system";
  type: MessageType;
  content: string;
}

export interface ToolCallRecord {
  timestamp: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: string;
  resultLength: number;
}

export interface SkillInjection {
  name: string;
  content: string; // fully rendered [skill: name]\n...
  injectedAt: string;
}

export interface Session {
  sessionId: string;
  sessionKey: string;
  workingDirectory: string;
  startedAt: string;
  lastActivity: string;
  messages: SessionMessage[];
  toolCalls: ToolCallRecord[];
  filesViewed: string[];
  skillInjections: SkillInjection[];
  totalTokens: number;
  /** Path to the JSONL archive written by the last /compact, if any. */
  archivePath?: string;
  /** Last usage breakdown for /cost display. */
  lastUsage?: { promptTokens: number; completionTokens: number };
}

function sessionKey(cwd: string): string {
  const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const date = new Date().toISOString().slice(0, 10);
  return `${hash}_${date}`;
}

function sessionPath(key: string): string {
  return path.join(SESSION_DIR, `${key}.json`);
}

export function loadSession(cwd: string): Session {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const key = sessionKey(cwd);
  const filePath = sessionPath(key);
  if (fs.existsSync(filePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Session;
      if (!saved.skillInjections) saved.skillInjections = [];
      if (saved.totalTokens === undefined) saved.totalTokens = 0;
      // Backward compat: add type to messages that predate the type field
      saved.messages = saved.messages.map((m) =>
        m.type ? m : { ...m, type: m.role as MessageType },
      );
      return saved;
    } catch {
      /* fall through to create new */
    }
  }
  return {
    sessionId: uuidv4(),
    sessionKey: key,
    workingDirectory: cwd,
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    messages: [],
    toolCalls: [],
    filesViewed: [],
    skillInjections: [],
    totalTokens: 0,
  };
}

export function saveSession(session: Session): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  session.lastActivity = new Date().toISOString();
  fs.writeFileSync(
    sessionPath(session.sessionKey),
    JSON.stringify(session, null, 2),
  );
}

export function cleanupOldSessions(): void {
  if (!fs.existsSync(SESSION_DIR)) return;
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  for (const file of fs.readdirSync(SESSION_DIR)) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(SESSION_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

export function addMessage(
  session: Session,
  role: "user" | "assistant" | "system",
  content: string,
  type?: MessageType,
): void {
  session.messages.push({
    timestamp: new Date().toISOString(),
    role,
    type: type ?? (role as MessageType),
    content,
  });
}

/**
 * Write current messages to a JSONL archive file and return its path.
 * Each line is: { turn: N, role, type, content, timestamp }
 */
export function archiveSession(session: Session): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(
    SESSION_DIR,
    `${session.sessionKey}-archive-${ts}.jsonl`,
  );
  const lines = session.messages.map((m, i) =>
    JSON.stringify({ turn: i + 1, role: m.role, type: m.type, content: m.content, timestamp: m.timestamp }),
  );
  fs.writeFileSync(archivePath, lines.join("\n") + "\n");
  return archivePath;
}

export function addToolCall(
  session: Session,
  tool: string,
  args: Record<string, unknown>,
  result: string,
): void {
  const truncated =
    result.length > MAX_OUTPUT_BYTES
      ? result.slice(0, MAX_OUTPUT_BYTES) + "…"
      : result;
  session.toolCalls.push({
    timestamp: new Date().toISOString(),
    tool,
    arguments: args,
    result: truncated,
    resultLength: result.length,
  });
}

// Returns the last N messages as OpenAI message params for the API request.
// compact_boundary messages are stripped (they are meta-markers, not context).
export function getApiMessages(
  session: Session,
): OpenAI.ChatCompletionMessageParam[] {
  return session.messages
    .filter((m) => m.type !== "compact_boundary")
    .slice(-MAX_MESSAGES_TO_AI)
    .map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));
}

export function sessionStats(session: Session): string {
  return [
    `Session: ${session.sessionKey}`,
    `Started: ${new Date(session.startedAt).toLocaleString()}`,
    `Messages: ${session.messages.length}`,
    `Tool calls: ${session.toolCalls.length}`,
    `Files viewed: ${session.filesViewed.length}`,
    `Tokens (last call): ${session.totalTokens.toLocaleString()}`,
  ].join("\n");
}

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';

const SESSION_DIR = path.join(os.homedir(), '.tool-kit-sessions');
const MAX_AGE_DAYS = 7;
const MAX_MESSAGES_TO_AI = 50;
const MAX_OUTPUT_BYTES = 10_240;

export interface SessionMessage {
  timestamp: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  timestamp: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: string;
  resultLength: number;
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
}

function sessionKey(cwd: string): string {
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
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
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Session;
    } catch { /* fall through to create new */ }
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
  };
}

export function saveSession(session: Session): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  session.lastActivity = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.sessionKey), JSON.stringify(session, null, 2));
}

export function cleanupOldSessions(): void {
  if (!fs.existsSync(SESSION_DIR)) return;
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  for (const file of fs.readdirSync(SESSION_DIR)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(SESSION_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
  }
}

export function addMessage(session: Session, role: 'user' | 'assistant', content: string): void {
  session.messages.push({ timestamp: new Date().toISOString(), role, content });
}

export function addToolCall(session: Session, tool: string, args: Record<string, unknown>, result: string): void {
  const truncated = result.length > MAX_OUTPUT_BYTES ? result.slice(0, MAX_OUTPUT_BYTES) + '…' : result;
  session.toolCalls.push({
    timestamp: new Date().toISOString(),
    tool,
    arguments: args,
    result: truncated,
    resultLength: result.length,
  });
}

// Returns the last N messages as OpenAI message params for the API request
export function getApiMessages(session: Session): OpenAI.ChatCompletionMessageParam[] {
  return session.messages.slice(-MAX_MESSAGES_TO_AI).map(m => ({
    role: m.role,
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
  ].join('\n');
}

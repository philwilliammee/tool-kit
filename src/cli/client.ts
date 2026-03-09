import axios from 'axios';
import OpenAI from 'openai';

export interface ToolCallChunk {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
}

export interface StreamCallbacks {
  onContent(delta: string): void;
  onToolCall(chunk: ToolCallChunk): void;
  onToolResult(result: ToolResult): void;
  onComplete(): void;
  onError(message: string): void;
}

export interface QueryOptions {
  serverUrl: string;
  token: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  model: string;
  callbacks: StreamCallbacks;
  workingDirectory?: string;
}

type StreamChunk =
  | { type: 'content'; data: string }
  | { type: 'tool_call'; data: ToolCallChunk }
  | { type: 'tool_result'; data: ToolResult }
  | { type: 'complete'; data: null }
  | { type: 'error'; data: string };

export async function streamQuery(opts: QueryOptions): Promise<void> {
  const { serverUrl, token, messages, model, callbacks, workingDirectory } = opts;

  const response = await axios.post(
    `${serverUrl}/api/chat/stream`,
    { messages, model, workingDirectory },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      responseType: 'stream',
      timeout: 0,
    },
  );

  await new Promise<void>((resolve, reject) => {
    let buffer = '';

    response.data.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as StreamChunk;
          switch (parsed.type) {
            case 'content':
              callbacks.onContent(parsed.data);
              break;
            case 'tool_call':
              callbacks.onToolCall(parsed.data);
              break;
            case 'tool_result':
              callbacks.onToolResult(parsed.data);
              break;
            case 'complete':
              callbacks.onComplete();
              resolve();
              break;
            case 'error':
              callbacks.onError(parsed.data);
              resolve();
              break;
          }
        } catch { /* malformed chunk */ }
      }
    });

    response.data.on('end', resolve);
    response.data.on('error', reject);
  });
}

import OpenAI from 'openai';
import { Response } from 'express';
import { config } from './config';
import { McpService } from './mcp.service';

const MAX_ITERATIONS = 20;

export interface ChatRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

type StreamChunk =
  | { type: 'content'; data: string }
  | { type: 'tool_call'; data: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: 'tool_result'; data: { toolCallId: string; name: string; content: string } }
  | { type: 'complete'; data: null }
  | { type: 'error'; data: string };

function emit(res: Response, chunk: StreamChunk): void {
  res.write(JSON.stringify(chunk) + '\n');
}

export class AiService {
  private openai: OpenAI;
  private mcp: McpService;

  constructor() {
    this.openai = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL });
    this.mcp = new McpService();
  }

  async streamChat(req: ChatRequest, res: Response): Promise<void> {
    const model = req.model ?? 'anthropic.claude-4.5-sonnet';
    const temperature = req.temperature ?? 0.7;
    const maxTokens = req.maxTokens ?? 4096;
    const messages: OpenAI.ChatCompletionMessageParam[] = [...req.messages];

    let tools: OpenAI.ChatCompletionTool[] = [];
    try {
      tools = await this.mcp.listAllTools();
    } catch (err) {
      console.error('[ai] Failed to load MCP tools:', (err as Error).message);
    }

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let finishReason: string | null = null;
      const accumulatedCalls = new Map<number, { id: string; name: string; arguments: string }>();

      try {
        const stream = await this.openai.chat.completions.create({
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          temperature,
          max_tokens: maxTokens,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const reason = chunk.choices[0]?.finish_reason;
          if (reason) finishReason = reason;

          if (delta?.content) {
            emit(res, { type: 'content', data: delta.content });
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!accumulatedCalls.has(tc.index)) {
                accumulatedCalls.set(tc.index, { id: '', name: '', arguments: '' });
              }
              const acc = accumulatedCalls.get(tc.index)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            }
          }
        }
      } catch (err) {
        emit(res, { type: 'error', data: (err as Error).message });
        return;
      }

      if (finishReason === 'stop' || accumulatedCalls.size === 0) {
        emit(res, { type: 'complete', data: null });
        return;
      }

      if (finishReason === 'tool_calls') {
        const toolCalls = Array.from(accumulatedCalls.values());

        // Append assistant turn with tool_calls
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute each tool and stream results
        for (const tc of toolCalls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.arguments); } catch { /* empty */ }

          emit(res, { type: 'tool_call', data: { id: tc.id, name: tc.name, arguments: args } });

          let content: string;
          try {
            content = await this.mcp.callTool(tc.name, args);
          } catch (err) {
            content = `Error: ${(err as Error).message}`;
          }

          emit(res, { type: 'tool_result', data: { toolCallId: tc.id, name: tc.name, content } });

          messages.push({ role: 'tool', tool_call_id: tc.id, content });
        }
      }
    }

    // Reached iteration ceiling
    emit(res, { type: 'complete', data: null });
  }
}

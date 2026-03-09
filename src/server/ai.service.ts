import OpenAI from 'openai';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { McpService } from './mcp.service';
import { HooksService } from './hooks.service';

const MAX_ITERATIONS = 20;

export interface ChatRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
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
    const cwd = req.workingDirectory ?? process.cwd();
    const sessionId = uuidv4();
    const messages: OpenAI.ChatCompletionMessageParam[] = [...req.messages];

    const hooks = new HooksService(cwd);

    let tools: OpenAI.ChatCompletionTool[] = [];
    try {
      tools = await this.mcp.listAllTools();
    } catch (err) {
      console.error('[ai] Failed to load MCP tools:', (err as Error).message);
    }

    // Determine user message text for hook input
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userMessage = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

    // UserPromptSubmit hook
    const promptHookOut = await hooks.fire('UserPromptSubmit', {
      event: 'UserPromptSubmit',
      session_id: sessionId,
      working_directory: cwd,
      message: userMessage,
    });
    if (promptHookOut.contextInjection) {
      messages.push({ role: 'system', content: `[hook: UserPromptSubmit] ${promptHookOut.contextInjection}` });
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
        // Stop hook — fire async, no awaiting
        hooks.fire('Stop', { event: 'Stop', session_id: sessionId, working_directory: cwd }).catch(() => {});
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

          // PreToolUse hook
          const preOut = await hooks.fire(
            'PreToolUse',
            { event: 'PreToolUse', session_id: sessionId, working_directory: cwd, tool_name: tc.name, tool_input: args },
            tc.name,
          );

          let content: string;
          if (preOut.decision === 'block') {
            content = `[blocked] ${preOut.reason ?? 'Tool call blocked by hook.'}`;
          } else {
            // If PreToolUse injected context, add it before calling the tool
            if (preOut.contextInjection) {
              messages.push({ role: 'system', content: `[hook: PreToolUse] ${preOut.contextInjection}` });
            }

            try {
              content = await this.mcp.callTool(tc.name, args);

              // PostToolUse hook
              const postOut = await hooks.fire(
                'PostToolUse',
                { event: 'PostToolUse', session_id: sessionId, working_directory: cwd, tool_name: tc.name, tool_input: args, tool_result: content },
                tc.name,
              );
              if (postOut.contextInjection) {
                content += `\n[hook: PostToolUse] ${postOut.contextInjection}`;
              }
            } catch (err) {
              const errorMsg = (err as Error).message;
              content = `Error: ${errorMsg}`;

              // PostToolUseFailure hook — fire async
              hooks.fire(
                'PostToolUseFailure',
                { event: 'PostToolUseFailure', session_id: sessionId, working_directory: cwd, tool_name: tc.name, tool_input: args, error: errorMsg },
                tc.name,
              ).catch(() => {});
            }
          }

          emit(res, { type: 'tool_result', data: { toolCallId: tc.id, name: tc.name, content } });

          messages.push({ role: 'tool', tool_call_id: tc.id, content });
        }
      }
    }

    // Reached iteration ceiling
    emit(res, { type: 'complete', data: null });
    hooks.fire('Stop', { event: 'Stop', session_id: sessionId, working_directory: cwd }).catch(() => {});
  }
}

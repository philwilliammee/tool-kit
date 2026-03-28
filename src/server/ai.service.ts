import OpenAI from "openai";
import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { config } from "./config";
import { McpService } from "./mcp.service";
import { HooksService } from "./hooks.service";
import { SkillsService } from "./skills.service";

const MAX_ITERATIONS = 50;

export interface ChatRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  workingDirectory?: string;
  isNewSession?: boolean;
  sessionId?: string;
}

type StreamChunk =
  | { type: "content"; data: string }
  | {
      type: "tool_call";
      data: { id: string; name: string; arguments: Record<string, unknown> };
    }
  | {
      type: "tool_result";
      data: { toolCallId: string; name: string; content: string };
    }
  | { type: "skill_invoke"; data: { name: string; content: string } }
  | {
      type: "complete";
      data: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      } | null;
    }
  | { type: "error"; data: string };

function emit(res: Response, chunk: StreamChunk): void {
  res.write(JSON.stringify(chunk) + "\n");
}

export class AiService {
  private openai: OpenAI;
  private mcp: McpService;

  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseURL,
    });
    this.mcp = new McpService();
  }

  async streamChat(req: ChatRequest, res: Response): Promise<void> {
    const model = req.model ?? "anthropic.claude-4.5-sonnet";
    const temperature = req.temperature ?? 0.7;
    const maxTokens = req.maxTokens ?? 4096;
    const cwd = req.workingDirectory ?? process.cwd();
    const sessionId = req.sessionId ?? uuidv4();
    const messages: OpenAI.ChatCompletionMessageParam[] = [...req.messages];

    const hooks = new HooksService(cwd);
    const skillSvc = new SkillsService(cwd);

    // Register skill-scoped hooks for any skills already injected in the messages
    for (const msg of messages) {
      if (msg.role === "system" && typeof msg.content === "string") {
        const match = msg.content.match(/^\[skill: ([a-z0-9-]+)\]/);
        if (match) {
          const skill = skillSvc.get(match[1]);
          if (skill?.frontmatter.hooks) {
            hooks.registerSkillHooks(
              skill.dirPath,
              skill.frontmatter.hooks as Record<string, unknown>,
            );
          }
        }
      }
    }

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    let tools: OpenAI.ChatCompletionTool[] = [];
    try {
      tools = await this.mcp.listAllTools();
    } catch (err) {
      console.error("[ai] Failed to load MCP tools:", (err as Error).message);
    }

    // Add Skill tool if any auto-invocable skills exist
    const skillTool = skillSvc.buildSkillTool();
    if (skillTool) tools.push(skillTool);

    // SessionStart hook — fires once for new or resumed sessions
    if (req.isNewSession !== false) {
      const sessionStartOut = await hooks.fire("SessionStart", {
        event: "SessionStart",
        session_id: sessionId,
        working_directory: cwd,
        resumed: false,
      });
      if (sessionStartOut.contextInjection) {
        messages.push({
          role: "system",
          content: `[hook: SessionStart] ${sessionStartOut.contextInjection}`,
        });
      }
    }

    // Determine user message text for hook input
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const userMessage =
      typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

    // UserPromptSubmit hook
    const promptHookOut = await hooks.fire("UserPromptSubmit", {
      event: "UserPromptSubmit",
      session_id: sessionId,
      working_directory: cwd,
      message: userMessage,
    });
    if (promptHookOut.contextInjection) {
      messages.push({
        role: "system",
        content: `[hook: UserPromptSubmit] ${promptHookOut.contextInjection}`,
      });
    }

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      let finishReason: string | null = null;
      const accumulatedCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      try {
        const stream = await this.openai.chat.completions.create({
          model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          stream_options: { include_usage: true },
          temperature,
          max_tokens: maxTokens,
        });

        for await (const chunk of stream) {
          if (chunk.usage) {
            totalPromptTokens += chunk.usage.prompt_tokens ?? 0;
            totalCompletionTokens += chunk.usage.completion_tokens ?? 0;
          }

          const delta = chunk.choices[0]?.delta;
          const reason = chunk.choices[0]?.finish_reason;
          if (reason) finishReason = reason;

          if (delta?.content) {
            emit(res, { type: "content", data: delta.content });
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!accumulatedCalls.has(tc.index)) {
                accumulatedCalls.set(tc.index, {
                  id: "",
                  name: "",
                  arguments: "",
                });
              }
              const acc = accumulatedCalls.get(tc.index)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments)
                acc.arguments += tc.function.arguments;
            }
          }
        }
      } catch (err) {
        emit(res, { type: "error", data: (err as Error).message });
        return;
      }

      if (finishReason === "stop" || accumulatedCalls.size === 0) {
        const usage =
          totalPromptTokens > 0 || totalCompletionTokens > 0
            ? {
                promptTokens: totalPromptTokens,
                completionTokens: totalCompletionTokens,
                totalTokens: totalPromptTokens + totalCompletionTokens,
              }
            : null;
        emit(res, { type: "complete", data: usage });
        hooks
          .fire("Stop", {
            event: "Stop",
            session_id: sessionId,
            working_directory: cwd,
          })
          .catch(() => {});
        return;
      }

      if (finishReason === "tool_calls") {
        const toolCalls = Array.from(accumulatedCalls.values());

        // Append assistant turn with tool_calls
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        // Execute each tool and stream results
        for (const tc of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments);
          } catch {
            /* empty */
          }

          emit(res, {
            type: "tool_call",
            data: { id: tc.id, name: tc.name, arguments: args },
          });

          let content: string;

          // ── Skill tool ────────────────────────────────────────────────────────
          if (tc.name === "Skill") {
            const skillName = typeof args.name === "string" ? args.name : "";
            const skillArgs =
              typeof args.arguments === "string" ? args.arguments : "";
            const rendered = skillSvc.render(skillName, skillArgs, {
              args: skillArgs,
              sessionId,
              cwd,
            });

            if (!rendered) {
              content = `[error] Skill not found: ${skillName}`;
            } else {
              // Activate skill-scoped hooks
              const skill = skillSvc.get(skillName);
              if (skill?.frontmatter.hooks) {
                hooks.registerSkillHooks(
                  skill.dirPath,
                  skill.frontmatter.hooks as Record<string, unknown>,
                );
              }
              // Notify CLI so it can persist the injection
              emit(res, {
                type: "skill_invoke",
                data: { name: skillName, content: rendered },
              });
              // Tool result = rendered content (LLM gets skill context immediately)
              content = rendered;
            }

            // ── MCP tools ─────────────────────────────────────────────────────────
          } else {
            // PreToolUse hook
            const preOut = await hooks.fire(
              "PreToolUse",
              {
                event: "PreToolUse",
                session_id: sessionId,
                working_directory: cwd,
                tool_name: tc.name,
                tool_input: args,
              },
              tc.name,
            );

            if (preOut.decision === "block") {
              content = `[blocked] ${preOut.reason ?? "Tool call blocked by hook."}`;
            } else {
              if (preOut.contextInjection) {
                messages.push({
                  role: "system",
                  content: `[hook: PreToolUse] ${preOut.contextInjection}`,
                });
              }

              try {
                content = await this.mcp.callTool(tc.name, args);

                // PostToolUse hook
                const postOut = await hooks.fire(
                  "PostToolUse",
                  {
                    event: "PostToolUse",
                    session_id: sessionId,
                    working_directory: cwd,
                    tool_name: tc.name,
                    tool_input: args,
                    tool_result: content,
                  },
                  tc.name,
                );
                if (postOut.contextInjection) {
                  content += `\n[hook: PostToolUse] ${postOut.contextInjection}`;
                }
              } catch (err) {
                const errorMsg = (err as Error).message;
                content = `Error: ${errorMsg}`;
                hooks
                  .fire(
                    "PostToolUseFailure",
                    {
                      event: "PostToolUseFailure",
                      session_id: sessionId,
                      working_directory: cwd,
                      tool_name: tc.name,
                      tool_input: args,
                      error: errorMsg,
                    },
                    tc.name,
                  )
                  .catch(() => {});
              }
            }
          }

          emit(res, {
            type: "tool_result",
            data: { toolCallId: tc.id, name: tc.name, content },
          });
          messages.push({ role: "tool", tool_call_id: tc.id, content });
        }
      }
    }

    // Reached iteration ceiling
    const usage =
      totalPromptTokens > 0 || totalCompletionTokens > 0
        ? {
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens: totalPromptTokens + totalCompletionTokens,
          }
        : null;
    emit(res, { type: "complete", data: usage });
    hooks
      .fire("Stop", {
        event: "Stop",
        session_id: sessionId,
        working_directory: cwd,
      })
      .catch(() => {});
  }
}

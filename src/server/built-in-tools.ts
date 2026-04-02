import OpenAI from "openai";

/**
 * The Agent built-in tool allows the LLM to spawn a sub-agent to handle
 * a focused task. The sub-agent runs silently to completion and returns
 * its final answer as a tool result string.
 */
export const AGENT_TOOL: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "Agent",
    description:
      "Run a sub-agent to handle a focused, self-contained task. " +
      "The sub-agent has access to all the same tools (bash, file-editor, octokit). " +
      "It runs to completion and returns its final answer. " +
      "Use this to parallelize independent tasks or isolate a task in its own context.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task or question for the sub-agent to work on.",
        },
        model: {
          type: "string",
          description:
            "Optional model override for the sub-agent (e.g. a faster/cheaper model for simple tasks).",
        },
      },
      required: ["prompt"],
    },
  },
};

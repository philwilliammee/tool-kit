#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BashService } from "./bash-service.js";
import { BashInput } from "./types.js";

const bashService = new BashService();

// Create the MCP server
const server = new Server(
  {
    name: "bash-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "bash",
        description: `Secure shell command execution with comprehensive safety controls.

🔒 SECURITY FEATURES:
- Blocklist-based command filtering (blocks dangerous system commands)
- Directory sandboxing (restricted to /home/ds123/)
- Timeout protection (30s default, 5min max)
- Command validation and logging

✅ SUPPORTED OPERATIONS:
- File management (ls, cat, find, grep, etc.)
- Git operations (status, add, commit, push, etc.)
- NPM/Node.js tasks (install, build, test, etc.)
- Text processing (sed, awk, sort, uniq, etc.)
- Development tools (compiling, linting, etc.)

❌ BLOCKED OPERATIONS:
- System administration (sudo, systemctl, etc.)
- Network security (iptables, firewall, etc.)
- Package management (apt, yum, etc.)
- Dangerous file operations (dd, shred, etc.)
- Remote access (ssh, scp, etc.)`,
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute (required)",
              minLength: 1,
              maxLength: 2000,
            },
            type: {
              type: "string",
              enum: ["file", "git", "npm", "general"],
              description:
                "Command category for enhanced validation and logging",
              default: "general",
            },
            args: {
              type: "array",
              items: {
                type: "string",
                maxLength: 500,
              },
              maxItems: 50,
              description:
                "Additional command arguments as separate array items",
            },
            cwd: {
              type: "string",
              description:
                "Working directory for this command only (temporary override)",
              maxLength: 500,
            },
            setCwd: {
              type: "string",
              description:
                "Set persistent working directory for all future commands",
              maxLength: 500,
            },
            timeout: {
              type: "number",
              description: "Maximum execution time in milliseconds",
              default: 30000,
              minimum: 1000,
              maximum: 300000,
            },
            env: {
              type: "object",
              description: "Additional environment variables for this command",
              additionalProperties: {
                type: "string",
                maxLength: 1000,
              },
              maxProperties: 10,
            },
            shell: {
              type: "string",
              enum: ["/bin/sh", "/bin/bash", "/bin/dash"],
              description: "Shell to use for command execution",
              default: "/bin/sh",
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "bash": {
      // Validate required parameters
      if (
        !args ||
        typeof args !== "object" ||
        !args.command ||
        typeof args.command !== "string"
      ) {
        throw new Error(
          "Invalid arguments: 'command' parameter is required and must be a string",
        );
      }

      const input: BashInput = {
        command: args.command,
        type: (args.type as "file" | "git" | "npm" | "general") || "general",
        args: Array.isArray(args.args) ? (args.args as string[]) : undefined,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        setCwd: typeof args.setCwd === "string" ? args.setCwd : undefined,
        timeout: typeof args.timeout === "number" ? args.timeout : undefined,
        env:
          args.env && typeof args.env === "object"
            ? (args.env as Record<string, string>)
            : undefined,
        shell:
          (args.shell as "/bin/sh" | "/bin/bash" | "/bin/dash") || "/bin/sh",
      };

      const result = await bashService.executeCommand(input);

      // Format output for display
      let output = "";

      if (result.stdout) {
        output += `📤 **Output:**\n\`\`\`\n${result.stdout}\`\`\`\n\n`;
      }

      if (result.stderr) {
        output += `⚠️ **Error Output:**\n\`\`\`\n${result.stderr}\`\`\`\n\n`;
      }

      output += `📊 **Execution Details:**\n`;
      output += `- Exit Code: ${result.exitCode}\n`;
      output += `- Working Directory: ${result.pwd}\n`;
      output += `- Execution Time: ${result.executionTime}ms\n`;
      output += `- Command Type: ${result.commandType}\n`;
      output += `- Shell Used: ${result.shellUsed}\n`;

      if (result.error) {
        output += `\n❌ **Status:** Command failed\n`;
        if (result.message) {
          output += `**Error:** ${result.message}\n`;
        }
      } else {
        output += `\n✅ **Status:** Command completed successfully\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Resource handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "bash://cwd",
        mimeType: "text/plain",
        name: "Current Working Directory",
        description:
          "The current persistent working directory for bash commands",
      },
      {
        uri: "bash://security",
        mimeType: "text/plain",
        name: "Security Configuration",
        description: "List of blocked commands and security policies",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  switch (uri) {
    case "bash://cwd":
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `Current working directory: ${bashService.getCurrentWorkingDirectory()}`,
          },
        ],
      };
    case "bash://security":
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: `Bash Server Security Configuration:

🔒 SANDBOX: Commands restricted to /home/ds123/ directory
⏱️ TIMEOUT: 30 second default, 5 minute maximum
🚫 BLOCKED COMMANDS: System admin, network security, package management, dangerous operations
✅ ALLOWED: File operations, git, npm, development tools, text processing

For detailed security information, see the source code security.ts file.`,
          },
        ],
      };
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});

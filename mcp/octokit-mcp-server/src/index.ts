#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { OctokitService } from "./octokit-service.js";
import { GitService } from "./git-service.js";
import { GitHubOperation } from "./types.js";

const octokitService = new OctokitService();
const gitService = new GitService();

// Define available tools
const tools: Tool[] = [
  {
    name: "github_api",
    description:
      "Execute GitHub API operations using Octokit. Supports any GitHub REST API endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            'The GitHub API operation to perform (e.g., "GET /repos/{owner}/{repo}")',
        },
        parameters: {
          type: "object",
          description:
            'Parameters for the operation (e.g., { owner: "octokit", repo: "octokit.js" })',
          properties: {},
        },
      },
      required: ["operation"],
    },
  },
  {
    name: "github_get_repo",
    description: "Get information about a specific GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_list_issues",
    description: "List issues for a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Issue state filter (default: open)",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        title: {
          type: "string",
          description: "Issue title",
        },
        body: {
          type: "string",
          description: "Issue body/description",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Array of label names",
        },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "github_list_pulls",
    description: "List pull requests for a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Pull request state filter (default: open)",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_create_pull",
    description: "Create a new pull request in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        title: {
          type: "string",
          description: "Pull request title",
        },
        head: {
          type: "string",
          description:
            'The name of the branch where your changes are implemented (e.g., "feature-branch" or "username:feature-branch" for forks)',
        },
        base: {
          type: "string",
          description:
            'The name of the branch you want the changes pulled into (e.g., "main" or "develop")',
        },
        body: {
          type: "string",
          description: "Pull request body/description",
        },
        draft: {
          type: "boolean",
          description:
            "Whether to create the pull request as a draft (default: false)",
        },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "github_search_repos",
    description: "Search for GitHub repositories",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Search query (e.g., "language:javascript stars:>1000")',
        },
        sort: {
          type: "string",
          enum: ["stars", "forks", "updated"],
          description: "Sort field",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort order",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "github_get_user",
    description: "Get information about the authenticated user",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "github_git_clone",
    description:
      "Clone a GitHub repository to a local directory using token authentication. The target path must be under WORKSPACE_ROOT.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        targetDir: {
          type: "string",
          description: "Absolute path to clone into",
        },
      },
      required: ["owner", "repo", "targetDir"],
    },
  },
  {
    name: "github_git_pull",
    description:
      "Pull the latest changes in an existing local repository. The path must be under WORKSPACE_ROOT.",
    inputSchema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "Absolute path to the local repository",
        },
      },
      required: ["dir"],
    },
  },
  {
    name: "github_git_push",
    description:
      "Push a branch to GitHub using token authentication. The path must be under WORKSPACE_ROOT.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        dir: {
          type: "string",
          description: "Absolute path to the local repository",
        },
        branch: {
          type: "string",
          description: "Branch name to push",
        },
      },
      required: ["owner", "repo", "dir", "branch"],
    },
  },
];

// Helper function to validate GitHub API operation parameters
function validateGitHubOperation(args: any): GitHubOperation {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid arguments: expected an object");
  }

  if (!args.operation || typeof args.operation !== "string") {
    throw new Error("Invalid operation: expected a string");
  }

  return {
    operation: args.operation,
    parameters: args.parameters || {},
  };
}

// Helper function to validate and provide fallbacks for GitHub parameters
function validateGitHubParams(args: any): {
  owner: string;
  repo: string;
  [key: string]: any;
} {
  const defaultOwner = "CornellSASIT";

  // If owner is missing or invalid, use fallback
  let owner = args.owner;
  if (!owner || typeof owner !== "string" || owner.trim() === "") {
    console.log(`⚠️ Invalid or missing owner, using fallback: ${defaultOwner}`);
    owner = defaultOwner;
  }

  // If repo is missing or invalid, throw an error - don't use fallback
  let repo = args.repo;
  if (!repo || typeof repo !== "string" || repo.trim() === "") {
    throw new Error(
      `Repository name is required and cannot be empty. Please specify the 'repo' parameter.`,
    );
  }

  console.log(`✅ Using GitHub repository: ${owner}/${repo}`);

  return {
    ...args,
    owner,
    repo,
  };
}

// Helper function to execute tools
async function executeTool(name: string, args: any) {
  try {
    switch (name) {
      case "github_api": {
        const operation = validateGitHubOperation(args);
        return await octokitService.executeOperation(operation);
      }

      case "github_get_repo": {
        const validated = validateGitHubParams(args);
        const { owner, repo } = validated;
        return await octokitService.getRepository(owner, repo);
      }

      case "github_list_issues": {
        const validated = validateGitHubParams(args);
        const { owner, repo, state } = validated;
        return await octokitService.listIssues(owner, repo, state);
      }

      case "github_create_issue": {
        const validated = validateGitHubParams(args);
        const { owner, repo, title, body, labels } = validated;
        return await octokitService.createIssue(
          owner,
          repo,
          title,
          body,
          labels,
        );
      }

      case "github_list_pulls": {
        const validated = validateGitHubParams(args);
        const { owner, repo, state } = validated;
        return await octokitService.listPullRequests(owner, repo, state);
      }

      case "github_create_pull": {
        const validated = validateGitHubParams(args);
        const { owner, repo, title, head, base, body, draft } = validated;
        return await octokitService.createPullRequest(
          owner,
          repo,
          title,
          head,
          base,
          body,
          draft,
        );
      }

      case "github_search_repos": {
        const { query, sort, order } = args as {
          query: string;
          sort?: "stars" | "forks" | "updated";
          order?: "asc" | "desc";
        };
        return await octokitService.searchRepositories(query, sort, order);
      }

      case "github_get_user": {
        return await octokitService.getUser();
      }

      case "github_git_clone": {
        const { owner, repo, targetDir } = args as {
          owner: string;
          repo: string;
          targetDir: string;
        };
        return gitService.clone(owner, repo, targetDir);
      }

      case "github_git_pull": {
        const { dir } = args as {
          dir: string;
        };
        return gitService.pull(dir);
      }

      case "github_git_push": {
        const { owner, repo, dir, branch } = args as {
          owner: string;
          repo: string;
          dir: string;
          branch: string;
        };
        return gitService.push(owner, repo, dir, branch);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    console.error(`❌ Error executing tool ${name}:`, errorMessage);
    return { error: true, message: errorMessage };
  }
}

// Create MCP server
const server = new Server(
  {
    name: "octokit-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await executeTool(name, args);

    // Check if the result is an error object
    if (
      result &&
      typeof result === "object" &&
      "error" in result &&
      result.error
    ) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${
              "message" in result ? result.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }

    // Return successful result
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Determine transport type from environment
const transportType = process.env.MCP_TRANSPORT || "stdio";
const port = parseInt(process.env.MCP_PORT || "3006", 10);

async function main() {
  if (transportType === "sse") {
    // SSE transport with Express server
    const app = express();

    // Enhanced CORS middleware for MCP
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control",
      );
      res.header("Access-Control-Allow-Credentials", "true");
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    app.use(express.json());

    // Health check endpoint
    app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        server: "octokit-mcp-server",
        version: "1.0.0",
        transport: "sse",
        timestamp: new Date().toISOString(),
      });
    });

    // SSE endpoint - handle both GET and POST
    const handleSSE = (req: any, res: any) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
      });

      const transport = new SSEServerTransport("/sse", res);
      server.connect(transport);
    };

    app.get("/sse", handleSSE);
    app.post("/sse", handleSSE);

    app.listen(port, () => {
      console.log(
        `Octokit MCP Server running on port ${port} with SSE transport`,
      );
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`SSE endpoint: http://localhost:${port}/sse`);
    });
  } else if (transportType === "http") {
    // HTTP transport with Express server
    const app = express();

    // Simple CORS middleware
    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization",
      );
      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    app.use(express.json());

    // Health check endpoint
    app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        server: "octokit-mcp-server",
        version: "1.0.0",
        transport: "http",
        timestamp: new Date().toISOString(),
      });
    });

    // Tool discovery endpoint
    app.get("/tools/initialize", (req, res) => {
      res.json({ tools });
    });

    // Tool execution endpoints
    tools.forEach((tool) => {
      app.post(`/tools/${tool.name}`, async (req, res) => {
        try {
          const result = await executeTool(tool.name, req.body);
          res.json(result);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error occurred";
          res.status(500).json({ error: true, message: errorMessage });
        }
      });
    });

    app.listen(port, () => {
      console.log(
        `Octokit MCP Server running on port ${port} with HTTP transport`,
      );
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`Tools endpoint: http://localhost:${port}/tools/initialize`);
    });
  } else {
    // Default stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Octokit MCP Server running with stdio transport");
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down Octokit MCP Server...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down Octokit MCP Server...");
  process.exit(0);
});

main().catch((error) => {
  console.error("Failed to start Octokit MCP Server:", error);
  process.exit(1);
});

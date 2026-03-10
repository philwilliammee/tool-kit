#!/usr/bin/env node

/**
 * File Editor MCP Server
 * Provides intelligent file editing capabilities with minimal diff-based operations
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { FileOperationsService } from './file-operations.service.js';
import { DiffEngineService } from './diff-engine.service.js';
import { ContextSearchService } from './context-search.service.js';
import { FileEditorService } from './file-editor.service.js';

const server = new Server(
  {
    name: "file-editor",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Lazy initialization of services
let fileOps: FileOperationsService | null = null;
let diffEngine: DiffEngineService | null = null;
let contextSearch: ContextSearchService | null = null;
let fileEditor: FileEditorService | null = null;

function getFileOperationsService(): FileOperationsService {
  if (!fileOps) {
    fileOps = new FileOperationsService();
  }
  return fileOps;
}

function getDiffEngineService(): DiffEngineService {
  if (!diffEngine) {
    diffEngine = new DiffEngineService(getFileOperationsService());
  }
  return diffEngine;
}

function getContextSearchService(): ContextSearchService {
  if (!contextSearch) {
    contextSearch = new ContextSearchService(getFileOperationsService());
  }
  return contextSearch;
}

function getFileEditorService(): FileEditorService {
  if (!fileEditor) {
    fileEditor = new FileEditorService(getFileOperationsService(), getDiffEngineService());
  }
  return fileEditor;
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_code_context",
        description: "Find relevant code sections before making changes, minimizing what needs to be read",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Absolute or workspace-relative path to the file"
            },
            search_type: {
              type: "string",
              enum: ["function", "class", "lines", "pattern"],
              description: "Type of search to perform"
            },
            search_query: {
              type: "string",
              description: "Function name, class name, line range (e.g., '10-20'), or regex pattern"
            },
            context_lines: {
              type: "number",
              description: "Additional lines of context (default: 3)",
              default: 3
            },
            include_imports: {
              type: "boolean",
              description: "Include import statements (default: true)",
              default: true
            }
          },
          required: ["file_path", "search_type", "search_query"]
        }
      },
      {
        name: "generate_minimal_diff",
        description: "Generate the smallest possible diff for a change",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the file to modify"
            },
            old_content: {
              type: "string",
              description: "The section to replace (must exist in file)"
            },
            new_content: {
              type: "string",
              description: "The replacement content"
            },
            start_line: {
              type: "number",
              description: "Optional: hint for faster search (line number)"
            },
            algorithm: {
              type: "string",
              enum: ["unified", "character", "word", "line"],
              description: "Diff algorithm to use (default: unified)",
              default: "unified"
            },
            validate_before: {
              type: "boolean",
              description: "Dry-run validation (default: true)",
              default: true
            }
          },
          required: ["file_path", "old_content", "new_content"]
        }
      },
      {
        name: "apply_diff",
        description: "Apply a diff to a file. Always pass diff_content directly (the unified patch string returned by generate_minimal_diff).",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the file"
            },
            diff_content: {
              type: "string",
              description: "The unified patch string from generate_minimal_diff. Required — always pass this directly."
            },
            create_backup: {
              type: "boolean",
              description: "Create .bak file (default: true)",
              default: true
            },
            force: {
              type: "boolean",
              description: "Apply even with warnings (default: false)",
              default: false
            }
          },
          required: ["file_path", "diff_content"]
        }
      },
      {
        name: "validate_changes",
        description: "Validate that changes won't break syntax or introduce issues. Pass new_content with the full resulting file content to validate.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the file"
            },
            new_content: {
              type: "string",
              description: "The full resulting file content to validate"
            },
            validation_type: {
              type: "string",
              enum: ["syntax", "linter", "tests", "all"],
              description: "Type of validation to perform"
            },
            language: {
              type: "string",
              description: "Language for validation (auto-detected if not provided)"
            }
          },
          required: ["file_path", "validation_type"]
        }
      },
      {
        name: "batch_edit",
        description: "Apply multiple coordinated edits atomically across files",
        inputSchema: {
          type: "object",
          properties: {
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  operation: {
                    type: "string",
                    enum: ["edit", "create", "delete", "rename"]
                  },
                  diff_content: { type: "string" },
                  new_path: { type: "string" },
                  new_content: { type: "string" }
                },
                required: ["file_path", "operation"]
              },
              description: "Array of operations to perform"
            },
            atomic: {
              type: "boolean",
              description: "All-or-nothing (default: true)",
              default: true
            },
            validate_all: {
              type: "boolean",
              description: "Validate before applying (default: true)",
              default: true
            }
          },
          required: ["operations"]
        }
      },
      {
        name: "rollback_changes",
        description: "Undo changes using backup file paths",
        inputSchema: {
          type: "object",
          properties: {
            backup_paths: {
              type: "array",
              items: { type: "string" },
              description: "Backup file paths to restore (from batch_edit response)",
              minItems: 1
            }
          },
          required: ["backup_paths"]
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_code_context": {
        const contextSearch = getContextSearchService();
        const result = await contextSearch.searchCodeContext({
          file_path: args.file_path as string,
          search_type: args.search_type as any,
          search_query: args.search_query as string,
          context_lines: args.context_lines as number,
          include_imports: args.include_imports as boolean,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "generate_minimal_diff": {
        const diffEngine = getDiffEngineService();
        const result = await diffEngine.generateMinimalDiff({
          file_path: args.file_path as string,
          old_content: args.old_content as string,
          new_content: args.new_content as string,
          start_line: args.start_line as number,
          algorithm: args.algorithm as any,
          validate_before: args.validate_before as boolean,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "apply_diff": {
        const fileEditor = getFileEditorService();
        const result = await fileEditor.applyDiff({
          file_path: args.file_path as string,
          diff_content: args.diff_content as string,
          create_backup: args.create_backup as boolean,
          force: args.force as boolean,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "validate_changes": {
        const fileEditor = getFileEditorService();
        const result = await fileEditor.validateChanges({
          file_path: args.file_path as string,
          new_content: args.new_content as string,
          validation_type: args.validation_type as any,
          language: args.language as string,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "batch_edit": {
        // Handle operations parameter - might be JSON string or array
        let operations = args.operations;

        if (typeof operations === 'string') {
          try {
            operations = JSON.parse(operations);
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid operations parameter: must be a valid JSON array. Error: ${error.message}`
            );
          }
        }

        if (!Array.isArray(operations)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Operations must be an array. Received: ${typeof operations}`
          );
        }

        if (operations.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Operations array cannot be empty'
          );
        }

        const fileEditor = getFileEditorService();
        const result = await fileEditor.batchEdit({
          operations: operations as any,
          atomic: args.atomic as boolean,
          validate_all: args.validate_all as boolean,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "rollback_changes": {
        // Handle backup_paths parameter - might be JSON string or array
        let backup_paths = args.backup_paths;

        if (!backup_paths) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'backup_paths is required'
          );
        }

        if (typeof backup_paths === 'string') {
          try {
            backup_paths = JSON.parse(backup_paths);
          } catch (error: any) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid backup_paths parameter: must be a valid JSON array. Error: ${error.message}`
            );
          }
        }

        if (!Array.isArray(backup_paths)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `backup_paths must be an array. Received: ${typeof backup_paths}`
          );
        }

        if (backup_paths.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'backup_paths array cannot be empty'
          );
        }

        const fileEditor = getFileEditorService();
        const result = await fileEditor.rollbackChanges({
          backup_paths: backup_paths as string[],
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    console.error(`Error in file-editor MCP server:`, error);

    // Return user-friendly error message
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              message: error.message || "Internal server error",
              code: error.code || "INTERNAL_ERROR",
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("File Editor MCP server running on stdio");
}

main().catch((error) => {
  console.error("Failed to start file-editor MCP server:", error);
  process.exit(1);
});


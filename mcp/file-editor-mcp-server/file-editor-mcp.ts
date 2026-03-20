#!/usr/bin/env node

/**
 * File Editor MCP Server
 * Provides stateless file editing capabilities.
 *
 * Tools:
 *   search_code_context — find exact content before editing
 *   edit_file           — stateless old_string → new_string replacement
 *   batch_edit          — multi-file atomic operations (edit/create/delete/rename)
 *   rollback_changes    — restore from backup paths returned by batch_edit
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
import { ContextSearchService } from './context-search.service.js';
import { FileEditorService } from './file-editor.service.js';

const server = new Server(
  {
    name: "file-editor",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Lazy initialization of services
let fileOps: FileOperationsService | null = null;
let contextSearch: ContextSearchService | null = null;
let fileEditor: FileEditorService | null = null;

function getFileOperationsService(): FileOperationsService {
  if (!fileOps) fileOps = new FileOperationsService();
  return fileOps;
}

function getContextSearchService(): ContextSearchService {
  if (!contextSearch) contextSearch = new ContextSearchService(getFileOperationsService());
  return contextSearch;
}

function getFileEditorService(): FileEditorService {
  if (!fileEditor) fileEditor = new FileEditorService(getFileOperationsService());
  return fileEditor;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_code_context",
        description: "Find relevant code sections before making changes. Use this to get the exact current text before calling edit_file.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute or workspace-relative path to the file" },
            search_type: {
              type: "string",
              enum: ["function", "class", "lines", "pattern"],
              description: "Type of search to perform"
            },
            search_query: { type: "string", description: "Function name, class name, line range (e.g. '10-20'), or regex pattern" },
            context_lines: { type: "number", description: "Additional context lines (default: 3)", default: 3 },
            include_imports: { type: "boolean", description: "Include import statements (default: true)", default: true }
          },
          required: ["file_path", "search_type", "search_query"]
        }
      },
      {
        name: "edit_file",
        description: "Replace old_string with new_string in a file. Stateless — no IDs or prior calls needed. The old_string must match exactly (including whitespace). Replaces the first occurrence only. Use search_code_context first if you need to confirm the exact current text.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Absolute path to the file to edit" },
            old_string: { type: "string", description: "Exact text to find and replace (must exist in file)" },
            new_string: { type: "string", description: "Replacement text" },
            create_backup: { type: "boolean", description: "Create a .bak file before editing (default: true)", default: true }
          },
          required: ["file_path", "old_string", "new_string"]
        }
      },
      {
        name: "batch_edit",
        description: "Apply multiple coordinated operations atomically across files. Supports edit (old_string→new_string), create (new file), delete, and rename. If any operation fails and atomic=true, all changes are rolled back.",
        inputSchema: {
          type: "object",
          properties: {
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  file_path: { type: "string" },
                  operation: { type: "string", enum: ["edit", "create", "delete", "rename"] },
                  old_string: { type: "string", description: "For edit: exact text to replace" },
                  new_string: { type: "string", description: "For edit: replacement text" },
                  new_path: { type: "string", description: "For rename: destination path" },
                  new_content: { type: "string", description: "For create: full file content" }
                },
                required: ["file_path", "operation"]
              },
              description: "Array of operations to perform"
            },
            atomic: { type: "boolean", description: "All-or-nothing (default: true)", default: true },
            validate_all: { type: "boolean", description: "Validate before applying (default: true)", default: true }
          },
          required: ["operations"]
        }
      },
      {
        name: "rollback_changes",
        description: "Restore files from backup paths returned by batch_edit or edit_file.",
        inputSchema: {
          type: "object",
          properties: {
            backup_paths: {
              type: "array",
              items: { type: "string" },
              description: "Backup file paths to restore",
              minItems: 1
            }
          },
          required: ["backup_paths"]
        }
      }
    ]
  };
});

// ---------------------------------------------------------------------------
// Tool call handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "search_code_context": {
        const result = await getContextSearchService().searchCodeContext({
          file_path: args.file_path as string,
          search_type: args.search_type as any,
          search_query: args.search_query as string,
          context_lines: args.context_lines as number,
          include_imports: args.include_imports as boolean,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "edit_file": {
        const result = await getFileEditorService().editFile({
          file_path: args.file_path as string,
          old_string: args.old_string as string,
          new_string: args.new_string as string,
          create_backup: args.create_backup as boolean,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "batch_edit": {
        let operations = args.operations;
        if (typeof operations === 'string') {
          try { operations = JSON.parse(operations); }
          catch (error: any) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid operations JSON: ${error.message}`);
          }
        }
        if (!Array.isArray(operations) || operations.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'operations must be a non-empty array');
        }
        const result = await getFileEditorService().batchEdit({
          operations: operations as any,
          atomic: args.atomic as boolean,
          validate_all: args.validate_all as boolean,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "rollback_changes": {
        let backup_paths = args.backup_paths;
        if (typeof backup_paths === 'string') {
          try { backup_paths = JSON.parse(backup_paths); }
          catch (error: any) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid backup_paths JSON: ${error.message}`);
          }
        }
        if (!Array.isArray(backup_paths) || backup_paths.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'backup_paths must be a non-empty array');
        }
        const result = await getFileEditorService().rollbackChanges({
          backup_paths: backup_paths as string[],
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    console.error(`Error in file-editor MCP server:`, error);
    const knownCodes = new Set(['FILE_NOT_FOUND', 'STRING_NOT_FOUND', 'INVALID_PARAMS', 'PATH_NOT_ALLOWED']);
    const code = error.code === 'ENOENT' ? 'FILE_NOT_FOUND'
      : knownCodes.has(error.code) ? error.code
      : 'INTERNAL_ERROR';
    return {
      content: [{ type: "text", text: JSON.stringify({ error: { message: error.message || "Internal server error", code } }, null, 2) }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("File Editor MCP server v2 running on stdio");
}

main().catch((error) => {
  console.error("Failed to start file-editor MCP server:", error);
  process.exit(1);
});

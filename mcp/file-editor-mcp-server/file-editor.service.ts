/**
 * File Editor Service
 * Main service orchestrating file editing operations
 */

import {
  EditFileParams,
  EditFileResponse,
  BatchEditParams,
  BatchEditResponse,
  BatchEditOperation,
  RollbackChangesParams,
  RollbackChangesResponse,
} from './file-editor.types';
import { FileOperationsService } from './file-operations.service';

function editorError(code: string, message: string): Error {
  const e = new Error(message);
  (e as any).code = code;
  return e;
}

export class FileEditorService {
  private fileOps: FileOperationsService;

  constructor(fileOps: FileOperationsService) {
    this.fileOps = fileOps;
  }

  /**
   * Stateless string-replacement edit: find old_string in file and replace with new_string.
   * No IDs, no caching — safe across MCP server restarts.
   */
  async editFile(params: EditFileParams): Promise<EditFileResponse> {
    const { file_path, old_string, new_string, create_backup = true } = params;

    let content: string;
    try {
      content = await this.fileOps.readFile(file_path);
    } catch (e: any) {
      if (e.code === 'ENOENT' || e.code === 'FILE_NOT_FOUND') throw editorError('FILE_NOT_FOUND', `File not found: ${file_path}`);
      throw e;
    }

    if (!content.includes(old_string)) {
      const preview = old_string.length > 120 ? old_string.substring(0, 120) + '...' : old_string;
      throw editorError(
        'STRING_NOT_FOUND',
        `old_string not found in file.\nSearched for: ${JSON.stringify(preview)}\nTip: use search_code_context to get exact current content.`
      );
    }

    // Only replace the first occurrence (consistent with Claude Code Edit tool behaviour)
    const newContent = content.replace(old_string, new_string);

    let backupPath = '';
    if (create_backup) {
      backupPath = await this.fileOps.createBackup(file_path, 'edit');
    }

    await this.fileOps.writeFile(file_path, newContent, false);

    return {
      success: true,
      file_path,
      backup_path: backupPath || undefined,
    };
  }

  /**
   * Batch edit multiple files atomically across files
   */
  async batchEdit(params: BatchEditParams): Promise<BatchEditResponse> {
    const { operations, atomic = true, validate_all = true } = params;

    if (!operations || !Array.isArray(operations)) {
      throw new Error('Operations must be a non-empty array');
    }
    if (operations.length === 0) {
      throw new Error('No operations provided. Operations array is empty.');
    }

    console.error(`[batch_edit] Processing ${operations.length} operation(s)`);
    operations.forEach((op, idx) => {
      console.error(`[batch_edit] Op ${idx}: type=${op.operation}, file=${op.file_path}`);
    });

    const results: BatchEditResponse = {
      success: false,
      operations_completed: 0,
      operations_failed: 0,
      results: [],
    };

    const backupPaths: string[] = [];

    try {
      // Phase 1: Validation
      if (validate_all) {
        for (const op of operations) {
          if (!op.file_path) throw editorError('INVALID_PARAMS', 'Operation missing required field: file_path');
          if (!op.operation) throw editorError('INVALID_PARAMS', 'Operation missing required field: operation');
          if (op.operation === 'edit') {
            if (!op.old_string) throw editorError('INVALID_PARAMS', `Edit operation for ${op.file_path} missing old_string`);
            if (op.new_string === undefined) throw editorError('INVALID_PARAMS', `Edit operation for ${op.file_path} missing new_string`);
            const exists = await this.fileOps.fileExists(op.file_path);
            if (!exists) throw editorError('FILE_NOT_FOUND', `File not found: ${op.file_path}`);
          }
        }
      }

      // Phase 2: Create backups
      for (const op of operations) {
        if (op.operation !== 'create') {
          const exists = await this.fileOps.fileExists(op.file_path);
          if (exists) {
            const backupPath = await this.fileOps.createBackup(op.file_path, op.operation);
            backupPaths.push(backupPath);
          }
        }
      }

      if (atomic && backupPaths.length > 0) {
        results.backup_paths = backupPaths;
      }

      // Phase 3: Apply operations
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        console.error(`[batch_edit] Processing operation ${i + 1}/${operations.length}: ${op.operation} on ${op.file_path}`);
        try {
          switch (op.operation) {
            case 'edit': {
              const applyResult = await this.editFile({
                file_path: op.file_path,
                old_string: op.old_string!,
                new_string: op.new_string!,
                create_backup: false,
              });
              console.error(`[batch_edit] Edit applied to ${op.file_path}`);
              results.results.push({ file_path: op.file_path, success: true });
              results.operations_completed++;
              break;
            }

            case 'create':
              if (!op.new_content) throw new Error(`Create operation missing required field: new_content`);
              await this.fileOps.writeFile(op.file_path, op.new_content, false);
              results.results.push({ file_path: op.file_path, success: true });
              results.operations_completed++;
              break;

            case 'delete':
              await this.fileOps.deleteFile(op.file_path, false);
              results.results.push({ file_path: op.file_path, success: true });
              results.operations_completed++;
              break;

            case 'rename': {
              if (!op.new_path) throw new Error(`Rename operation missing required field: new_path`);
              const content = await this.fileOps.readFile(op.file_path);
              await this.fileOps.writeFile(op.new_path, content, false);
              await this.fileOps.deleteFile(op.file_path, false);
              results.results.push({ file_path: op.new_path, success: true });
              results.operations_completed++;
              break;
            }

            default:
              throw new Error(`Unknown operation type: ${op.operation}`);
          }
        } catch (error: any) {
          results.operations_failed++;
          const errorMsg = error?.message || String(error);
          console.error(`[batch_edit] Operation failed: ${errorMsg}`);
          results.results.push({ file_path: op.file_path, success: false, error: errorMsg });

          if (atomic && backupPaths.length > 0) {
            try {
              await this.rollbackChanges({ backup_paths: backupPaths });
            } catch (rollbackError: any) {
              console.error('[batch_edit] Rollback failed:', rollbackError);
            }
            throw new Error(`Batch operation failed at ${op.file_path}: ${errorMsg}`);
          }
        }
      }

      results.success = results.operations_failed === 0;
    } catch (error: any) {
      results.success = false;
      throw error;
    }

    return results;
  }

  /**
   * Rollback changes using backup file paths
   */
  async rollbackChanges(params: RollbackChangesParams): Promise<RollbackChangesResponse> {
    const { backup_paths } = params;

    if (!backup_paths || backup_paths.length === 0) {
      throw new Error('backup_paths is required and must not be empty');
    }

    const response: RollbackChangesResponse = {
      success: true,
      files_restored: [],
      errors: [],
    };

    for (const backupPath of backup_paths) {
      try {
        await this.fileOps.restoreFromBackup(backupPath);
        response.files_restored.push(backupPath);
      } catch (error: any) {
        response.errors?.push(`Failed to restore ${backupPath}: ${error.message}`);
      }
    }

    return response;
  }
}

/**
 * File Editor Service
 * Main service orchestrating file editing operations
 */

import { diffLines } from 'diff';
import {
  ApplyDiffParams,
  ApplyDiffResponse,
  BatchEditParams,
  BatchEditResponse,
  BatchEditOperation,
  ValidateChangesParams,
  ValidateChangesResponse,
  RollbackChangesParams,
  RollbackChangesResponse,
} from './file-editor.types';
import { FileOperationsService } from './file-operations.service';
import { DiffEngineService } from './diff-engine.service';

export class FileEditorService {
  private fileOps: FileOperationsService;
  private diffEngine: DiffEngineService;

  constructor(fileOps: FileOperationsService, diffEngine: DiffEngineService) {
    this.fileOps = fileOps;
    this.diffEngine = diffEngine;
  }

  /**
   * Apply diff to file
   */
  async applyDiff(params: ApplyDiffParams): Promise<ApplyDiffResponse> {
    const { file_path, diff_content, create_backup = true, force = false } = params;

    if (!diff_content) {
      throw new Error('diff_content is required');
    }

    // Read current file content
    const currentContent = await this.fileOps.readFile(file_path);

    // Apply diff
    const newContent = this.diffEngine.applyDiffToContent(currentContent, diff_content);

    // Validate if not forcing
    if (!force) {
      // Basic validation
      const fileExt = file_path.split('.').pop()?.toLowerCase();
      if (fileExt === 'json') {
        try {
          JSON.parse(newContent);
        } catch (error: any) {
          throw new Error(`Invalid JSON after diff: ${error.message}`);
        }
      }
    }

    // Write file
    let backupPath = '';
    if (create_backup) {
      backupPath = await this.fileOps.createBackup(file_path, 'edit');
    }

    await this.fileOps.writeFile(file_path, newContent, false);

    // Calculate new hash
    const newHash = await this.fileOps.calculateFileHash(file_path);

    // Calculate changed lines using diffLines from the diff library
    const linesModified: number[] = [];
    const diff = diffLines(currentContent, newContent);

    let currentLine = 1;
    for (const part of diff) {
      const lineCount = part.count || 0;

      if (part.added || part.removed) {
        // Track modified lines
        for (let i = 0; i < lineCount; i++) {
          linesModified.push(currentLine + i);
        }
      }

      // Only advance line counter for non-removed lines
      if (!part.removed) {
        currentLine += lineCount;
      }
    }

    return {
      success: true,
      file_path,
      backup_path: backupPath,
      changes_applied: {
        lines_modified: linesModified.slice(0, 100), // Limit to first 100
        total_changes: linesModified.length,
      },
      new_file_hash: newHash,
    };
  }

  /**
   * Validate changes
   */
  async validateChanges(params: ValidateChangesParams): Promise<ValidateChangesResponse> {
    const { file_path, new_content, validation_type, language } = params;

    if (!new_content) {
      throw new Error('new_content is required');
    }

    const contentToValidate: string = new_content;

    const results: ValidateChangesResponse = {
      valid: true,
      validation_results: {
        syntax: {
          valid: true,
          errors: [],
        },
      },
      recommendations: [],
    };

    // Auto-detect language from file extension if not provided
    const detectedLanguage = language || this.detectLanguage(file_path);

    // Syntax validation
    if (validation_type === 'syntax' || validation_type === 'all') {
      results.validation_results.syntax = await this.validateSyntax(contentToValidate, detectedLanguage);
      if (!results.validation_results.syntax.valid) {
        results.valid = false;
      }
    }

    // Linter validation (placeholder - would integrate with actual linter)
    if (validation_type === 'linter' || validation_type === 'all') {
      // TODO: Integrate with ESLint, TSLint, etc.
      results.validation_results.linter = {
        warnings: 0,
        errors: 0,
        details: [],
      };
    }

    // Test validation (placeholder)
    if (validation_type === 'tests' || validation_type === 'all') {
      // TODO: Run tests
      results.validation_results.tests = {
        passed: true,
        summary: 'Tests not implemented',
      };
    }

    return results;
  }

  /**
   * Batch edit multiple files atomically
   */
  async batchEdit(params: BatchEditParams): Promise<BatchEditResponse> {
    const { operations, atomic = true, validate_all = true } = params;

    // Validate operations array
    if (!operations || !Array.isArray(operations)) {
      throw new Error('Operations must be a non-empty array');
    }

    if (operations.length === 0) {
      throw new Error('No operations provided. Operations array is empty.');
    }

    // Log operations for debugging
    console.error(`[batch_edit] Processing ${operations.length} operation(s)`);
    operations.forEach((op, idx) => {
      console.error(`[batch_edit] Op ${idx}: type=${op.operation}, file=${op.file_path}, has_diff_content=${!!op.diff_content}, has_new_content=${!!op.new_content}`);
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
        console.error(`[batch_edit] Validating ${operations.length} operations...`);
        for (const op of operations) {
          if (!op.file_path) {
            throw new Error(`Operation missing required field: file_path`);
          }
          if (!op.operation) {
            throw new Error(`Operation missing required field: operation (must be 'edit', 'create', 'delete', or 'rename')`);
          }

          if (op.operation === 'edit') {
            if (!op.diff_content) {
              throw new Error(`Edit operation for ${op.file_path} missing required field: diff_content`);
            }
            // Validate diff can be applied
            const exists = await this.fileOps.fileExists(op.file_path);
            if (!exists) {
              throw new Error(`File not found: ${op.file_path}`);
            }
          }
        }
        console.error(`[batch_edit] Validation passed`);
      }

      // Phase 2: Create backups
      console.error(`[batch_edit] Creating backups...`);
      for (const op of operations) {
        if (op.operation !== 'create') {
          const exists = await this.fileOps.fileExists(op.file_path);
          if (exists) {
            const backupPath = await this.fileOps.createBackup(op.file_path, op.operation);
            backupPaths.push(backupPath);
            console.error(`[batch_edit] Backup created: ${backupPath}`);
          }
        }
      }

      // Return backup paths for rollback
      if (atomic && backupPaths.length > 0) {
        results.backup_paths = backupPaths;
        console.error(`[batch_edit] Created ${backupPaths.length} backup(s) for rollback`);
      }

      // Phase 3: Apply operations
      console.error(`[batch_edit] Applying operations...`);
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        console.error(`[batch_edit] Processing operation ${i + 1}/${operations.length}: ${op.operation} on ${op.file_path}`);
        try {
          switch (op.operation) {
            case 'edit':
              if (!op.diff_content) {
                throw new Error(`Operation missing required field: diff_content`);
              }

              console.error(`[batch_edit] Applying diff to ${op.file_path}...`);
              const applyResult = await this.applyDiff({
                file_path: op.file_path,
                diff_content: op.diff_content,
                create_backup: false, // Already backed up
                force: !validate_all,
              });
              console.error(`[batch_edit] Diff applied successfully: ${applyResult.changes_applied.total_changes} changes`);
              results.results.push({ file_path: op.file_path, success: true });
              results.operations_completed++;
              break;

            case 'create':
              if (!op.new_content) {
                throw new Error(`Create operation missing required field: new_content`);
              }
              console.error(`[batch_edit] Creating file ${op.file_path}...`);
              await this.fileOps.writeFile(op.file_path, op.new_content, false);
              results.results.push({ file_path: op.file_path, success: true });
              results.operations_completed++;
              break;

            case 'delete':
              console.error(`[batch_edit] Deleting file ${op.file_path}...`);
              await this.fileOps.deleteFile(op.file_path, false); // Already backed up
              results.results.push({ file_path: op.file_path, success: true });
              results.operations_completed++;
              break;

            case 'rename':
              if (!op.new_path) {
                throw new Error(`Rename operation missing required field: new_path`);
              }
              console.error(`[batch_edit] Renaming file ${op.file_path} to ${op.new_path}...`);
              const content = await this.fileOps.readFile(op.file_path);
              await this.fileOps.writeFile(op.new_path, content, false);
              await this.fileOps.deleteFile(op.file_path, false);
              results.results.push({ file_path: op.new_path, success: true });
              results.operations_completed++;
              break;

            default:
              throw new Error(`Unknown operation type: ${op.operation}. Must be 'edit', 'create', 'delete', or 'rename'`);
          }
        } catch (error: any) {
          results.operations_failed++;
          const errorMsg = error?.message || String(error);
          console.error(`[batch_edit] Operation failed: ${errorMsg}`);
          results.results.push({
            file_path: op.file_path,
            success: false,
            error: errorMsg,
          });

          if (atomic && backupPaths.length > 0) {
            // Rollback all changes
            console.error(`[batch_edit] Atomic mode: rolling back all changes...`);
            try {
              await this.rollbackChanges({ backup_paths: backupPaths });
              console.error(`[batch_edit] Rollback successful`);
            } catch (rollbackError: any) {
              // Log rollback error but don't mask original error
              console.error('[batch_edit] Rollback failed:', rollbackError);
            }
            throw new Error(`Batch operation failed at ${op.file_path}: ${errorMsg}`);
          }
        }
      }

      results.success = results.operations_failed === 0;
      console.error(`[batch_edit] Completed: ${results.operations_completed} succeeded, ${results.operations_failed} failed`);
    } catch (error: any) {
      results.success = false;
      console.error(`[batch_edit] Fatal error:`, error);
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

  /**
   * Validate syntax
   */
  private async validateSyntax(content: string, language: string): Promise<{ valid: boolean; errors: Array<{ line: number; message: string }> }> {
    const result = {
      valid: true,
      errors: [] as Array<{ line: number; message: string }>,
    };

    // JSON validation
    if (language === 'json') {
      try {
        JSON.parse(content);
      } catch (error: any) {
        result.valid = false;
        const lineMatch = error.message.match(/line (\d+)/i);
        const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
        result.errors.push({ line, message: error.message });
      }
    }

    // TODO: Add more language validators (JavaScript, TypeScript, Python, etc.)

    return result;
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      json: 'json',
      py: 'python',
      java: 'java',
      cpp: 'cpp',
      c: 'c',
      h: 'c',
      hpp: 'cpp',
      md: 'markdown',
    };
    return langMap[ext || ''] || 'text';
  }
}


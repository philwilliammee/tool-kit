/**
 * Type definitions for File Editor MCP Server
 */

export type SearchType = 'function' | 'class' | 'lines' | 'pattern';
export type DiffAlgorithm = 'unified' | 'character' | 'word' | 'line';
export type ValidationType = 'syntax' | 'linter' | 'tests' | 'all';
export type OperationType = 'edit' | 'create' | 'delete' | 'rename';
export type ErrorCategory = 'validation' | 'permission' | 'conflict' | 'syntax' | 'system';

export interface SearchCodeContextParams {
  file_path: string;
  search_type: SearchType;
  search_query: string;
  context_lines?: number;
  include_imports?: boolean;
}

export interface CodeMatch {
  start_line: number;
  end_line: number;
  content: string;
  context: {
    before: string[];
    after: string[];
    imports?: string[];
  };
}

export interface SearchCodeContextResponse {
  file_path: string;
  matches: CodeMatch[];
  file_metadata: {
    total_lines: number;
    encoding: string;
    last_modified: string;
  };
}

export interface GenerateMinimalDiffParams {
  file_path: string;
  old_content: string;
  new_content: string;
  start_line?: number;
  algorithm?: DiffAlgorithm;
  validate_before?: boolean;
}

export interface DiffStats {
  lines_added: number;
  lines_removed: number;
  lines_modified: number;
  bytes_changed: number;
}

export interface DiffValidation {
  can_apply: boolean;
  warnings: string[];
  conflicts: string[];
}

export interface GenerateMinimalDiffResponse {
  diff_id: string;
  diff_format: string;
  diff_content: string;
  stats: DiffStats;
  validation: DiffValidation;
  preview: string;
}

export interface ApplyDiffParams {
  diff_id?: string;
  file_path: string;
  diff_content?: string;
  create_backup?: boolean;
  force?: boolean;
}

export interface ChangesApplied {
  lines_modified: number[];
  total_changes: number;
}

export interface ApplyDiffResponse {
  success: boolean;
  file_path: string;
  backup_path?: string;
  changes_applied: ChangesApplied;
  new_file_hash: string;
  errors?: string[];
}

export interface ValidateChangesParams {
  file_path: string;
  diff_id?: string;
  new_content?: string;
  validation_type: ValidationType;
  language?: string;
}

export interface SyntaxValidationResult {
  valid: boolean;
  errors: Array<{ line: number; message: string }>;
}

export interface LinterValidationResult {
  warnings: number;
  errors: number;
  details: Array<{ severity: string; line: number; message: string }>;
}

export interface TestValidationResult {
  passed: boolean;
  summary: string;
}

export interface ValidationResults {
  syntax: SyntaxValidationResult;
  linter?: LinterValidationResult;
  tests?: TestValidationResult;
}

export interface ValidateChangesResponse {
  valid: boolean;
  validation_results: ValidationResults;
  recommendations: string[];
}

export interface EditFileParams {
  file_path: string;
  old_string: string;
  new_string: string;
  create_backup?: boolean;
}

export interface EditFileResponse {
  success: boolean;
  file_path: string;
  backup_path?: string;
}

export interface BatchEditOperation {
  file_path: string;
  operation: OperationType;
  /** For edit operations: the exact text to replace */
  old_string?: string;
  /** For edit operations: the replacement text */
  new_string?: string;
  new_path?: string;
  new_content?: string;
}

export interface BatchEditParams {
  operations: BatchEditOperation[];
  atomic?: boolean;
  validate_all?: boolean;
}

export interface BatchEditResult {
  file_path: string;
  success: boolean;
  error?: string;
  backup_path?: string;
}

export interface BatchEditResponse {
  success: boolean;
  operations_completed: number;
  operations_failed: number;
  results: BatchEditResult[];
  backup_paths?: string[];  // Backup paths for rollback (if atomic and backups created)
}

export interface RollbackChangesParams {
  backup_paths: string[];  // Required: backup file paths to restore
}

export interface RollbackChangesResponse {
  success: boolean;
  files_restored: string[];
  errors?: string[];
}

export interface FileEditorError {
  code: string;
  message: string;
  category: ErrorCategory;
  recoverable: boolean;
  suggestions: string[];
  context?: {
    file_path?: string;
    line_number?: number;
    operation?: string;
  };
}

export interface FileEditorConfig {
  editor: {
    max_file_size: number;
    max_diff_size: number;
    max_context_lines: number;
    default_backup_enabled: boolean;
    backup_retention_days: number;
    backup_max_count: number;
  };
  safety: {
    require_validation: boolean;
    allow_force_apply: boolean;
    enable_file_locking: boolean;
    atomic_batch_default: boolean;
  };
  performance: {
    cache_enabled: boolean;
    cache_max_files: number;
    cache_max_diffs: number;
    parallel_operations: number;
    stream_threshold_bytes: number;
  };
  workspace: {
    root_paths: string[];
    excluded_patterns: string[];
    allowed_extensions: string[];
  };
  security: {
    sandboxing: {
      enabled: boolean;
      allowed_paths: string[];
      denied_paths: string[];
    };
    operation_limits: {
      max_files_per_batch: number;
      max_operations_per_second: number;
      max_concurrent_operations: number;
    };
    validation: {
      check_file_size: boolean;
      check_permissions: boolean;
      check_symbolic_links: boolean;
      check_binary_files: boolean;
    };
  };
}

export interface LockInfo {
  filePath: string;
  lockedAt: Date;
  timeout: number;
}

export interface DiffCacheEntry {
  diff_id: string;
  file_path: string;
  diff_content: string;
  stats: DiffStats;
  created_at: Date;
}

export interface FileCacheEntry {
  file_path: string;
  content: string;
  last_modified: Date;
  hash: string;
}

export interface BackupInfo {
  original_path: string;
  backup_path: string;
  created_at: Date;
  operation_type: string;
}


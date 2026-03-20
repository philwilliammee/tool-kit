/**
 * File Operations Service
 * Handles safe file I/O, backups, locking, and security
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { FileEditorConfig, LockInfo, BackupInfo } from './file-editor.types';

export class FileOperationsService {
  private config: FileEditorConfig;
  private locks: Map<string, LockInfo> = new Map();
  private backups: Map<string, BackupInfo[]> = new Map();

  constructor(config?: Partial<FileEditorConfig>) {
    this.config = this.getDefaultConfig();
    if (config) {
      this.config = this.mergeConfig(this.config, config);
    }
  }

  private getDefaultConfig(): FileEditorConfig {
    return {
      editor: {
        max_file_size: 10485760, // 10MB
        max_diff_size: 1048576, // 1MB
        max_context_lines: 50,
        default_backup_enabled: true,
        backup_retention_days: 7,
        backup_max_count: 5,
      },
      safety: {
        require_validation: true,
        allow_force_apply: false,
        enable_file_locking: true,
        atomic_batch_default: true,
      },
      performance: {
        cache_enabled: true,
        cache_max_files: 50,
        cache_max_diffs: 100,
        parallel_operations: 4,
        stream_threshold_bytes: 10485760,
      },
      workspace: {
        root_paths: [process.env.WORKSPACE_ROOT || os.homedir()],
        excluded_patterns: ['node_modules', '.git', 'dist', 'build'],
        allowed_extensions: ['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.py', '.java', '.cpp', '.c', '.h', '.hpp'],
      },
      security: {
        sandboxing: {
          enabled: true,
          allowed_paths: [process.env.WORKSPACE_ROOT || os.homedir()],
          denied_paths: ['/etc', '/sys', `${os.homedir()}/.ssh`],
        },
        operation_limits: {
          max_files_per_batch: 50,
          max_operations_per_second: 10,
          max_concurrent_operations: 5,
        },
        validation: {
          check_file_size: true,
          check_permissions: true,
          check_symbolic_links: true,
          check_binary_files: true,
        },
      },
    };
  }

  private mergeConfig(defaultConfig: FileEditorConfig, partial: Partial<FileEditorConfig>): FileEditorConfig {
    return {
      ...defaultConfig,
      ...partial,
      editor: { ...defaultConfig.editor, ...partial.editor },
      safety: { ...defaultConfig.safety, ...partial.safety },
      performance: { ...defaultConfig.performance, ...partial.performance },
      workspace: { ...defaultConfig.workspace, ...partial.workspace },
      security: { ...defaultConfig.security, ...partial.security },
    };
  }

  /**
   * Validate and normalize file path
   */
  async validatePath(filePath: string): Promise<string> {
    // Resolve absolute path
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const normalized = path.normalize(absolutePath);

    // Security: Check if path is within allowed workspace
    if (this.config.security.sandboxing.enabled) {
      const isAllowed = this.config.security.sandboxing.allowed_paths.some((allowed) =>
        normalized.startsWith(path.normalize(allowed))
      );

      if (!isAllowed) {
        const e = new Error(`File path outside allowed workspace: ${normalized}`);
        (e as any).code = 'PATH_NOT_ALLOWED';
        throw e;
      }

      // Check denied paths
      const isDenied = this.config.security.sandboxing.denied_paths.some((denied) =>
        normalized.startsWith(path.normalize(denied))
      );

      if (isDenied) {
        const e = new Error(`Access denied to path: ${normalized}`);
        (e as any).code = 'PATH_NOT_ALLOWED';
        throw e;
      }
    }

    // Check excluded patterns
    const pathParts = normalized.split(path.sep);
    for (const excluded of this.config.workspace.excluded_patterns) {
      if (pathParts.includes(excluded)) {
        throw new Error(`Path matches excluded pattern: ${excluded}`);
      }
    }

    // Check file extension
    const ext = path.extname(normalized);
    if (ext && !this.config.workspace.allowed_extensions.includes(ext)) {
      // Warn but don't block - extensions can be extended
      console.warn(`File extension ${ext} not in allowed list`);
    }

    return normalized;
  }

  /**
   * Read file safely
   */
  async readFile(filePath: string): Promise<string> {
    const validatedPath = await this.validatePath(filePath);

    // Check if file exists
    try {
      await fs.access(validatedPath, fs.constants.F_OK);
    } catch {
      const e = new Error(`File not found: ${validatedPath}`);
      (e as any).code = 'FILE_NOT_FOUND';
      throw e;
    }

    // Check permissions
    try {
      await fs.access(validatedPath, fs.constants.R_OK);
    } catch {
      throw new Error(`No read permission: ${validatedPath}`);
    }

    // Check file size
    const stats = await fs.stat(validatedPath);
    if (this.config.security.validation.check_file_size && stats.size > this.config.editor.max_file_size) {
      throw new Error(`File too large: ${stats.size} bytes (max: ${this.config.editor.max_file_size})`);
    }

    // Check if symbolic link
    if (this.config.security.validation.check_symbolic_links) {
      const linkStats = await fs.lstat(validatedPath);
      if (linkStats.isSymbolicLink()) {
        throw new Error(`Symbolic links not allowed: ${validatedPath}`);
      }
    }

    return await fs.readFile(validatedPath, 'utf-8');
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(filePath: string): Promise<{
    total_lines: number;
    encoding: string;
    last_modified: string;
  }> {
    const validatedPath = await this.validatePath(filePath);
    const content = await this.readFile(validatedPath);
    const stats = await fs.stat(validatedPath);

    return {
      total_lines: content.split('\n').length,
      encoding: 'utf-8',
      last_modified: stats.mtime.toISOString(),
    };
  }

  /**
   * Acquire file lock
   */
  async acquireLock(filePath: string, timeout: number = 30000): Promise<boolean> {
    if (!this.config.safety.enable_file_locking) {
      return true;
    }

    const validatedPath = await this.validatePath(filePath);

    // Check if already locked
    const existingLock = this.locks.get(validatedPath);
    if (existingLock) {
      const now = Date.now();
      const lockAge = now - existingLock.lockedAt.getTime();
      if (lockAge < existingLock.timeout) {
        return false; // Still locked
      }
      // Lock expired, remove it
      this.locks.delete(validatedPath);
    }

    // Acquire lock
    this.locks.set(validatedPath, {
      filePath: validatedPath,
      lockedAt: new Date(),
      timeout,
    });

    return true;
  }

  /**
   * Release file lock
   */
  async releaseLock(filePath: string): Promise<void> {
    const validatedPath = await this.validatePath(filePath);
    this.locks.delete(validatedPath);
  }

  /**
   * Check if file is locked
   */
  isLocked(filePath: string): boolean {
    const lock = this.locks.get(filePath);
    if (!lock) {
      return false;
    }

    const now = Date.now();
    const lockAge = now - lock.lockedAt.getTime();
    if (lockAge >= lock.timeout) {
      this.locks.delete(filePath);
      return false;
    }

    return true;
  }

  /**
   * Create backup of file
   */
  async createBackup(filePath: string, operationType: string = 'edit'): Promise<string> {
    if (!this.config.editor.default_backup_enabled) {
      return '';
    }

    const validatedPath = await this.validatePath(filePath);

    try {
      const content = await this.readFile(validatedPath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupPath = `${validatedPath}.bak-${timestamp}`;

      await fs.writeFile(backupPath, content, 'utf-8');

      // Store backup info
      const backupInfo: BackupInfo = {
        original_path: validatedPath,
        backup_path: backupPath,
        created_at: new Date(),
        operation_type: operationType,
      };

      if (!this.backups.has(validatedPath)) {
        this.backups.set(validatedPath, []);
      }

      const backups = this.backups.get(validatedPath)!;
      backups.push(backupInfo);

      // Clean up old backups
      this.cleanupOldBackups(validatedPath);

      return backupPath;
    } catch (error: any) {
      throw new Error(`Failed to create backup: ${error.message}`);
    }
  }

  /**
   * Clean up old backups
   */
  private cleanupOldBackups(filePath: string): void {
    const backups = this.backups.get(filePath);
    if (!backups) {
      return;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.editor.backup_retention_days);

    // Filter out old backups
    const validBackups = backups.filter((backup) => backup.created_at > cutoffDate);

    // Keep only the most recent N backups
    const sortedBackups = validBackups.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const keptBackups = sortedBackups.slice(0, this.config.editor.backup_max_count);

    // Delete old backup files
    for (const backup of backups) {
      if (!keptBackups.includes(backup)) {
        fs.unlink(backup.backup_path).catch(() => {
          // Ignore errors deleting old backups
        });
      }
    }

    this.backups.set(filePath, keptBackups);
  }

  /**
   * Write file safely (with backup if enabled)
   */
  async writeFile(filePath: string, content: string, createBackup: boolean = true): Promise<void> {
    const validatedPath = await this.validatePath(filePath);

    // Check if locked
    if (this.isLocked(validatedPath)) {
      throw new Error(`File is locked: ${validatedPath}`);
    }

    // Acquire lock
    if (this.config.safety.enable_file_locking) {
      const locked = await this.acquireLock(validatedPath);
      if (!locked) {
        throw new Error(`Failed to acquire lock: ${validatedPath}`);
      }
    }

    try {
      // Create backup if requested
      if (createBackup) {
        try {
          await this.createBackup(validatedPath, 'edit');
        } catch (error: any) {
          console.warn(`Backup failed: ${error.message}`);
          // Continue anyway if backup fails
        }
      }

      // Write file
      await fs.writeFile(validatedPath, content, 'utf-8');
    } finally {
      // Release lock
      if (this.config.safety.enable_file_locking) {
        await this.releaseLock(validatedPath);
      }
    }
  }

  /**
   * Restore file from backup
   */
  async restoreFromBackup(backupPath: string): Promise<void> {
    const normalizedBackup = path.normalize(backupPath);

    // Check if backup file exists
    try {
      await fs.access(normalizedBackup, fs.constants.F_OK);
    } catch (error) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    // Extract original file path from backup path
    // Backup format: original.js.bak-2025-11-02T12-34-29
    // Remove .bak-TIMESTAMP to get original path
    const originalPath = this.extractOriginalPathFromBackup(normalizedBackup);

    if (!originalPath) {
      throw new Error(`Cannot determine original path from backup: ${backupPath}`);
    }

    // Read backup content
    const content = await fs.readFile(normalizedBackup, 'utf-8');

    // Write to original location (skip backup creation for restore operation)
    await this.writeFile(originalPath, content, false);
  }

  /**
   * Extract original file path from backup file path
   * Backup format: /path/to/file.ext.bak-2025-11-02T12-34-29
   * Returns: /path/to/file.ext
   */
  private extractOriginalPathFromBackup(backupPath: string): string | null {
    // Match .bak-TIMESTAMP pattern at the end
    const bakPattern = /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

    if (!bakPattern.test(backupPath)) {
      return null;
    }

    // Remove the .bak-TIMESTAMP suffix
    return backupPath.replace(bakPattern, '');
  }

  /**
   * Calculate file hash (SHA256)
   */
  async calculateFileHash(filePath: string): Promise<string> {
    const content = await this.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Check if file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      const validatedPath = await this.validatePath(filePath);
      await fs.access(validatedPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete file safely
   */
  async deleteFile(filePath: string, createBackup: boolean = true): Promise<void> {
    const validatedPath = await this.validatePath(filePath);

    if (createBackup) {
      await this.createBackup(validatedPath, 'delete');
    }

    await fs.unlink(validatedPath);
  }
}


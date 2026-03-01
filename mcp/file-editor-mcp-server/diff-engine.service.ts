/**
 * Diff Engine Service
 * Handles diff generation using industry-standard unified diff format
 */

import {
  structuredPatch,
  createPatch,
  applyPatch,
  parsePatch
} from 'diff';
import { v4 as uuidv4 } from 'uuid';
import {
  DiffAlgorithm,
  GenerateMinimalDiffParams,
  GenerateMinimalDiffResponse,
  DiffStats,
  DiffValidation,
  DiffCacheEntry,
} from './file-editor.types';
import { FileOperationsService } from './file-operations.service';

export class DiffEngineService {
  private fileOps: FileOperationsService;
  private diffCache: Map<string, DiffCacheEntry> = new Map();
  private patchCache: Map<string, string> = new Map(); // diff_id -> patch string
  private maxCacheSize = 100;

  constructor(fileOps: FileOperationsService) {
    this.fileOps = fileOps;
  }

  /**
   * Generate a unified diff patch with context
   */
  private generateUnifiedPatch(
    fileName: string,
    oldContent: string,
    newContent: string,
    contextLines: number = 3
  ): string {
    // Use createPatch to generate a proper unified diff
    const patch = createPatch(
      fileName,
      oldContent,
      newContent,
      '', // old header
      '', // new header
      { context: contextLines }
    );
    return patch;
  }

  /**
   * Test if a patch can be applied to content
   */
  private canApplyPatch(content: string, patch: string): boolean {
    const result = applyPatch(content, patch);
    return result !== false;
  }

  /**
   * Generate minimal diff between old and new content using unified diff format
   */
  async generateMinimalDiff(params: GenerateMinimalDiffParams): Promise<GenerateMinimalDiffResponse> {
    const { file_path, old_content, new_content, start_line, algorithm = 'unified', validate_before = true } = params;

    // Check cache first
    const cacheKey = this.getCacheKey(old_content, new_content);
    const cached = this.diffCache.get(cacheKey);
    if (cached) {
      return {
        diff_id: cached.diff_id,
        diff_format: 'unified',
        diff_content: cached.diff_content,
        stats: cached.stats,
        validation: {
          can_apply: true,
          warnings: [],
          conflicts: [],
        },
        preview: this.generatePreview(old_content, new_content),
      };
    }

    // Validate file exists and read it
    const fileExists = await this.fileOps.fileExists(file_path);
    if (!fileExists) {
      throw new Error(`File not found: ${file_path}`);
    }

    const fileContent = await this.fileOps.readFile(file_path);

    // Generate unified diff patch with context
    // This will be applied with fuzzy matching, so we don't need exact content matching
    const patch = this.generateUnifiedPatch(file_path, old_content, new_content, 3);

    // Test if patch can be applied to the file
    const canApply = this.canApplyPatch(fileContent, patch);

    if (!canApply && validate_before) {
      const previewLength = Math.min(100, old_content.length);
      const preview = old_content.substring(0, previewLength) + (old_content.length > previewLength ? '...' : '');
      throw new Error(
        `Patch cannot be applied to file. The content may have changed.\n` +
        `Searched for: ${JSON.stringify(preview)}\n` +
        `Try using search_code_context first to get exact content.`
      );
    }

    // Calculate stats from the patch
    const stats = this.calculateStatsFromPatch(patch);

    // Validate if requested
    const validation: DiffValidation = {
      can_apply: canApply,
      warnings: canApply ? [] : ['Patch may not apply cleanly'],
      conflicts: [],
    };

    if (validate_before && canApply) {
      // Test apply to check for issues
      const testResult = applyPatch(fileContent, patch);
      if (testResult === false) {
        validation.warnings.push('Patch test application failed');
      }
    }

    // Create diff entry
    const diff_id = uuidv4();
    const diffEntry: DiffCacheEntry = {
      diff_id,
      file_path,
      diff_content: patch,
      stats,
      created_at: new Date(),
    };

    // Store patch for later application
    this.patchCache.set(diff_id, patch);

    // Cache the diff
    this.cacheDiff(cacheKey, diffEntry);

    return {
      diff_id,
      diff_format: 'unified',
      diff_content: patch,
      stats,
      validation,
      preview: this.generatePreview(old_content, new_content),
    };
  }

  /**
   * REMOVED: Custom diff formatters (generateDiff, generateLineDiff, generateCharacterDiff, generateWordDiff)
   *
   * These methods are no longer needed since we exclusively use unified patch format via createPatch().
   * The 'algorithm' parameter in generateMinimalDiff is kept for backward compatibility but always uses unified format.
   *
   * If you need character or word-level diffs in the future, use diffChars() or diffWords() from the diff library directly.
   */

  /**
   * Calculate diff statistics from unified patch using parsePatch
   */
  private calculateStatsFromPatch(patch: string): DiffStats {
    try {
      const parsed = parsePatch(patch);

      if (parsed.length === 0) {
        return {
          lines_added: 0,
          lines_removed: 0,
          lines_modified: 0,
          bytes_changed: 0,
        };
      }

      // Aggregate stats from all hunks
      let added = 0;
      let removed = 0;

      for (const file of parsed) {
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            if (line.startsWith('+')) {
              added++;
            } else if (line.startsWith('-')) {
              removed++;
            }
          }
        }
      }

      return {
        lines_added: added,
        lines_removed: removed,
        lines_modified: Math.min(added, removed),
        bytes_changed: 0, // Not easily calculable from patch
      };
    } catch (error) {
      // Fallback to simple parsing if parsePatch fails
      const lines = patch.split('\n');
      let added = 0;
      let removed = 0;

      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          added++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          removed++;
        }
      }

      return {
        lines_added: added,
        lines_removed: removed,
        lines_modified: Math.min(added, removed),
        bytes_changed: 0,
      };
    }
  }

  /**
   * Validate that diff can be applied
   */
  private async validateDiff(
    filePath: string,
    fileContent: string,
    oldContent: string,
    newContent: string
  ): Promise<DiffValidation> {
    const validation: DiffValidation = {
      can_apply: true,
      warnings: [],
      conflicts: [],
    };

    // Check if old content exists
    if (!fileContent.includes(oldContent)) {
      validation.can_apply = false;
      validation.conflicts.push('Old content not found in file');
      return validation;
    }

    // Check file size after change
    const newFileSize = Buffer.byteLength(fileContent.replace(oldContent, newContent));
    if (newFileSize > 10485760) {
      // 10MB
      validation.warnings.push('File will exceed size limit after change');
    }

    // Basic syntax check for common file types
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'json') {
      try {
        JSON.parse(newContent);
      } catch (error: any) {
        validation.warnings.push(`Invalid JSON: ${error.message}`);
      }
    }

    return validation;
  }

  /**
   * Generate preview of changes using structuredPatch for better formatting
   */
  private generatePreview(oldContent: string, newContent: string): string {
    try {
      // Use structuredPatch to get a structured diff with hunks
      const patch = structuredPatch('', '', oldContent, newContent, '', '', { context: 3 });

      if (!patch || !patch.hunks || patch.hunks.length === 0) {
        return 'No changes detected';
      }

      // Format the first hunk as a preview
      const firstHunk = patch.hunks[0];
      const lines = firstHunk.lines.slice(0, 20); // Limit to first 20 lines

      let preview = `@@ -${firstHunk.oldStart},${firstHunk.oldLines} +${firstHunk.newStart},${firstHunk.newLines} @@\n`;
      preview += lines.join('\n');

      if (firstHunk.lines.length > 20 || patch.hunks.length > 1) {
        const totalChanges = patch.hunks.reduce((sum, h) => sum + h.lines.filter(l => l.startsWith('+') || l.startsWith('-')).length, 0);
        preview += `\n... (${totalChanges} total changes in ${patch.hunks.length} hunk(s))`;
      }

      return preview;
    } catch (error) {
      // Fallback to simple preview
      const oldLines = oldContent.split('\n');
      const newLines = newContent.split('\n');
      const maxLines = 10;

      if (oldLines.length <= maxLines && newLines.length <= maxLines) {
        return `Old:\n${oldContent}\n\nNew:\n${newContent}`;
      }

      const oldPreview = oldLines.slice(0, maxLines).join('\n');
      const newPreview = newLines.slice(0, maxLines).join('\n');
      return `Old (first ${maxLines} lines):\n${oldPreview}...\n\nNew (first ${maxLines} lines):\n${newPreview}...`;
    }
  }

  /**
   * Get cached diff by ID
   */
  getCachedDiff(diff_id: string): DiffCacheEntry | undefined {
    // Check if we have the patch cached
    if (this.patchCache.has(diff_id)) {
      // Find the cache entry
      for (const entry of this.diffCache.values()) {
        if (entry.diff_id === diff_id) {
          return entry;
        }
      }
      // If patch exists but cache entry not found, return a minimal entry
      const patch = this.patchCache.get(diff_id)!;
      return {
        diff_id,
        file_path: '', // Will be provided by caller
        diff_content: patch,
        stats: this.calculateStatsFromPatch(patch),
        created_at: new Date(),
      };
    }
    return undefined;
  }

  /**
   * Cache diff entry
   */
  private cacheDiff(key: string, entry: DiffCacheEntry): void {
    // Remove oldest entry if cache is full
    if (this.diffCache.size >= this.maxCacheSize) {
      const oldestKey = Array.from(this.diffCache.keys())[0];
      this.diffCache.delete(oldestKey);
    }

    this.diffCache.set(key, entry);
  }

  /**
   * Generate cache key
   */
  private getCacheKey(oldContent: string, newContent: string): string {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(oldContent);
    hash.update(newContent);
    return hash.digest('hex');
  }

  /**
   * Apply unified diff patch to content using the diff library
   */
  applyDiffToContent(content: string, patchContent: string, diff_id?: string): string {
    // Get the patch - either from cache or directly provided
    let patch = patchContent;

    if (diff_id && this.patchCache.has(diff_id)) {
      patch = this.patchCache.get(diff_id)!;
    }

    // Apply the patch using the diff library (handles fuzzy matching automatically)
    const result = applyPatch(content, patch);

    if (result === false) {
      // Patch could not be applied
      throw new Error(
        'Patch could not be applied to file. The file may have been modified.\n' +
        'Possible reasons:\n' +
        '- File content has changed since patch was generated\n' +
        '- Context lines don\'t match (surrounding code changed)\n' +
        '- Line numbers have shifted\n' +
        '\nTry using search_code_context to get current content and regenerate the patch.'
      );
    }

    return result;
  }
}


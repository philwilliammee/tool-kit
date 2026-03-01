/**
 * Context Search Service
 * Handles searching for code context (functions, classes, patterns)
 */

import { SearchType, SearchCodeContextParams, SearchCodeContextResponse, CodeMatch } from './file-editor.types';
import { FileOperationsService } from './file-operations.service';

export class ContextSearchService {
  private fileOps: FileOperationsService;

  constructor(fileOps: FileOperationsService) {
    this.fileOps = fileOps;
  }

  /**
   * Search for code context in file
   */
  async searchCodeContext(params: SearchCodeContextParams): Promise<SearchCodeContextResponse> {
    const {
      file_path,
      search_type,
      search_query,
      context_lines = 3,
      include_imports = true,
    } = params;

    const content = await this.fileOps.readFile(file_path);
    const metadata = await this.fileOps.getFileMetadata(file_path);
    const lines = content.split('\n');
    const imports = include_imports ? this.extractImports(lines) : [];

    let matches: CodeMatch[] = [];

    switch (search_type) {
      case 'function':
        matches = this.searchFunction(lines, search_query, context_lines, imports);
        break;
      case 'class':
        matches = this.searchClass(lines, search_query, context_lines, imports);
        break;
      case 'lines':
        matches = this.searchLines(lines, search_query, context_lines, imports);
        break;
      case 'pattern':
        matches = this.searchPattern(lines, search_query, context_lines, imports);
        break;
    }

    return {
      file_path,
      matches,
      file_metadata: {
        total_lines: metadata.total_lines,
        encoding: metadata.encoding,
        last_modified: metadata.last_modified,
      },
    };
  }

  /**
   * Search for function by name
   */
  private searchFunction(
    lines: string[],
    functionName: string,
    contextLines: number,
    imports: string[]
  ): CodeMatch[] {
    const matches: CodeMatch[] = [];
    const functionRegex = new RegExp(
      `(?:function\\s+${this.escapeRegex(functionName)}|const\\s+${this.escapeRegex(functionName)}\\s*=\\s*(?:async\\s*)?\\(|${this.escapeRegex(functionName)}\\s*:\\s*(?:async\\s*)?\\(|async\\s+${this.escapeRegex(functionName)}\\s*\\()`,
      'i'
    );

    for (let i = 0; i < lines.length; i++) {
      if (functionRegex.test(lines[i])) {
        const match = this.extractFunction(lines, i, contextLines);
        if (match) {
          matches.push({
            ...match,
            context: {
              ...match.context,
              imports,
            },
          });
        }
      }
    }

    return matches;
  }

  /**
   * Extract function block
   */
  private extractFunction(lines: string[], startIndex: number, contextLines: number): CodeMatch | null {
    let braceCount = 0;
    let foundStart = false;
    let endIndex = startIndex;

    // Find function start
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;

      braceCount += openBraces - closeBraces;

      if (!foundStart && openBraces > 0) {
        foundStart = true;
      }

      if (foundStart && braceCount === 0) {
        endIndex = i;
        break;
      }
    }

    if (!foundStart || braceCount !== 0) {
      return null;
    }

    const functionLines = lines.slice(startIndex, endIndex + 1);
    const beforeLines = lines.slice(Math.max(0, startIndex - contextLines), startIndex);
    const afterLines = lines.slice(endIndex + 1, Math.min(lines.length, endIndex + 1 + contextLines));

    return {
      start_line: startIndex + 1, // 1-indexed
      end_line: endIndex + 1,
      content: functionLines.join('\n'),
      context: {
        before: beforeLines,
        after: afterLines,
      },
    };
  }

  /**
   * Search for class by name
   */
  private searchClass(lines: string[], className: string, contextLines: number, imports: string[]): CodeMatch[] {
    const matches: CodeMatch[] = [];
    const classRegex = new RegExp(
      `(?:class|interface|type)\\s+${this.escapeRegex(className)}`,
      'i'
    );

    for (let i = 0; i < lines.length; i++) {
      if (classRegex.test(lines[i])) {
        const match = this.extractClass(lines, i, contextLines);
        if (match) {
          matches.push({
            ...match,
            context: {
              ...match.context,
              imports,
            },
          });
        }
      }
    }

    return matches;
  }

  /**
   * Extract class block
   */
  private extractClass(lines: string[], startIndex: number, contextLines: number): CodeMatch | null {
    let braceCount = 0;
    let foundStart = false;
    let endIndex = startIndex;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      const openBraces = (line.match(/\{/g) || []).length;
      const closeBraces = (line.match(/\}/g) || []).length;

      braceCount += openBraces - closeBraces;

      if (!foundStart && openBraces > 0) {
        foundStart = true;
      }

      if (foundStart && braceCount === 0) {
        endIndex = i;
        break;
      }
    }

    if (!foundStart || braceCount !== 0) {
      return null;
    }

    const classLines = lines.slice(startIndex, endIndex + 1);
    const beforeLines = lines.slice(Math.max(0, startIndex - contextLines), startIndex);
    const afterLines = lines.slice(endIndex + 1, Math.min(lines.length, endIndex + 1 + contextLines));

    return {
      start_line: startIndex + 1,
      end_line: endIndex + 1,
      content: classLines.join('\n'),
      context: {
        before: beforeLines,
        after: afterLines,
      },
    };
  }

  /**
   * Search by line range
   */
  private searchLines(lines: string[], query: string, contextLines: number, imports: string[]): CodeMatch[] {
    const range = this.parseLineRange(query);
    if (!range) {
      return [];
    }

    const start = Math.max(0, range.start - contextLines - 1);
    const end = Math.min(lines.length, range.end + contextLines);
    const content = lines.slice(range.start - 1, range.end).join('\n');
    const beforeLines = lines.slice(start, range.start - 1);
    const afterLines = lines.slice(range.end, end);

    return [
      {
        start_line: range.start,
        end_line: range.end,
        content,
        context: {
          before: beforeLines,
          after: afterLines,
          imports,
        },
      },
    ];
  }

  /**
   * Parse line range (e.g., "10-20" or "10")
   */
  private parseLineRange(query: string): { start: number; end: number } | null {
    const parts = query.split('-').map((p) => parseInt(p.trim(), 10));
    if (parts.length === 1) {
      return { start: parts[0], end: parts[0] };
    } else if (parts.length === 2) {
      return { start: parts[0], end: parts[1] };
    }
    return null;
  }

  /**
   * Search by pattern (regex)
   */
  private searchPattern(lines: string[], pattern: string, contextLines: number, imports: string[]): CodeMatch[] {
    const matches: CodeMatch[] = [];
    let regex: RegExp;

    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // Invalid regex, treat as literal string
      regex = new RegExp(this.escapeRegex(pattern), 'i');
    }

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        const matchLines = lines.slice(start, end);

        matches.push({
          start_line: i + 1,
          end_line: i + 1,
          content: lines[i],
          context: {
            before: lines.slice(start, i),
            after: lines.slice(i + 1, end),
            imports,
          },
        });
      }
    }

    return matches;
  }

  /**
   * Extract import statements from file
   */
  private extractImports(lines: string[]): string[] {
    const imports: string[] = [];
    const importRegex = /^(import|export|require)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (importRegex.test(line.trim())) {
        imports.push(line);
      }
      // Stop after first non-import/export line (usually after imports)
      if (line.trim() && !importRegex.test(line.trim()) && imports.length > 0) {
        // Allow a few blank lines after imports
        const lastImportIndex = lines.indexOf(imports[imports.length - 1]);
        if (i - lastImportIndex > 2) {
          break;
        }
      }
    }

    return imports;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}


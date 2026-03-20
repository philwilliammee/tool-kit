/**
 * Context Search Service
 * Handles searching for code context (functions, classes, patterns).
 * Uses system grep for matching — faster on large files, full ERE regex support,
 * handles encoding gracefully. Falls back to JS regex if grep is unavailable.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { SearchType, SearchCodeContextParams, SearchCodeContextResponse, CodeMatch } from './file-editor.types';
import { FileOperationsService } from './file-operations.service';

const execFileAsync = promisify(execFile);

export class ContextSearchService {
  private fileOps: FileOperationsService;

  constructor(fileOps: FileOperationsService) {
    this.fileOps = fileOps;
  }

  /**
   * Search for code context in file.
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
        matches = await this.searchFunction(file_path, lines, search_query, context_lines, imports);
        break;
      case 'class':
        matches = await this.searchClass(file_path, lines, search_query, context_lines, imports);
        break;
      case 'lines':
        matches = this.searchLines(lines, search_query, context_lines, imports);
        break;
      case 'pattern':
        matches = await this.searchPattern(file_path, lines, search_query, context_lines, imports);
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

  // ---------------------------------------------------------------------------
  // Grep helper
  // ---------------------------------------------------------------------------

  /**
   * Run grep -nEi on a file and return 0-indexed line numbers of matches.
   * Returns null if grep is not available (caller should fall back to JS regex).
   * Grep exit code 1 = no matches (not an error) → returns empty array.
   */
  private async grepLines(filePath: string, pattern: string): Promise<number[] | null> {
    try {
      const { stdout } = await execFileAsync('grep', ['-nEi', pattern, filePath]);
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => parseInt(line.split(':')[0], 10) - 1); // 1-indexed → 0-indexed
    } catch (err: any) {
      if (err.code === 1) return []; // grep found no matches — not an error
      return null;                   // grep unavailable or bad regex → fall back
    }
  }

  // ---------------------------------------------------------------------------
  // Search implementations
  // ---------------------------------------------------------------------------

  /**
   * Find a function/method by name.
   * Uses grep to locate the definition line, then extracts the full body via brace counting.
   * Handles: plain functions, arrow functions, object methods, TS class methods (any modifiers).
   */
  private async searchFunction(
    filePath: string,
    lines: string[],
    functionName: string,
    contextLines: number,
    imports: string[]
  ): Promise<CodeMatch[]> {
    const n = this.escapeForGrep(functionName);
    const pattern =
      `(function[[:space:]]+${n}` +
      `|const[[:space:]]+${n}[[:space:]]*=` +
      `|${n}[[:space:]]*:[[:space:]]*(async[[:space:]]+)?\\(` +                        // object method
      `|(public[[:space:]]+|private[[:space:]]+|protected[[:space:]]+|static[[:space:]]+|async[[:space:]]+|override[[:space:]]+|abstract[[:space:]]+)*${n}[[:space:]]*\\(` + // TS class method
      `)`;

    const grepResult = await this.grepLines(filePath, pattern);
    const startIndices = grepResult ?? this.jsMatchLines(lines, this.buildFunctionRegex(functionName));

    const matches: CodeMatch[] = [];
    for (const i of startIndices) {
      const match = this.extractBlock(lines, i, contextLines);
      if (match) matches.push({ ...match, context: { ...match.context, imports } });
    }
    return matches;
  }

  /**
   * Find a class, interface, or type by name.
   * Uses grep to locate the definition line, then extracts the full body.
   */
  private async searchClass(
    filePath: string,
    lines: string[],
    className: string,
    contextLines: number,
    imports: string[]
  ): Promise<CodeMatch[]> {
    const n = this.escapeForGrep(className);
    const pattern = `(class|interface|type)[[:space:]]+${n}`;

    const grepResult = await this.grepLines(filePath, pattern);
    const startIndices = grepResult ?? this.jsMatchLines(
      lines,
      new RegExp(`(?:class|interface|type)\\s+${this.escapeRegex(className)}`, 'i')
    );

    const matches: CodeMatch[] = [];
    for (const i of startIndices) {
      const match = this.extractBlock(lines, i, contextLines);
      if (match) matches.push({ ...match, context: { ...match.context, imports } });
    }
    return matches;
  }

  /**
   * Search by regex pattern.
   * Delegates entirely to grep — full ERE regex, much faster on large files.
   */
  private async searchPattern(
    filePath: string,
    lines: string[],
    pattern: string,
    contextLines: number,
    imports: string[]
  ): Promise<CodeMatch[]> {
    const grepResult = await this.grepLines(filePath, pattern);

    let matchedIndices: number[];
    if (grepResult !== null) {
      matchedIndices = grepResult;
    } else {
      // Fall back to JS regex
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        regex = new RegExp(this.escapeRegex(pattern), 'i');
      }
      matchedIndices = this.jsMatchLines(lines, regex);
    }

    return matchedIndices.map((i) => {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length, i + contextLines + 1);
      return {
        start_line: i + 1,
        end_line: i + 1,
        content: lines[i],
        context: {
          before: lines.slice(start, i),
          after: lines.slice(i + 1, end),
          imports,
        },
      };
    });
  }

  /**
   * Return lines within a given line range.
   */
  private searchLines(lines: string[], query: string, contextLines: number, imports: string[]): CodeMatch[] {
    const range = this.parseLineRange(query);
    if (!range) return [];

    const start = Math.max(0, range.start - contextLines - 1);
    const end = Math.min(lines.length, range.end + contextLines);

    return [
      {
        start_line: range.start,
        end_line: range.end,
        content: lines.slice(range.start - 1, range.end).join('\n'),
        context: {
          before: lines.slice(start, range.start - 1),
          after: lines.slice(range.end, end),
          imports,
        },
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Block extraction (brace-counting — still needed after grep finds the start)
  // ---------------------------------------------------------------------------

  private extractBlock(lines: string[], startIndex: number, contextLines: number): CodeMatch | null {
    let braceCount = 0;
    let foundStart = false;
    let endIndex = startIndex;

    for (let i = startIndex; i < lines.length; i++) {
      const open = (lines[i].match(/\{/g) || []).length;
      const close = (lines[i].match(/\}/g) || []).length;
      braceCount += open - close;
      if (!foundStart && open > 0) foundStart = true;
      if (foundStart && braceCount === 0) { endIndex = i; break; }
    }

    if (!foundStart || braceCount !== 0) return null;

    return {
      start_line: startIndex + 1,
      end_line: endIndex + 1,
      content: lines.slice(startIndex, endIndex + 1).join('\n'),
      context: {
        before: lines.slice(Math.max(0, startIndex - contextLines), startIndex),
        after: lines.slice(endIndex + 1, Math.min(lines.length, endIndex + 1 + contextLines)),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // JS fallbacks (used when grep is unavailable)
  // ---------------------------------------------------------------------------

  private jsMatchLines(lines: string[], regex: RegExp): number[] {
    return lines.reduce<number[]>((acc, line, i) => {
      if (regex.test(line)) acc.push(i);
      return acc;
    }, []);
  }

  private buildFunctionRegex(functionName: string): RegExp {
    const n = this.escapeRegex(functionName);
    return new RegExp(
      `(?:function\\s+${n}` +
      `|const\\s+${n}\\s*=\\s*(?:async\\s*)?\\(` +
      `|${n}\\s*:\\s*(?:async\\s*)?\\(` +
      `|(?:(?:public|private|protected|static|async|override|abstract)\\s+)*${n}\\s*\\()`,
      'i'
    );
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private extractImports(lines: string[]): string[] {
    const imports: string[] = [];
    const importRegex = /^(import|export|require)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (importRegex.test(line.trim())) {
        imports.push(line);
      } else if (line.trim() && imports.length > 0) {
        const lastImportIndex = lines.indexOf(imports[imports.length - 1]);
        if (i - lastImportIndex > 2) break;
      }
    }

    return imports;
  }

  private parseLineRange(query: string): { start: number; end: number } | null {
    const parts = query.split('-').map((p) => parseInt(p.trim(), 10));
    if (parts.length === 1 && !isNaN(parts[0])) return { start: parts[0], end: parts[0] };
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return { start: parts[0], end: parts[1] };
    return null;
  }

  /** Escape special chars for use inside a grep -E pattern. */
  private escapeForGrep(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Escape special chars for use in a JS RegExp. */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

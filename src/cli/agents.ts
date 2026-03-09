import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Loads AGENTS.md files from global and project locations.
 * Returns a formatted block, or empty string if no files found.
 *
 * Priority / order:
 *   1. ~/.tool-kit/AGENTS.md          (user-global)
 *   2. <cwd>/.tool-kit/AGENTS.md      (project, committed)
 *   3. <cwd>/.tool-kit/AGENTS.local.md (project-local, gitignored)
 */
export function loadAgentsInstructions(cwd: string): string {
  const userGlobal = readIfExists(path.join(os.homedir(), '.tool-kit', 'AGENTS.md'));
  const project = readIfExists(path.join(cwd, '.tool-kit', 'AGENTS.md'));
  const projectLocal = readIfExists(path.join(cwd, '.tool-kit', 'AGENTS.local.md'));

  const sections: string[] = [];

  if (userGlobal) {
    sections.push(`[agents: user]\n${userGlobal}`);
  }

  // Merge project + project-local under [agents: project]
  const projectCombined = [project, projectLocal].filter(Boolean).join('\n\n');
  if (projectCombined) {
    sections.push(`[agents: project]\n${projectCombined}`);
  }

  return sections.join('\n\n');
}

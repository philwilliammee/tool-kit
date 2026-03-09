import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import * as yaml from 'js-yaml';
import OpenAI from 'openai';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  'disable-auto-invoke'?: boolean;
  'user-invocable'?: boolean;
  hooks?: Record<string, unknown>;
}

export interface ServerSkill {
  name: string;
  description: string;
  dirPath: string;
  body: string;
  frontmatter: SkillFrontmatter;
  disableAutoInvoke: boolean;
}

interface RenderContext {
  args: string;
  sessionId: string;
  cwd: string;
}

function parseSkillMd(filePath: string, dirPath: string): ServerSkill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let frontmatter: SkillFrontmatter = {};
  let body = raw;

  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('\n---', 3);
    if (endIdx !== -1) {
      const yamlStr = raw.slice(3, endIdx).trim();
      try {
        frontmatter = (yaml.load(yamlStr) as SkillFrontmatter) ?? {};
      } catch { /* bad yaml — ignore */ }
      body = raw.slice(endIdx + 4).trimStart();
    }
  }

  const dirName = path.basename(dirPath);
  const name = (frontmatter.name ?? dirName).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 64);
  const description = frontmatter.description ?? body.split('\n').find(l => l.trim()) ?? '';

  return {
    name,
    description: description.trim(),
    dirPath,
    body,
    frontmatter,
    disableAutoInvoke: frontmatter['disable-auto-invoke'] === true,
  };
}

export class SkillsService {
  private registry = new Map<string, ServerSkill>();

  constructor(cwd: string) {
    this.scan(path.join(os.homedir(), '.tool-kit', 'skills'));
    this.scan(path.join(cwd, '.tool-kit', 'skills'));
    this.scan(path.join(cwd, '.tool-kit', 'skills.local'));
  }

  private scan(baseDir: string): void {
    if (!fs.existsSync(baseDir)) return;
    let entries: string[];
    try { entries = fs.readdirSync(baseDir); } catch { return; }
    for (const entry of entries) {
      const dirPath = path.join(baseDir, entry);
      try { if (!fs.lstatSync(dirPath).isDirectory()) continue; } catch { continue; }
      const skillFile = path.join(dirPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const skill = parseSkillMd(skillFile, dirPath);
        if (skill) this.registry.set(skill.name, skill);
      }
    }
  }

  get(name: string): ServerSkill | undefined {
    return this.registry.get(name.toLowerCase());
  }

  render(name: string, argsStr: string, ctx: RenderContext): string | null {
    const skill = this.get(name);
    if (!skill) return null;

    let body = skill.body;

    // 1. !`command` substitutions — run in session's cwd
    body = body.replace(/!`([^`]+)`/g, (_match, cmd: string) => {
      try {
        return execSync(cmd, { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trimEnd();
      } catch (err) {
        return `[command failed: ${(err as Error).message}]`;
      }
    });

    // 2. Positional args $0, $1, ...
    const argParts = argsStr ? argsStr.split(/\s+/) : [];
    body = body.replace(/\$(\d+)/g, (_m, idx: string) => argParts[parseInt(idx, 10)] ?? '');

    // 3. $ARGUMENTS
    if (body.includes('$ARGUMENTS')) {
      body = body.replace(/\$ARGUMENTS/g, argsStr);
    } else if (argsStr) {
      body += `\n\nARGUMENTS: ${argsStr}`;
    }

    // 4. ${VAR} substitutions
    body = body.replace(/\$\{TOOL_KIT_SKILL_DIR\}/g, skill.dirPath);
    body = body.replace(/\$\{TOOL_KIT_SESSION_ID\}/g, ctx.sessionId);
    body = body.replace(/\$\{TOOL_KIT_WORKING_DIR\}/g, ctx.cwd);

    return `[skill: ${skill.name}]\n${body}`;
  }

  /**
   * Returns an OpenAI Skill tool definition if any auto-invocable skills exist, else null.
   * The LLM calls this tool to inject a skill's context into the conversation.
   */
  buildSkillTool(): OpenAI.ChatCompletionTool | null {
    const autoSkills = Array.from(this.registry.values()).filter(s => !s.disableAutoInvoke);
    if (autoSkills.length === 0) return null;

    return {
      type: 'function',
      function: {
        name: 'Skill',
        description:
          'Invoke a skill to inject specialised context and instructions into the conversation. ' +
          'Use when the task matches one of the available skill descriptions.\n\n' +
          'Available skills:\n' +
          autoSkills.map(s => `- ${s.name}: ${s.description}`).join('\n'),
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The skill name to invoke',
              enum: autoSkills.map(s => s.name),
            },
            arguments: {
              type: 'string',
              description: 'Optional arguments passed to the skill ($ARGUMENTS substitution)',
            },
          },
          required: ['name'],
        },
      },
    };
  }
}

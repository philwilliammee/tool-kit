import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import * as yaml from "js-yaml";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-auto-invoke"?: boolean;
  "user-invocable"?: boolean;
  hooks?: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  dirPath: string;
  body: string;
  frontmatter: SkillFrontmatter;
  userInvocable: boolean;
  disableAutoInvoke: boolean;
}

// Map from skill name → Skill (last writer wins — highest priority location loaded last)
const skillRegistry = new Map<string, Skill>();

export function parseSkillMd(filePath: string, dirPath: string): Skill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let frontmatter: SkillFrontmatter = {};
  let body = raw;

  // Extract YAML frontmatter delimited by ---
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const yamlStr = raw.slice(3, endIdx).trim();
      try {
        frontmatter = (yaml.load(yamlStr) as SkillFrontmatter) ?? {};
      } catch {
        /* bad yaml — treat as no frontmatter */
      }
      body = raw.slice(endIdx + 4).trimStart();
    }
  }

  const dirName = path.basename(dirPath);
  const name = (frontmatter.name ?? dirName)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 64);
  const description =
    frontmatter.description ?? body.split("\n").find((l) => l.trim()) ?? "";

  return {
    name,
    description: description.trim(),
    dirPath,
    body,
    frontmatter,
    userInvocable: frontmatter["user-invocable"] !== false,
    disableAutoInvoke: frontmatter["disable-auto-invoke"] === true,
  };
}

function scanSkillsDir(baseDir: string): void {
  if (!fs.existsSync(baseDir)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dirPath = path.join(baseDir, entry);
    try {
      if (!fs.lstatSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillFile = path.join(dirPath, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      const skill = parseSkillMd(skillFile, dirPath);
      if (skill) skillRegistry.set(skill.name, skill);
    }
  }
}

/**
 * Load skills from all three tiers. Call once at startup.
 * Priority (highest last — overwrites lower priority):
 *   global → project → project-local
 */
export function loadSkills(cwd: string): void {
  skillRegistry.clear();
  scanSkillsDir(path.join(os.homedir(), ".tool-kit", "skills"));
  scanSkillsDir(path.join(cwd, ".tool-kit", "skills"));
  scanSkillsDir(path.join(cwd, ".tool-kit", "skills.local"));
}

export function listSkills(): { name: string; description: string }[] {
  return Array.from(skillRegistry.values())
    .filter((s) => s.userInvocable)
    .map((s) => ({ name: s.name, description: s.description }));
}

export function getSkill(name: string): Skill | undefined {
  return skillRegistry.get(name.toLowerCase());
}

interface RenderContext {
  args: string;
  sessionId: string;
  cwd: string;
}

/**
 * Render a skill's body with all substitutions applied.
 * Returns `[skill: <name>]\n<rendered body>` or null if skill not found.
 */
export function renderSkill(
  name: string,
  argsStr: string,
  ctx: RenderContext,
): string | null {
  const skill = getSkill(name);
  if (!skill) return null;

  let body = skill.body;

  // 1. !`command` substitutions — run in session's cwd
  body = body.replace(/!`([^`]+)`/g, (_match, cmd: string) => {
    try {
      return execSync(cmd, {
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trimEnd();
    } catch (err) {
      return `[command failed: ${(err as Error).message}]`;
    }
  });

  // 2. Positional args $0, $1, ...
  const argParts = argsStr ? argsStr.split(/\s+/) : [];
  body = body.replace(
    /\$(\d+)/g,
    (_match, idx: string) => argParts[parseInt(idx, 10)] ?? "",
  );

  // 3. $ARGUMENTS — full arg string
  if (body.includes("$ARGUMENTS")) {
    body = body.replace(/\$ARGUMENTS/g, argsStr);
  } else if (argsStr) {
    body = body + `\n\nARGUMENTS: ${argsStr}`;
  }

  // 4. ${VAR} substitutions
  body = body.replace(/\$\{TOOL_KIT_SKILL_DIR\}/g, skill.dirPath);
  body = body.replace(/\$\{TOOL_KIT_SESSION_ID\}/g, ctx.sessionId);
  body = body.replace(/\$\{TOOL_KIT_WORKING_DIR\}/g, ctx.cwd);

  return `[skill: ${skill.name}]\n${body}`;
}

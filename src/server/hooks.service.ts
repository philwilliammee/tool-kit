import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import axios from 'axios';

// ── Settings schema ────────────────────────────────────────────────────────────

interface CommandHandlerConfig {
  type: 'command';
  command: string;
  timeout?: number;
  async?: boolean;
}

interface HttpHandlerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
}

type HandlerConfig = CommandHandlerConfig | HttpHandlerConfig;

interface HookGroup {
  matcher?: string;
  hooks: HandlerConfig[];
}

interface HooksSettings {
  hooks?: Record<string, HookGroup[]>;
}

// ── Hook output ────────────────────────────────────────────────────────────────

export interface HookOutput {
  contextInjection?: string;
  decision?: 'block';
  reason?: string;
}

// ── Service ────────────────────────────────────────────────────────────────────

function loadSettings(filePath: string): HooksSettings {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HooksSettings;
  } catch {
    return {};
  }
}

function mergeSettings(...configs: HooksSettings[]): HooksSettings {
  const merged: HooksSettings = { hooks: {} };
  for (const cfg of configs) {
    if (!cfg.hooks) continue;
    for (const [event, groups] of Object.entries(cfg.hooks)) {
      if (!merged.hooks![event]) {
        merged.hooks![event] = [];
      }
      merged.hooks![event].push(...groups);
    }
  }
  return merged;
}

function runCommandHook(
  handler: CommandHandlerConfig,
  input: Record<string, unknown>,
  cwd: string,
): Promise<HookOutput> {
  return new Promise((resolve) => {
    const timeoutMs = (handler.timeout ?? 30) * 1000;
    let stdout = '';
    let timedOut = false;

    const child = spawn('sh', ['-c', handler.command], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      console.error(`[hooks] Command hook timed out: ${handler.command}`);
      resolve({});
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error(`[hooks] Hook stderr: ${msg}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) {
        console.error(`[hooks] Command hook exited with code ${code}: ${handler.command}`);
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as HookOutput);
      } catch {
        resolve({});
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[hooks] Failed to spawn hook: ${err.message}`);
      resolve({});
    });

    // Write input JSON to stdin then close it
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function resolveEnvVars(value: string, allowed: string[]): string {
  return value.replace(/\$\{?(\w+)\}?/g, (match, name: string) => {
    if (allowed.includes(name)) return process.env[name] ?? match;
    return match;
  });
}

async function runHttpHook(
  handler: HttpHandlerConfig,
  input: Record<string, unknown>,
): Promise<HookOutput> {
  const timeoutMs = (handler.timeout ?? 10) * 1000;
  const allowed = handler.allowedEnvVars ?? [];

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const [k, v] of Object.entries(handler.headers ?? {})) {
    headers[k] = resolveEnvVars(v, allowed);
  }

  try {
    const resp = await axios.post(handler.url, input, { headers, timeout: timeoutMs });
    return (resp.data as HookOutput) ?? {};
  } catch (err) {
    console.error(`[hooks] HTTP hook error: ${(err as Error).message}`);
    return {};
  }
}

async function runHandler(
  handler: HandlerConfig,
  input: Record<string, unknown>,
  cwd: string,
): Promise<HookOutput> {
  if (handler.type === 'command') {
    if (handler.async) {
      runCommandHook(handler, input, cwd).catch(() => {});
      return {};
    }
    return runCommandHook(handler, input, cwd);
  } else {
    return runHttpHook(handler, input);
  }
}

// ── Public service class ───────────────────────────────────────────────────────

export class HooksService {
  private settings: HooksSettings;
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    const global = loadSettings(path.join(os.homedir(), '.tool-kit', 'settings.json'));
    const project = loadSettings(path.join(cwd, '.tool-kit', 'settings.json'));
    const local = loadSettings(path.join(cwd, '.tool-kit', 'settings.local.json'));
    this.settings = mergeSettings(global, project, local);
  }

  /**
   * Fire an event. Returns the first block decision encountered, or accumulated contextInjection.
   */
  async fire(
    event: string,
    input: Record<string, unknown>,
    toolName?: string,
  ): Promise<HookOutput> {
    const groups = this.settings.hooks?.[event] ?? [];
    let contextInjection = '';

    for (const group of groups) {
      // Check matcher (only relevant for tool events)
      if (group.matcher && group.matcher !== '*' && toolName) {
        try {
          if (!new RegExp(group.matcher).test(toolName)) continue;
        } catch {
          continue;
        }
      }

      for (const handler of group.hooks ?? []) {
        const output = await runHandler(handler, input, this.cwd);

        if (output.decision === 'block') {
          return output;
        }
        if (output.contextInjection) {
          contextInjection += (contextInjection ? '\n' : '') + output.contextInjection;
        }
      }
    }

    return contextInjection ? { contextInjection } : {};
  }

  /** Returns a summary of configured hook events and group counts for display. */
  configSummary(): string {
    const hooks = this.settings.hooks ?? {};
    const events = Object.entries(hooks).map(
      ([event, groups]) => `  ${event}: ${groups.length} group(s)`,
    );
    return events.length ? events.join('\n') : '  (no hooks configured)';
  }
}

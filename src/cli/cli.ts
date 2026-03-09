#!/usr/bin/env node
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { Command } from 'commander';
import OpenAI from 'openai';
import {
  loadSession,
  saveSession,
  cleanupOldSessions,
  addMessage,
  addToolCall,
  getApiMessages,
  sessionStats,
  Session,
  SkillInjection,
} from './session';
import { streamQuery, ToolCallChunk, ToolResult } from './client';
import {
  printContent,
  printNewline,
  printToolCall,
  printError,
  printInfo,
  printBanner,
  startSpinner,
} from './display';
import { loadAgentsInstructions } from './agents';
import { loadSkills, listSkills, renderSkill } from './skills';
import { HooksService } from '../server/hooks.service';

const DEFAULT_SERVER = 'http://localhost:3333';
const DEFAULT_MODEL = process.env.MODEL ?? 'anthropic.claude-4.5-sonnet';

function gitBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function buildSystemPrompt(cwd: string, session: Session): string {
  const branch = gitBranch();
  const lines = [
    'You are tool-kit, a CLI AI agent. You have access to bash execution, GitHub API (octokit), and intelligent file editing tools.',
    '',
    '## Context',
    `Working directory: ${cwd}`,
    `User: ${os.userInfo().username}@${os.hostname()}`,
    `Date: ${new Date().toLocaleString()}`,
    `Node: ${process.version}`,
    `Platform: ${process.platform}`,
  ];
  if (branch) lines.push(`Git branch: ${branch}`);
  if (session.messages.length > 0) {
    lines.push('', `## Session`, `${session.messages.length} messages, ${session.toolCalls.length} tool calls today`);
  }
  lines.push('', '## Instructions', 'Use tools to complete tasks. Be concise and direct in responses.', `Always pass cwd: "${cwd}" when invoking bash tools so commands run in the correct working directory.`);

  const agentsBlock = loadAgentsInstructions(cwd);
  if (agentsBlock) {
    lines.push('', '## User Instructions', agentsBlock);
  }

  return lines.join('\n');
}

async function runQuery(
  query: string,
  session: Session,
  serverUrl: string,
  token: string,
  model: string,
): Promise<void> {
  const cwd = process.cwd();
  const systemPrompt = buildSystemPrompt(cwd, session);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Prepend skill injections as system messages
  for (const inj of session.skillInjections) {
    messages.push({ role: 'system', content: inj.content });
  }

  messages.push(...getApiMessages(session));
  messages.push({ role: 'user', content: query });

  addMessage(session, 'user', query);

  const spinner = startSpinner('thinking…');
  let spinnerStopped = false;
  let assistantContent = '';

  // Accumulate tool calls to display with their results
  const pendingCalls = new Map<string, ToolCallChunk>();

  try {
    await streamQuery({
      serverUrl,
      token,
      messages,
      model,
      workingDirectory: cwd,
      callbacks: {
        onContent(delta) {
          if (!spinnerStopped) {
            spinner.stop();
            spinnerStopped = true;
          }
          printContent(delta);
          assistantContent += delta;
        },
        onToolCall(chunk) {
          if (!spinnerStopped) {
            spinner.stop();
            spinnerStopped = true;
          }
          pendingCalls.set(chunk.id, chunk);
        },
        onToolResult(result) {
          const call = pendingCalls.get(result.toolCallId);
          if (call) {
            printToolCall(call, result);
            pendingCalls.delete(result.toolCallId);
            addToolCall(session, result.name, call.arguments, result.content);
          }
        },
        onComplete() {
          if (!spinnerStopped) {
            spinner.stop();
            spinnerStopped = true;
          }
          if (assistantContent) printNewline();
        },
        onError(message) {
          if (!spinnerStopped) {
            spinner.stop();
            spinnerStopped = true;
          }
          printError(message);
        },
      },
    });
  } finally {
    if (!spinnerStopped) {
      spinner.stop();
      spinnerStopped = true;
    }
  }

  if (assistantContent) addMessage(session, 'assistant', assistantContent);
  saveSession(session);
}

async function interactiveMode(serverUrl: string, token: string, model: string, newSession: boolean): Promise<void> {
  const cwd = process.cwd();
  cleanupOldSessions();
  loadSkills(cwd);

  const session: Session = newSession
    ? {
        sessionId: require('uuid').v4(),
        sessionKey: 'new',
        workingDirectory: cwd,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messages: [],
        toolCalls: [],
        filesViewed: [],
        skillInjections: [],
      }
    : loadSession(cwd);

  printBanner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Keep stdin and readline alive across async queries
  rl.resume();
  process.stdin.resume();

  // Prevent the event loop from draining between queries
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  rl.on('close', () => clearInterval(keepAlive));

  rl.setPrompt('\x1b[36m❯\x1b[0m ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    rl.pause();

    try {
      if (!input) {
        // ignore empty lines
      } else if (input === 'exit' || input === 'quit') {
        rl.close();
        return;
      } else if (input === '.session') {
        printInfo(sessionStats(session));
      } else if (input === '.clear') {
        session.messages = [];
        session.skillInjections = [];
        saveSession(session);
        printInfo('Session messages cleared.');
      } else if (input === '.tools') {
        if (session.toolCalls.length === 0) {
          printInfo('No tool calls this session.');
        } else {
          for (const tc of session.toolCalls) {
            printInfo(`[${new Date(tc.timestamp).toLocaleTimeString()}] ${tc.tool} → ${tc.resultLength} bytes`);
          }
        }
      } else if (input === '.skills') {
        const skills = listSkills();
        if (skills.length === 0) {
          printInfo('No skills found. Place SKILL.md files in ~/.tool-kit/skills/<name>/ or .tool-kit/skills/<name>/');
        } else {
          const maxName = Math.max(...skills.map(s => s.name.length), 4);
          printInfo('Available skills:');
          printInfo(`${'NAME'.padEnd(maxName)}  DESCRIPTION`);
          for (const s of skills) {
            printInfo(`${s.name.padEnd(maxName)}  ${s.description}`);
          }
        }
      } else if (input === '.hooks') {
        const hooks = new HooksService(cwd);
        printInfo('Active hook configuration:\n' + hooks.configSummary());
      } else if (input.startsWith('/')) {
        // Skill invocation: /skill-name [args...]
        const spaceIdx = input.indexOf(' ');
        const skillName = (spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)).toLowerCase();
        const argsStr = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();

        const rendered = renderSkill(skillName, argsStr, {
          args: argsStr,
          sessionId: session.sessionId,
          cwd,
        });

        if (!rendered) {
          printError(`Skill not found: ${skillName}. Type .skills to list available skills.`);
        } else {
          const injection: SkillInjection = {
            name: skillName,
            content: rendered,
            injectedAt: new Date().toISOString(),
          };
          session.skillInjections.push(injection);
          saveSession(session);
          printInfo(`Skill '${skillName}' injected into context.`);
        }
      } else {
        await runQuery(input, session, serverUrl, token, model);
      }
    } catch (err) {
      printError((err as Error).message);
    }

    rl.resume();
    rl.prompt();
  });

  rl.on('SIGINT', () => rl.prompt());

  // Wait until the interface is explicitly closed (exit/quit or Ctrl+D)
  await new Promise<void>(resolve => rl.once('close', resolve));
  process.exit(0);
}

async function oneShotMode(
  query: string,
  serverUrl: string,
  token: string,
  model: string,
  newSession: boolean,
): Promise<void> {
  const cwd = process.cwd();
  cleanupOldSessions();
  loadSkills(cwd);

  const session: Session = newSession
    ? {
        sessionId: require('uuid').v4(),
        sessionKey: 'oneshot',
        workingDirectory: cwd,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messages: [],
        toolCalls: [],
        filesViewed: [],
        skillInjections: [],
      }
    : loadSession(cwd);

  try {
    await runQuery(query, session, serverUrl, token, model);
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
}

const program = new Command();
program
  .name('tool-kit')
  .description('CLI AI agent backed by LiteLLM and MCP servers')
  .version('1.0.0')
  .argument('[query]', 'One-shot query (omit for interactive REPL)')
  .option('-s, --server <url>', 'Backend server URL', process.env.TOOL_KIT_SERVER ?? DEFAULT_SERVER)
  .option('-t, --token <token>', 'Bearer token', process.env.API_TOKEN ?? '')
  .option('-m, --model <model>', 'LiteLLM model string', DEFAULT_MODEL)
  .option('--new-session', 'Start a fresh session (ignore today\'s saved session)', false)
  .action(async (query: string | undefined, opts) => {
    const { server, token, model, newSession } = opts;

    if (!token) {
      printError('API_TOKEN is required. Set it in your .env or pass --token.');
      process.exit(1);
    }

    if (query) {
      await oneShotMode(query, server, token, model, newSession);
    } else {
      await interactiveMode(server, token, model, newSession);
    }
  });

program.parseAsync(process.argv);

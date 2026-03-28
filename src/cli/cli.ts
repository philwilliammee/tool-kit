#!/usr/bin/env node
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { Command } from "commander";
import OpenAI from "openai";
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
} from "./session";
import { streamQuery, ToolCallChunk, ToolResult, UsageInfo } from "./client";
import {
  printContent,
  printNewline,
  printToolCall,
  printError,
  printInfo,
  printBanner,
  startSpinner,
} from "./display";
import { loadAgentsInstructions } from "./agents";
import { loadSkills, listSkills, renderSkill } from "./skills";
import { HooksService } from "../server/hooks.service";

const DEFAULT_SERVER = "http://localhost:3333";
const DEFAULT_MODEL = process.env.MODEL ?? "anthropic.claude-4.5-sonnet";

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function getBashHistory(lines: number): string[] {
  try {
    const histFile = path.join(os.homedir(), ".bash_history");
    const content = fs.readFileSync(histFile, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .slice(-lines);
  } catch {
    return [];
  }
}

function formatTokens(n: number): string {
  if (n === 0) return "";
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function buildPrompt(session: Session): string {
  const t = formatTokens(session.totalTokens);
  const prefix = t ? `\x1b[2m[${t}]\x1b[0m ` : "";
  return `${prefix}\x1b[36m❯\x1b[0m `;
}

function buildSystemPrompt(
  cwd: string,
  session: Session,
  historyLines: string[] = [],
): string {
  const branch = gitBranch();
  const agentsBlock = loadAgentsInstructions(cwd);

  return `You are tool-kit, a CLI AI agent. You have access to bash execution, GitHub API (octokit), and intelligent file editing tools.

## Context
Working directory: ${cwd}
User: ${os.userInfo().username}@${os.hostname()}
Date: ${new Date().toLocaleString()}
Node: ${process.version}
Platform: ${process.platform}${branch ? `\nGit branch: ${branch}` : ""}${session.messages.length > 0 ? `\n\n## Session\n${session.messages.length} messages, ${session.toolCalls.length} tool calls today` : ""}${historyLines.length > 0 ? `\n\n## Recent Terminal History\n\`\`\`\n${historyLines.join("\n")}\n\`\`\`` : ""}

## Instructions
Use tools to complete tasks. Be concise and direct in responses.
Always pass cwd: "${cwd}" when invoking bash tools so commands run in the correct working directory.

## Tool Use — Critical Rules
- Your available tools are provided to you directly. NEVER search for tool configurations, read config files, or inspect the filesystem to discover what tools exist.
- When asked to call a specific tool by name, call it immediately. Do not search for it first.
- NEVER fabricate tool results, file contents, command output, or API responses. If you need information, use a tool to get it.
- If a tool call fails or returns an error, report the actual error. Do not invent a plausible-sounding result.
- If a requested tool is not in your tool list, say so clearly. Do not attempt workarounds or pretend the call succeeded.
- If you are unsure what a tool will return, call it and find out. Do not guess.
- Only report what tools actually return. Never summarise, paraphrase, or extend tool output with invented content.${agentsBlock ? `\n\n## User Instructions\n${agentsBlock}` : ""}`;
}

async function runQuery(
  query: string,
  session: Session,
  serverUrl: string,
  token: string,
  model: string,
  isNewSession: boolean,
  contextLines: number,
  includeHistory: boolean,
): Promise<void> {
  const cwd = process.cwd();
  const historyLines = includeHistory ? getBashHistory(contextLines) : [];
  const systemPrompt = buildSystemPrompt(cwd, session, historyLines);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  // Prepend skill injections as system messages
  for (const inj of session.skillInjections) {
    messages.push({ role: "system", content: inj.content });
  }

  messages.push(...getApiMessages(session));
  messages.push({ role: "user", content: query });

  addMessage(session, "user", query);

  const spinner = startSpinner("thinking…");
  let spinnerStopped = false;
  let assistantContent = "";

  // Accumulate tool calls to display with their results
  const pendingCalls = new Map<string, ToolCallChunk>();

  try {
    await streamQuery({
      serverUrl,
      token,
      messages,
      model,
      workingDirectory: cwd,
      isNewSession,
      sessionId: session.sessionId,
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
        onSkillInvoke(name, content) {
          const injection: SkillInjection = {
            name,
            content,
            injectedAt: new Date().toISOString(),
          };
          session.skillInjections.push(injection);
          saveSession(session);
          printInfo(`Skill '${name}' auto-invoked and injected into context.`);
        },
        onComplete(usage: UsageInfo | null) {
          if (usage) session.totalTokens = usage.totalTokens;
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

  if (assistantContent) addMessage(session, "assistant", assistantContent);
  saveSession(session);
}

async function interactiveMode(
  serverUrl: string,
  token: string,
  model: string,
  newSession: boolean,
  contextLines: number,
  includeHistory: boolean,
  skillName?: string,
): Promise<void> {
  const cwd = process.cwd();
  cleanupOldSessions();
  loadSkills(cwd);

  const session: Session = newSession
    ? {
        sessionId: require("uuid").v4(),
        sessionKey: "new",
        workingDirectory: cwd,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messages: [],
        toolCalls: [],
        filesViewed: [],
        skillInjections: [],
        totalTokens: 0,
      }
    : loadSession(cwd);

  // Pre-inject --skill if provided
  if (skillName) {
    const rendered = renderSkill(skillName, "", {
      args: "",
      sessionId: session.sessionId,
      cwd,
    });
    if (!rendered) {
      printError(`Skill not found: ${skillName}`);
    } else {
      session.skillInjections.push({
        name: skillName,
        content: rendered,
        injectedAt: new Date().toISOString(),
      });
      saveSession(session);
      printInfo(`Skill '${skillName}' injected into context.`);
    }
  }

  let isFirstQuery = true;

  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Keep stdin and readline alive across async queries
  rl.resume();
  process.stdin.resume();

  // Prevent the event loop from draining between queries
  const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
  rl.on("close", () => clearInterval(keepAlive));

  rl.setPrompt(buildPrompt(session));
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    rl.pause();

    try {
      if (!input) {
        // ignore empty lines
      } else if (input === "exit" || input === "quit") {
        rl.close();
        return;
      } else if (input === ".session") {
        printInfo(sessionStats(session));
      } else if (input === ".clear") {
        session.messages = [];
        session.skillInjections = [];
        saveSession(session);
        printInfo("Session messages cleared.");
      } else if (input === ".tools") {
        if (session.toolCalls.length === 0) {
          printInfo("No tool calls this session.");
        } else {
          for (const tc of session.toolCalls) {
            printInfo(
              `[${new Date(tc.timestamp).toLocaleTimeString()}] ${tc.tool} → ${tc.resultLength} bytes`,
            );
          }
        }
      } else if (input === ".skills") {
        const skills = listSkills();
        if (skills.length === 0) {
          printInfo(
            "No skills found. Place SKILL.md files in ~/.tool-kit/skills/<name>/ or .tool-kit/skills/<name>/",
          );
        } else {
          const maxName = Math.max(...skills.map((s) => s.name.length), 4);
          printInfo("Available skills:");
          printInfo(`${"NAME".padEnd(maxName)}  DESCRIPTION`);
          for (const s of skills) {
            printInfo(`${s.name.padEnd(maxName)}  ${s.description}`);
          }
        }
      } else if (input === ".hooks") {
        const hooks = new HooksService(cwd);
        printInfo("Active hook configuration:\n" + hooks.configSummary());
      } else if (input.startsWith(".open ")) {
        // Inline file viewer: .open <path>
        const fileArg = input.slice(6).trim();
        const resolved = path.isAbsolute(fileArg)
          ? fileArg
          : path.resolve(cwd, fileArg);
        if (!fs.existsSync(resolved)) {
          printError(`File not found: ${resolved}`);
        } else {
          try {
            const content = fs.readFileSync(resolved, "utf-8");
            printInfo(`--- ${resolved} ---`);
            process.stdout.write(content);
            if (!content.endsWith("\n")) process.stdout.write("\n");
            printInfo("--- end ---");
            if (!session.filesViewed.includes(resolved)) {
              session.filesViewed.push(resolved);
              saveSession(session);
            }
          } catch (e) {
            printError(`Failed to open file: ${(e as Error).message}`);
          }
        }
      } else if (input === "/compact") {
        const msgCount = session.messages.length;
        if (msgCount === 0) {
          printInfo("Nothing to compact — session is empty.");
        } else {
          const spinner = startSpinner(`Compacting ${msgCount} messages…`);
          const conversationText = session.messages
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
            .join("\n\n---\n\n");
          const compactMessages: OpenAI.ChatCompletionMessageParam[] = [
            {
              role: "user",
              content: `Summarize the following conversation into a concise but complete context brief. Preserve all important decisions, findings, code changes, file paths, and open questions. Write it as a first-person assistant context note.\n\n${conversationText}`,
            },
          ];
          let summary = "";
          let compactFailed = false;
          const compactAbort = new AbortController();
          const compactTimeout = setTimeout(() => compactAbort.abort(), 90_000);
          try {
            await streamQuery({
              serverUrl,
              token,
              model,
              messages: compactMessages,
              workingDirectory: cwd,
              isNewSession: true,
              sessionId: session.sessionId,
              signal: compactAbort.signal,
              callbacks: {
                onContent: (d) => {
                  summary += d;
                },
                onToolCall: () => {},
                onToolResult: () => {},
                onComplete: () => {},
                onError: (msg) => {
                  compactFailed = true;
                  spinner.stop();
                  printError(`Compact failed: ${msg}`);
                },
              },
            });
          } catch (err) {
            compactFailed = true;
            spinner.stop();
            const timedOut = compactAbort.signal.aborted;
            printError(
              timedOut
                ? "Compact timed out — try again or use .clear to reset the session."
                : `Compact failed: ${(err as Error).message}`,
            );
          } finally {
            clearTimeout(compactTimeout);
          }
          if (!compactFailed) {
            spinner.stop();
            session.messages = [
              {
                timestamp: new Date().toISOString(),
                role: "assistant",
                content: `[Compacted from ${msgCount} messages]\n\n${summary}`,
              },
            ];
            session.totalTokens = 0;
            saveSession(session);
            printInfo(
              `Compacted ${msgCount} messages → 1 summary. Context reset.`,
            );
          }
        }
      } else if (input.startsWith("/")) {
        // Skill invocation: /skill-name [args...]
        const spaceIdx = input.indexOf(" ");
        const skillName = (
          spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx)
        ).toLowerCase();
        const argsStr = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1).trim();

        const rendered = renderSkill(skillName, argsStr, {
          args: argsStr,
          sessionId: session.sessionId,
          cwd,
        });

        if (!rendered) {
          printError(
            `Skill not found: ${skillName}. Type .skills to list available skills.`,
          );
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
        await runQuery(
          input,
          session,
          serverUrl,
          token,
          model,
          isFirstQuery,
          contextLines,
          includeHistory,
        );
        isFirstQuery = false;
      }
    } catch (err) {
      printError((err as Error).message);
    }

    rl.resume();
    rl.setPrompt(buildPrompt(session));
    rl.prompt();
  });

  rl.on("SIGINT", () => {
    rl.setPrompt(buildPrompt(session));
    rl.prompt();
  });

  // Wait until the interface is explicitly closed (exit/quit or Ctrl+D)
  await new Promise<void>((resolve) => rl.once("close", resolve));
  process.exit(0);
}

async function oneShotMode(
  query: string,
  serverUrl: string,
  token: string,
  model: string,
  newSession: boolean,
  contextLines: number,
  includeHistory: boolean,
  skillName?: string,
): Promise<void> {
  const cwd = process.cwd();
  cleanupOldSessions();
  loadSkills(cwd);

  const session: Session = newSession
    ? {
        sessionId: require("uuid").v4(),
        sessionKey: "oneshot",
        workingDirectory: cwd,
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        messages: [],
        toolCalls: [],
        filesViewed: [],
        skillInjections: [],
        totalTokens: 0,
      }
    : loadSession(cwd);

  // Pre-inject --skill if provided
  if (skillName) {
    const rendered = renderSkill(skillName, "", {
      args: "",
      sessionId: session.sessionId,
      cwd,
    });
    if (!rendered) {
      printError(`Skill not found: ${skillName}`);
    } else {
      session.skillInjections.push({
        name: skillName,
        content: rendered,
        injectedAt: new Date().toISOString(),
      });
    }
  }

  try {
    await runQuery(
      query,
      session,
      serverUrl,
      token,
      model,
      newSession,
      contextLines,
      includeHistory,
    );
  } catch (err) {
    printError((err as Error).message);
    process.exit(1);
  }
}

const program = new Command();
program
  .name("tool-kit")
  .description("CLI AI agent backed by LiteLLM and MCP servers")
  .version("1.0.0")
  .argument("[query]", "One-shot query (omit for interactive REPL)")
  .option(
    "-s, --server <url>",
    "Backend server URL",
    process.env.TOOL_KIT_SERVER ?? DEFAULT_SERVER,
  )
  .option("-t, --token <token>", "Bearer token", process.env.API_TOKEN ?? "")
  .option("-m, --model <model>", "LiteLLM model string", DEFAULT_MODEL)
  .option(
    "-c, --context <lines>",
    "Number of bash history lines to include in context",
    "10",
  )
  .option("--no-history", "Disable bash history injection into context")
  .option(
    "--new-session",
    "Start a fresh session (ignore today's saved session)",
    false,
  )
  .option("--skill <name>", "Pre-inject a skill into context before the query")
  .action(async (query: string | undefined, opts) => {
    const { server, token, model, newSession, skill, context, history } = opts;
    const contextLines = parseInt(context, 10) || 10;

    if (!token) {
      printError("API_TOKEN is required. Set it in your .env or pass --token.");
      process.exit(1);
    }

    if (query) {
      await oneShotMode(
        query,
        server,
        token,
        model,
        newSession,
        contextLines,
        history,
        skill,
      );
    } else {
      await interactiveMode(
        server,
        token,
        model,
        newSession,
        contextLines,
        history,
        skill,
      );
    }
  });

program.parseAsync(process.argv);

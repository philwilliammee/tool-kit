#!/usr/bin/env node
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

// Auto-load .env from project root (two levels up from dist/cli/cli.js)
// so the binary works without --env-file or manual exports.
(function loadEnv() {
  const projectRoot = path.resolve(__dirname, "../../");
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    // Don't overwrite values already set in the environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
})();
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
  archiveSession,
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
- Only report what tools actually return. Never summarise, paraphrase, or extend tool output with invented content.

## Memory
You can persist important facts, decisions, and context across sessions by writing to AGENTS.md.
- Project memory: ${cwd}/AGENTS.md — use file-editor or bash to create/edit it
- Global memory: ~/.tool-kit/AGENTS.md — for cross-project facts
When you learn something worth remembering (architecture decisions, user preferences, recurring patterns),
append it to AGENTS.md. You can also clean up or remove outdated entries.

## REPL Slash Commands
The user's CLI has these built-in commands (handled client-side, not by you):
  /help            Show all available commands
  /compact         Summarize and archive conversation history
  /cost            Show token usage for this session
  /model [name]    Show or switch the active model
  /memory          Show AGENTS.md (project or global)
  /history [n]     Show last N conversation turns (default 10)
  /tools           List all available MCP tools
  /skills          List available skills
  /hooks           Show active hook configuration
  /session         Show session statistics
  /clear           Clear conversation history
  .open <path>     View a file inline
  /<skill-name>    Inject a skill into context
  exit / quit      Exit the REPL
If asked about slash commands, refer to this list.${agentsBlock ? `\n\n## User Instructions\n${agentsBlock}` : ""}`;
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
          if (usage) {
            session.totalTokens += usage.totalTokens;
            session.lastUsage = {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
            };
          }
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
  let currentModel = model; // mutable so /model can change it mid-session

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

      // ── /session (.session alias) ────────────────────────────────────────────
      } else if (input === "/session" || input === ".session") {
        printInfo(sessionStats(session));

      // ── /clear (.clear alias) ────────────────────────────────────────────────
      } else if (input === "/clear" || input === ".clear") {
        session.messages = [];
        session.skillInjections = [];
        saveSession(session);
        printInfo("Session messages cleared.");

      // ── /cost ────────────────────────────────────────────────────────────────
      } else if (input === "/cost") {
        const u = session.lastUsage;
        if (!session.totalTokens && !u) {
          printInfo("No token usage recorded yet.");
        } else if (u) {
          printInfo(
            `Last call — prompt: ${u.promptTokens.toLocaleString()}, ` +
            `completion: ${u.completionTokens.toLocaleString()}\n` +
            `Session total: ${session.totalTokens.toLocaleString()} tokens (cumulative)`,
          );
        } else {
          printInfo(`Session total: ${session.totalTokens.toLocaleString()} tokens (cumulative)`);
        }

      // ── /model [name] ────────────────────────────────────────────────────────
      } else if (input === "/model" || input.startsWith("/model ")) {
        const newModel = input.slice(7).trim();
        if (!newModel) {
          printInfo(`Current model: ${currentModel}`);
        } else {
          currentModel = newModel;
          printInfo(`Model switched to: ${currentModel}`);
        }

      // ── /history [n] ─────────────────────────────────────────────────────────
      } else if (input === "/history" || input.startsWith("/history ")) {
        const n = parseInt(input.slice(9).trim() || "10", 10) || 10;
        const msgs = session.messages.slice(-n);
        if (msgs.length === 0) {
          printInfo("No conversation history.");
        } else {
          printInfo(`Last ${msgs.length} turn(s):`);
          for (const m of msgs) {
            const when = new Date(m.timestamp).toLocaleTimeString();
            const label = m.role.toUpperCase().padEnd(9);
            const preview = m.content.slice(0, 120).replace(/\n/g, " ");
            printInfo(`[${when}] ${label} ${preview}${m.content.length > 120 ? "…" : ""}`);
          }
        }

      // ── /memory ──────────────────────────────────────────────────────────────
      } else if (input === "/memory") {
        const projectAgents = path.join(cwd, "AGENTS.md");
        const globalAgents = path.join(os.homedir(), ".tool-kit", "AGENTS.md");
        const memFile = fs.existsSync(projectAgents)
          ? projectAgents
          : fs.existsSync(globalAgents)
          ? globalAgents
          : null;
        if (!memFile) {
          printInfo("No AGENTS.md found in project or ~/.tool-kit/");
        } else {
          printInfo(`--- ${memFile} ---`);
          process.stdout.write(fs.readFileSync(memFile, "utf-8"));
          printInfo("--- end ---");
        }

      // ── /tools ───────────────────────────────────────────────────────────────
      } else if (input === "/tools") {
        try {
          const axios = require("axios");
          const resp = await axios.get(`${serverUrl}/api/tools`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
          });
          const tools = resp.data.tools as Array<{ name: string; description: string }>;
          if (!tools.length) {
            printInfo("No MCP tools available.");
          } else {
            printInfo(`Available tools (${tools.length}):`);
            const maxName = Math.max(...tools.map((t) => t.name.length), 4);
            for (const t of tools) {
              const desc = (t.description ?? "").split("\n")[0].slice(0, 60);
              printInfo(`  ${t.name.padEnd(maxName)}  ${desc}`);
            }
          }
        } catch (err) {
          printError(`Failed to fetch tools: ${(err as Error).message}`);
        }

      // ── /skills (.skills alias) ──────────────────────────────────────────────
      } else if (input === "/skills" || input === ".skills") {
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

      // ── /hooks (.hooks alias) ────────────────────────────────────────────────
      } else if (input === "/hooks" || input === ".hooks") {
        const hooks = new HooksService(cwd);
        printInfo("Active hook configuration:\n" + hooks.configSummary());

      // ── .open <path> ─────────────────────────────────────────────────────────
      } else if (input.startsWith(".open ")) {
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

      // ── /compact ─────────────────────────────────────────────────────────────
      } else if (input === "/compact") {
        const msgCount = session.messages.length;
        if (msgCount === 0) {
          printInfo("Nothing to compact — session is empty.");
        } else {
          const spinner = startSpinner(`Archiving ${msgCount} messages and compacting…`);

          // 1. Archive full conversation to JSONL
          let archivePath: string;
          try {
            archivePath = archiveSession(session);
          } catch (err) {
            spinner.stop();
            printError(`Failed to archive session: ${(err as Error).message}`);
            return;
          }

          // 2. Build compaction prompt with line-reference instruction
          const conversationText = session.messages
            .map((m, i) => `Turn ${i + 1} [${m.role.toUpperCase()}]: ${m.content}`)
            .join("\n\n---\n\n");

          const compactMessages: OpenAI.ChatCompletionMessageParam[] = [
            {
              role: "user",
              content:
                `Summarize the following conversation into a concise but complete context brief.\n` +
                `The full transcript has been archived at: ${archivePath}\n` +
                `Each line in the archive is a JSON record with a "turn" number.\n\n` +
                `In your summary, include line references for major topic sections so that\n` +
                `specific parts of the conversation can be reloaded later. Format each section as:\n` +
                `  "Lines X-Y: [topic description]"\n\n` +
                `Preserve all important decisions, findings, code changes, file paths, and open questions.\n` +
                `Write it as a first-person assistant context note.\n\n` +
                `Conversation:\n\n${conversationText}`,
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
              model: currentModel,
              messages: compactMessages,
              workingDirectory: cwd,
              isNewSession: true,
              sessionId: session.sessionId,
              signal: compactAbort.signal,
              callbacks: {
                onContent: (d) => { summary += d; },
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
                ? "Compact timed out — try again or use /clear to reset."
                : `Compact failed: ${(err as Error).message}`,
            );
          } finally {
            clearTimeout(compactTimeout);
          }

          if (!compactFailed) {
            spinner.stop();
            // Replace messages with summary + boundary marker
            session.messages = [
              {
                timestamp: new Date().toISOString(),
                role: "system",
                type: "compact_boundary",
                content: `[Compacted from ${msgCount} messages. Archive: ${archivePath}]`,
              },
              {
                timestamp: new Date().toISOString(),
                role: "system",
                type: "compact_summary",
                content: summary,
              },
            ];
            session.archivePath = archivePath;
            session.totalTokens = 0;
            saveSession(session);
            printInfo(
              `Compacted ${msgCount} messages → summary. Archive: ${archivePath}`,
            );
          }
        }

      // ── /help ────────────────────────────────────────────────────────────────
      } else if (input === "/help") {
        printInfo([
          "Commands:",
          "  /compact        Summarize conversation history, archive full transcript",
          "  /cost           Show token usage for this session",
          "  /model [name]   Show or switch the active model",
          "  /memory         Show AGENTS.md (project or global)",
          "  /history [n]    Show last N conversation turns (default 10)",
          "  /tools          List all available MCP tools",
          "  /skills         List available skills",
          "  /hooks          Show active hook configuration",
          "  /session        Show session statistics",
          "  /clear          Clear conversation history",
          "  .open <path>    View a file inline",
          "  exit / quit     Exit the REPL",
          "  /<skill-name>   Inject a skill into context",
        ].join("\n"));

      // ── /skill-name [args] ───────────────────────────────────────────────────
      } else if (input.startsWith("/")) {
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
            `Unknown command or skill: /${skillName}. Type /help for available commands.`,
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

      // ── regular query ────────────────────────────────────────────────────────
      } else {
        await runQuery(
          input,
          session,
          serverUrl,
          token,
          currentModel,
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

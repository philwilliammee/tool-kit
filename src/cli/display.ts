import chalk from 'chalk';
import ora, { Ora } from 'ora';
import { ToolCallChunk, ToolResult } from './client';

const MAX_RESULT_LINES = 30;

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

function line(char = '─'): string {
  return char.repeat(Math.max(40, termWidth() - 2));
}

// ── Content streaming ──────────────────────────────────────────────────────────

export function printContent(delta: string): void {
  process.stdout.write(delta);
}

export function printNewline(): void {
  process.stdout.write('\n');
}

// ── Tool call display ──────────────────────────────────────────────────────────

export function printToolCall(chunk: ToolCallChunk, result?: ToolResult): void {
  const width = termWidth();
  const topLabel = '─ 🔧 Tool Call ';
  const top = '╭' + topLabel + '─'.repeat(Math.max(2, width - topLabel.length - 2)) + '╮';
  const bottom = '╰' + line() + '╯';

  console.log('\n' + chalk.cyan(top));
  console.log(chalk.cyan('│') + '  ' + chalk.bold(chunk.name));
  console.log(chalk.cyan('│'));

  // Parameters
  const argsStr = JSON.stringify(chunk.arguments, null, 2);
  console.log(chalk.cyan('│') + '  ' + chalk.dim('Parameters:'));
  for (const argLine of argsStr.split('\n')) {
    console.log(chalk.cyan('│') + '  ' + chalk.yellow(argLine));
  }

  if (result) {
    console.log(chalk.cyan('│'));
    console.log(chalk.cyan('│') + '  ' + chalk.green('✅ Result:'));
    const resultLines = result.content.split('\n');
    const displayed = resultLines.slice(0, MAX_RESULT_LINES);
    for (const resultLine of displayed) {
      console.log(chalk.cyan('│') + '    ' + resultLine);
    }
    if (resultLines.length > MAX_RESULT_LINES) {
      console.log(chalk.cyan('│') + '    ' + chalk.dim(`… ${resultLines.length - MAX_RESULT_LINES} more lines`));
    }
  }

  console.log(chalk.cyan(bottom) + '\n');
}

// ── Spinner ────────────────────────────────────────────────────────────────────

export function startSpinner(text: string): Ora {
  return ora({ text, color: 'cyan' }).start();
}

// ── Error ──────────────────────────────────────────────────────────────────────

export function printError(message: string): void {
  console.error('\n' + chalk.red('✖ Error: ') + message + '\n');
}

// ── Session info ───────────────────────────────────────────────────────────────

export function printInfo(message: string): void {
  console.log(chalk.dim(message));
}

export function printBanner(): void {
  console.log(chalk.cyan('\ntool-kit') + chalk.dim(' — AI agent (type exit to quit)\n'));
}

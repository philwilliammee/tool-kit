export interface BashInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeout?: number;
  type?: "file" | "git" | "npm" | "general";
  setCwd?: string;
  env?: Record<string, string>;
  shell?: "/bin/sh" | "/bin/bash" | "/bin/dash";
}

export interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: boolean;
  message?: string;
  pwd: string;
  executionTime?: number;
  commandType?: string;
  shellUsed?: string;
}

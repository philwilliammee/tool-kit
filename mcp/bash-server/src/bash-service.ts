import { spawn } from "child_process";
import { promisify } from "util";
import { BashInput, BashOutput } from "./types.js";
import {
  validateCommand,
  validatePath,
  ALLOWED_BASE_PATH,
} from "./security.js";

// Persistent working directory state
let persistentCwd: string = ALLOWED_BASE_PATH;

export class BashService {
  async executeCommand(input: BashInput): Promise<BashOutput> {
    const startTime = Date.now();

    // Validate command
    const validation = validateCommand(input.command);
    if (!validation.valid) {
      return {
        stdout: "",
        stderr: validation.reason || "Command blocked",
        exitCode: 1,
        error: true,
        message: validation.reason,
        pwd: persistentCwd,
        executionTime: 0,
        commandType: input.type || "general",
        shellUsed: input.shell || "/bin/sh",
      };
    }

    // Handle setCwd for persistent directory changes
    if (input.setCwd) {
      if (!validatePath(input.setCwd)) {
        return {
          stdout: "",
          stderr: "Invalid path: must be within /home/ds123",
          exitCode: 1,
          error: true,
          message: "Path validation failed",
          pwd: persistentCwd,
          executionTime: Date.now() - startTime,
          commandType: input.type || "general",
          shellUsed: input.shell || "/bin/sh",
        };
      }
      persistentCwd = input.setCwd;
    }

    // Determine working directory
    const workingDir = input.cwd
      ? validatePath(input.cwd)
        ? input.cwd
        : persistentCwd
      : persistentCwd;

    // Build command with args
    let fullCommand = input.command;
    if (input.args && input.args.length > 0) {
      // Properly escape arguments
      const escapedArgs = input.args.map((arg) =>
        arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg,
      );
      fullCommand += " " + escapedArgs.join(" ");
    }

    // Set up environment
    const env = {
      ...process.env,
      ...input.env,
      PWD: workingDir,
    };

    // Execute command
    return new Promise((resolve) => {
      const shell = input.shell || "/bin/sh";
      const timeout = input.timeout || 30000; // 30 second default

      const child = spawn(shell, ["-c", fullCommand], {
        cwd: workingDir,
        env: env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // Set timeout
      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000); // Force kill after 5s
      }, timeout);

      // Collect output
      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timeoutId);

        const executionTime = Date.now() - startTime;

        if (timedOut) {
          resolve({
            stdout,
            stderr: stderr + "\nCommand timed out and was terminated",
            exitCode: 124, // timeout exit code
            error: true,
            message: "Command execution timed out",
            pwd: workingDir,
            executionTime,
            commandType: input.type || "general",
            shellUsed: shell,
          });
        } else {
          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
            error: (code || 0) !== 0,
            message: (code || 0) !== 0 ? "Command failed" : undefined,
            pwd: workingDir,
            executionTime,
            commandType: input.type || "general",
            shellUsed: shell,
          });
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        resolve({
          stdout,
          stderr: stderr + error.message,
          exitCode: 1,
          error: true,
          message: error.message,
          pwd: workingDir,
          executionTime: Date.now() - startTime,
          commandType: input.type || "general",
          shellUsed: shell,
        });
      });
    });
  }

  getCurrentWorkingDirectory(): string {
    return persistentCwd;
  }

  setWorkingDirectory(path: string): boolean {
    if (validatePath(path)) {
      persistentCwd = path;
      return true;
    }
    return false;
  }
}

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitService {
  private token: string;
  private workspaceRoot: string;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }
    this.token = token;

    const workspaceRoot = process.env.WORKSPACE_ROOT;
    if (!workspaceRoot) {
      throw new Error('WORKSPACE_ROOT environment variable is required');
    }
    this.workspaceRoot = this.toRealPath(workspaceRoot);
  }

  private buildAuthUrl(owner: string, repo: string): string {
    return `https://x-access-token:${this.token}@github.com/${owner}/${repo}.git`;
  }

  private redact(text: string): string {
    const escapedToken = this.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(escapedToken, 'g'), '***');
  }

  private toRealPath(p: string): string {
    const resolved = path.resolve(p);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }
    return fs.realpathSync(resolved);
  }

  private nearestExistingParentRealPath(p: string): string {
    let current = path.resolve(p);
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Unable to resolve parent directory for path: ${p}`);
      }
      current = parent;
    }
    return fs.realpathSync(current);
  }

  private isInsideRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }

  private validateCloneTargetInRoot(targetDir: string): string {
    if (!path.isAbsolute(targetDir)) {
      throw new Error('targetDir must be an absolute path.');
    }

    const targetAbs = path.resolve(targetDir);

    if (fs.existsSync(targetAbs)) {
      const targetReal = fs.realpathSync(targetAbs);
      if (!this.isInsideRoot(this.workspaceRoot, targetReal)) {
        throw new Error(
          `Path is outside workspace root. targetDir=${targetReal}, workspaceRoot=${this.workspaceRoot}`,
        );
      }
      return targetAbs;
    }

    const parentReal = this.nearestExistingParentRealPath(targetAbs);
    if (!this.isInsideRoot(this.workspaceRoot, parentReal)) {
      throw new Error(
        `Path is outside workspace root. targetDir=${targetAbs}, workspaceRoot=${this.workspaceRoot}`,
      );
    }
    return targetAbs;
  }

  private validateExistingRepoDirInRoot(dir: string): string {
    if (!path.isAbsolute(dir)) {
      throw new Error('dir must be an absolute path.');
    }

    const dirReal = this.toRealPath(dir);
    if (!this.isInsideRoot(this.workspaceRoot, dirReal)) {
      throw new Error(
        `Path is outside workspace root. dir=${dirReal}, workspaceRoot=${this.workspaceRoot}`,
      );
    }

    const gitCheck = spawnSync(
      'git',
      ['-C', dirReal, 'rev-parse', '--git-dir'],
      {
        env: this.buildEnv(),
        encoding: 'utf-8',
      },
    );
    if (gitCheck.status !== 0) {
      throw new Error(`Directory is not a git repository: ${dirReal}`);
    }

    return dirReal;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.GIT_ASKPASS;
    return env;
  }

  clone(owner: string, repo: string, targetDir: string): GitResult {
    const safeTargetDir = this.validateCloneTargetInRoot(targetDir);
    const url = this.buildAuthUrl(owner, repo);
    const result = spawnSync('git', ['clone', url, safeTargetDir], {
      env: this.buildEnv(),
      encoding: 'utf-8',
    });

    return {
      success: result.status === 0,
      stdout: this.redact((result.stdout as string) || ''),
      stderr: this.redact((result.stderr as string) || ''),
      exitCode: result.status ?? 1,
    };
  }

  pull(dir: string): GitResult {
    const safeDir = this.validateExistingRepoDirInRoot(dir);
    const result = spawnSync('git', ['-C', safeDir, 'pull'], {
      env: this.buildEnv(),
      encoding: 'utf-8',
    });

    return {
      success: result.status === 0,
      stdout: this.redact((result.stdout as string) || ''),
      stderr: this.redact((result.stderr as string) || ''),
      exitCode: result.status ?? 1,
    };
  }

  push(owner: string, repo: string, dir: string, branch: string): GitResult {
    const safeDir = this.validateExistingRepoDirInRoot(dir);
    const url = this.buildAuthUrl(owner, repo);
    const result = spawnSync('git', ['-C', safeDir, 'push', url, branch], {
      env: this.buildEnv(),
      encoding: 'utf-8',
    });

    return {
      success: result.status === 0,
      stdout: this.redact((result.stdout as string) || ''),
      stderr: this.redact((result.stderr as string) || ''),
      exitCode: result.status ?? 1,
    };
  }
}

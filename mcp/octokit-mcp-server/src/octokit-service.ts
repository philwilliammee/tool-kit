import { Octokit } from "octokit";
import {
  GitHubOperation,
  GitHubResult,
  GitHubResponse,
  GitHubError,
} from "./types.js";

export class OctokitService {
  private defaultOctokit: Octokit;

  constructor() {
    const token = process.env.GITHUB_TOKEN || process.env.GITHUB_AUTH_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

    this.defaultOctokit = new Octokit({
      userAgent: "octokit-mcp-server/v1.0.0",
      auth: token,
    });
  }

  /**
   * Execute a GitHub API operation
   */
  async executeOperation(input: GitHubOperation): Promise<GitHubResult> {
    try {
      // Use custom auth if provided, otherwise use default
      const octokit = this.defaultOctokit;

      // Execute the GitHub API request
      const response = await octokit.request(
        input.operation,
        input.parameters || {}
      );

      // Extract rate limit information from headers
      const rateLimit = this.extractRateLimit(response.headers);

      const result: GitHubResponse = {
        data: response.data,
        status: response.status,
        headers: response.headers as Record<string, string>,
        rateLimit,
      };

      return result;
    } catch (error: any) {
      console.error("GitHub API operation error:", error);

      const errorResult: GitHubError = {
        error: true,
        message: error.message || "Failed to execute GitHub API operation",
        status: error.status || 500,
        documentation_url: error.documentation_url,
      };

      return errorResult;
    }
  }

  /**
   * Get repository information
   */
  async getRepository(owner: string, repo: string): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "GET /repos/{owner}/{repo}",
      parameters: { owner, repo },
    });
  }

  /**
   * List repository issues
   */
  async listIssues(
    owner: string,
    repo: string,
    state?: "open" | "closed" | "all"
  ): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "GET /repos/{owner}/{repo}/issues",
      parameters: { owner, repo, state: state || "open" },
    });
  }

  /**
   * Create an issue
   */
  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    labels?: string[]
  ): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "POST /repos/{owner}/{repo}/issues",
      parameters: { owner, repo, title, body, labels },
    });
  }

  /**
   * List repository pull requests
   */
  async listPullRequests(
    owner: string,
    repo: string,
    state?: "open" | "closed" | "all"
  ): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "GET /repos/{owner}/{repo}/pulls",
      parameters: { owner, repo, state: state || "open" },
    });
  }

  /**
   * Create a pull request
   */
  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string,
    draft?: boolean
  ): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "POST /repos/{owner}/{repo}/pulls",
      parameters: { owner, repo, title, head, base, body, draft },
    });
  }

  /**
   * Search repositories
   */
  async searchRepositories(
    query: string,
    sort?: "stars" | "forks" | "updated",
    order?: "asc" | "desc"
  ): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "GET /search/repositories",
      parameters: { q: query, sort, order },
    });
  }

  /**
   * Get authenticated user information
   */
  async getUser(): Promise<GitHubResult> {
    return this.executeOperation({
      operation: "GET /user",
    });
  }

  /**
   * Extract rate limit information from response headers
   */
  private extractRateLimit(headers: any): GitHubResponse["rateLimit"] {
    const limit = headers["x-ratelimit-limit"];
    const remaining = headers["x-ratelimit-remaining"];
    const reset = headers["x-ratelimit-reset"];
    const used = headers["x-ratelimit-used"];

    if (limit && remaining && reset && used) {
      return {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
        used: parseInt(used, 10),
      };
    }

    return undefined;
  }
}

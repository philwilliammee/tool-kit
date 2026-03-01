export interface GitHubOperation {
  /**
   * The GitHub API operation to perform
   * Example: "GET /repos/{owner}/{repo}"
   */
  operation: string;

  /**
   * Parameters for the operation
   * Example: { owner: "octokit", repo: "octokit.js" }
   */
  parameters?: Record<string, any>;

  /**
   * Optional authentication token (overrides default)
   */
  auth?: string;
}

export interface GitHubResponse {
  /**
   * The data returned from the GitHub API
   */
  data: any;

  /**
   * Response status code
   */
  status: number;

  /**
   * Response headers
   */
  headers: Record<string, string>;

  /**
   * Rate limit information
   */
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: number;
    used: number;
  };
}

export interface GitHubError {
  error: true;
  message: string;
  status?: number;
  documentation_url?: string;
}

export type GitHubResult = GitHubResponse | GitHubError;

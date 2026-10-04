export interface GithubInstallation {
  id: number;
  account: { login: string };
}
export interface GithubRepository {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}
export interface GithubRepositories {
  total_count: number;
  repositories: GithubRepository[];
}
export interface GithubProviderToken {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

export interface GithubCommitResponse {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
}

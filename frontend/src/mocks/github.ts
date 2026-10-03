// mock 용 GitHub 연동 데이터. backend-v2 github.service 의 응답 형태(origin/main)를 그대로 따른다.
// 실제 GitHub 나 팀 backend 로는 아무 요청도 가지 않는다.
import type { GithubBranchesPage, GithubConnection, GithubInstallation, GithubRepository } from '../api/types';

export const MOCK_INSTALLATION_ID = 90210001;
export const MOCK_REPO_GUESTBOOK_ID = 50010001;
export const MOCK_REPO_CONTACTS_ID = 50010002;

export const MOCK_GITHUB_CONNECTION: GithubConnection = {
  connected: true,
  installation_url: 'https://github.com/apps/hibiscus-demo/installations/new',
};

export const MOCK_INSTALLATIONS: GithubInstallation[] = [{ id: MOCK_INSTALLATION_ID, account: 'hibiscus-demo' }];

export const MOCK_REPOSITORIES: Record<number, GithubRepository[]> = {
  [MOCK_INSTALLATION_ID]: [
    { id: MOCK_REPO_GUESTBOOK_ID, full_name: 'hibiscus-demo/guestbook', default_branch: 'main', private: false },
    { id: MOCK_REPO_CONTACTS_ID, full_name: 'hibiscus-demo/contacts', default_branch: 'main', private: true },
  ],
};

export const MOCK_BRANCHES: Record<number, GithubBranchesPage['branches']> = {
  [MOCK_REPO_GUESTBOOK_ID]: [{ name: 'main' }, { name: 'develop' }, { name: 'feature/uploads' }],
  [MOCK_REPO_CONTACTS_ID]: [{ name: 'main' }, { name: 'release/1.0' }],
};

/** backend ApplicationService.create 처럼 publicHost 는 slug 와 게이트웨이 도메인으로 만든다 */
export const MOCK_GATEWAY_DOMAIN = 'lth.so';

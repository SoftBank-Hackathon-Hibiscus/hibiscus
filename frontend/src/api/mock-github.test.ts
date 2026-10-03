import { describe, expect, it } from 'vitest';
import { ApiError } from './client';
import { MockDataSource, mockBranchHead } from './mock';
import { buildScenario } from '../mocks';
import { APP_ID } from '../mocks/common';
import { MOCK_INSTALLATION_ID, MOCK_REPO_CONTACTS_ID, MOCK_REPO_GUESTBOOK_ID } from '../mocks/github';
import type { GithubApplicationInput } from './types';

const input: GithubApplicationInput = {
  name: 'Contacts',
  slug: 'contacts',
  image_repo: 'asia-northeast3-docker.pkg.dev/hib/apps/contacts',
  container_port: 3000,
  test_template: 'allow',
  requires_approval: true,
  installation_id: MOCK_INSTALLATION_ID,
  repository_id: MOCK_REPO_CONTACTS_ID,
  branch: 'main',
  auto_deploy: true,
};

const source = () => new MockDataSource(buildScenario(2), () => Date.parse('2026-10-03T00:00:00Z'), 0);

describe('mock GitHub 조회', () => {
  it('connection → installations → repositories → branches 를 backend 응답 형태로 돌려준다', async () => {
    const s = source();
    expect(await s.getGithubConnection()).toMatchObject({ connected: true });
    const inst = await s.listGithubInstallations();
    expect(inst.installations.map((i) => i.id)).toEqual([MOCK_INSTALLATION_ID]);
    const repos = await s.listGithubRepositories(MOCK_INSTALLATION_ID);
    expect(repos.repositories.map((r) => r.id)).toEqual([MOCK_REPO_GUESTBOOK_ID, MOCK_REPO_CONTACTS_ID]);
    const branches = await s.listGithubBranches(MOCK_INSTALLATION_ID, MOCK_REPO_GUESTBOOK_ID);
    expect(branches.default_branch).toBe('main');
    expect(branches.branches.map((b) => b.name)).toContain('main');
  });
  it('모르는 설치/저장소는 404', async () => {
    const s = source();
    await expect(s.listGithubRepositories(1)).rejects.toMatchObject({ status: 404 });
    await expect(s.listGithubBranches(MOCK_INSTALLATION_ID, 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe('mock 애플리케이션 등록 (POST /github/applications 흉내)', () => {
  it('backend 처럼 선택한 브랜치 최신 커밋(40자리)으로 registration 최초 배포를 만든다', async () => {
    const s = source();
    const created = await s.createGithubApplication(input);
    const initial = created.initial_deployment!;
    expect(initial).toMatchObject({ applicationId: created.application.id, version: 1, trigger: 'registration', status: 'queued', sourceRevision: mockBranchHead('hibiscus-demo/contacts', 'main'), sourceRevisionVerified: false, digestSource: 'placeholder', decision: null, deploymentPerformed: false });
    expect(initial.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
    const view = await s.getDeployment(initial.id);
    expect(view.deployment.trigger).toBe('registration');
    // 가짜 파이프라인 자동 진행 없음
    expect(view.stages).toEqual([]);
    expect(view.deployment.status).toBe('queued');
  });
  it('auto_deploy 를 꺼도 최초 배포는 만든다 (자동 배포는 이후 push 만 제어)', async () => {
    const s = source();
    const created = await s.createGithubApplication({ ...input, auto_deploy: false, branch: 'release/1.0' });
    expect(created.github.autoDeploy).toBe(false);
    expect(created.initial_deployment).toMatchObject({ trigger: 'registration', sourceRevision: mockBranchHead('hibiscus-demo/contacts', 'release/1.0') });
  });
  it('실패한 등록은 앱도 최초 배포도 만들지 않는다', async () => {
    const s = source();
    await expect(s.createGithubApplication({ ...input, branch: 'nope' })).rejects.toMatchObject({ status: 404 });
    expect((await s.listApplications()).map((v) => v.application.id)).toEqual([APP_ID]);
  });
  it('등록하면 목록·상세에 보이고 route 는 아직 없다(404), target 은 비어 있다', async () => {
    const s = source();
    const created = await s.createGithubApplication({ ...input, environment: [{ name: 'DATABASE_URL', value: 'postgres://db/app' }] });
    expect(created.application.slug).toBe('contacts');
    expect(created.application.publicHost).toBe('contacts.lth.so');
    expect(created.application.sourcePath).toBe('https://github.com/hibiscus-demo/contacts.git');
    expect(created.application.repo).toBe('hibiscus-demo/contacts');
    expect(created.application.defaultBranch).toBe('main');
    expect(created.application.requiresApproval).toBe(true);
    expect(created.github).toMatchObject({ applicationId: created.application.id, repositoryId: MOCK_REPO_CONTACTS_ID, branch: 'main', autoDeploy: true, active: true });
    expect(created.healthCheck).toMatchObject({ path: '/health', intervalSeconds: 5, failureThreshold: 3 });
    expect(created.environment).toEqual(['DATABASE_URL']);

    const list = await s.listApplications();
    expect(list.map((v) => v.application.id)).toEqual([APP_ID, created.application.id]);
    expect((await s.getApplication(created.application.id)).application.name).toBe('Contacts');
    expect((await s.listDeployments(created.application.id)).map((d) => d.id)).toEqual([created.initial_deployment!.id]);
    expect(await s.getTargets(created.application.id)).toEqual([]);
    await expect(s.getRouting(created.application.id)).rejects.toMatchObject({ status: 404, message: 'Application route not found' });
  });
  it('환경변수 전체를 교체하고 값은 응답하지 않는다', async () => {
    const s = source();
    const created = await s.createGithubApplication(input);
    const result = await s.updateApplicationEnvironment(created.application.id, {
      environment: [
        { name: 'REDIS_URL', value: 'redis://cache' },
        { name: 'DATABASE_URL', value: 'postgres://db/app' },
      ],
    });
    expect(result).toEqual({ environment: ['DATABASE_URL', 'REDIS_URL'] });
    expect(await s.getApplication(created.application.id)).toMatchObject({ environment: ['DATABASE_URL', 'REDIS_URL'] });
    expect(JSON.stringify(result)).not.toContain('postgres://');
  });
  it('기존 앱과 slug 가 겹치면 409, 접근 불가 저장소/브랜치는 404', async () => {
    const s = source();
    await expect(s.createGithubApplication({ ...input, slug: 'guestbook' })).rejects.toMatchObject({ status: 409 });
    await s.createGithubApplication(input);
    await expect(s.createGithubApplication(input)).rejects.toMatchObject({ status: 409 });
    await expect(s.createGithubApplication({ ...input, slug: 'other', repository_id: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(s.createGithubApplication({ ...input, slug: 'other', branch: 'nope' })).rejects.toBeInstanceOf(ApiError);
  });
  it('기존 시나리오 조회는 그대로 동작한다', async () => {
    const s = source();
    await s.createGithubApplication(input);
    expect((await s.getApplication(APP_ID)).application.slug).toBe('guestbook');
    expect((await s.listDeployments(APP_ID)).length).toBeGreaterThan(0);
    await expect(s.getApplication('nope')).rejects.toMatchObject({ status: 404 });
  });
});

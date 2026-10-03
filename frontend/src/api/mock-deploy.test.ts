import { describe, expect, it } from 'vitest';
import { MockDataSource } from './mock';
import { buildScenario } from '../mocks';
import { APP_ID } from '../mocks/common';
import { MOCK_INSTALLATION_ID, MOCK_REPO_GUESTBOOK_ID } from '../mocks/github';

const COMMIT = '1f6947dce692de48ef4580b1a3f5366adf66f5ae';
const source = () => new MockDataSource(buildScenario(2), () => Date.parse('2026-10-03T00:00:00Z'), 0);

describe('mock 새 배포 (POST /applications/:id/deployments 흉내)', () => {
  it('기존 앱에 만들면 다음 버전의 queued 배포가 생기고 목록·상세에서 보인다', async () => {
    const s = source();
    const before = await s.listDeployments(APP_ID);
    const top = Math.max(...before.map((d) => d.version));
    const created = await s.createDeployment(APP_ID, { source_revision: COMMIT });
    expect(created).toMatchObject({ applicationId: APP_ID, version: top + 1, status: 'queued', trigger: 'manual', sourceRevision: COMMIT, sourceRevisionVerified: false, digestSource: 'placeholder', decision: null, approver: null, deploymentPerformed: false });
    expect(created.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const after = await s.listDeployments(APP_ID);
    expect(after[0]?.id).toBe(created.id);
    const view = await s.getDeployment(created.id);
    expect(view.stages).toEqual([]);
    expect(view.policyResult).toBeNull();
    expect(view.artifacts).toEqual([]);
    // 가짜 파이프라인 자동 진행 없음
    expect((await s.getDeployment(created.id)).deployment.status).toBe('queued');
  });
  it('image_digest 를 주면 registry digest 로 기록한다', async () => {
    const s = source();
    const digest = `sha256:${'b'.repeat(64)}`;
    const created = await s.createDeployment(APP_ID, { source_revision: 'abcdef1', image_digest: digest });
    expect(created.imageDigest).toBe(digest);
    expect(created.digestSource).toBe('registry');
  });
  it('mock 으로 등록한 앱에도 배포를 만들 수 있고(v1), 모르는 앱은 404', async () => {
    const s = source();
    const app = await s.createGithubApplication({ name: 'Guestbook 2', slug: 'guestbook-2', image_repo: 'repo/x', installation_id: MOCK_INSTALLATION_ID, repository_id: MOCK_REPO_GUESTBOOK_ID, branch: 'main' });
    const created = await s.createDeployment(app.application.id, { source_revision: COMMIT });
    expect(created.version).toBe(1);
    expect((await s.listDeployments(app.application.id)).map((d) => d.id)).toEqual([created.id]);
    await expect(s.createDeployment('nope', { source_revision: COMMIT })).rejects.toMatchObject({ status: 404 });
  });
  it('기존 시나리오 route/target 조회는 새 배포와 무관하게 유지된다', async () => {
    const s = source();
    const routeBefore = await s.getRouting(APP_ID);
    await s.createDeployment(APP_ID, { source_revision: COMMIT });
    expect((await s.getRouting(APP_ID)).target.id).toBe(routeBefore.target.id);
  });
});

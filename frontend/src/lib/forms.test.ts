import { describe, expect, it } from 'vitest';
import { EMPTY_REGISTRATION, friendlyBackendError, registeredPath, repoShortName, slugify, isGithubSource, toCreateDeploymentInput, toGithubApplicationInput, validateDeployment, validateRegistration, type RegistrationDraft } from './forms';
import { applicationPath, deploymentPath } from './router';
import type { GithubApplicationCreated } from '../api/types';

const valid: RegistrationDraft = {
  ...EMPTY_REGISTRATION,
  installationId: 90210001,
  repositoryId: 50010001,
  branch: 'main',
  name: 'Guestbook',
  slug: 'guestbook',
  imageRepo: 'asia-northeast3-docker.pkg.dev/hib/apps/guestbook',
};

describe('slugify', () => {
  it('저장소 이름을 backend slug 규칙(소문자·숫자·하이픈)에 맞춘다', () => {
    expect(slugify('Guestbook')).toBe('guestbook');
    expect(slugify('My App_v2!!')).toBe('my-app-v2');
    expect(slugify('--weird--')).toBe('weird');
    expect(slugify('a'.repeat(80))).toHaveLength(64);
  });
  it('owner/repo 에서 repo 만 뽑는다', () => {
    expect(repoShortName('hibiscus-demo/guestbook')).toBe('guestbook');
    expect(repoShortName('guestbook')).toBe('guestbook');
  });
});

describe('validateRegistration (CreateApplicationDto / GithubApplicationDto 규칙)', () => {
  it('정상 입력은 오류가 없다', () => {
    expect(validateRegistration(valid)).toEqual({});
  });
  it('설치·저장소·브랜치가 없으면 각각 오류', () => {
    const e = validateRegistration({ ...valid, installationId: null, repositoryId: null, branch: '' });
    expect(e.installationId).toBe('errInstallation');
    expect(e.repositoryId).toBe('errRepository');
    expect(e.branch).toBe('errBranch');
  });
  it('이름은 trim 후 1–64자', () => {
    expect(validateRegistration({ ...valid, name: '   ' }).name).toBe('errNameRequired');
    expect(validateRegistration({ ...valid, name: 'x'.repeat(65) }).name).toBe('errNameLong');
    expect(validateRegistration({ ...valid, name: '  ok  ' }).name).toBeUndefined();
  });
  it('slug 는 /^[a-z0-9]+(?:-[a-z0-9]+)*$/', () => {
    for (const bad of ['', 'Guestbook', '-guestbook', 'guest--book', 'guest book', 'a'.repeat(65)]) {
      expect(validateRegistration({ ...valid, slug: bad }).slug).toBe('errSlug');
    }
    expect(validateRegistration({ ...valid, slug: 'guest-book-2' }).slug).toBeUndefined();
  });
  it('이미지 저장소는 필수, 포트는 1–65535 정수', () => {
    expect(validateRegistration({ ...valid, imageRepo: ' ' }).imageRepo).toBe('errImageRepo');
    for (const bad of ['0', '65536', 'abc', '80.5', '']) expect(validateRegistration({ ...valid, containerPort: bad }).containerPort).toBe('errPort');
    expect(validateRegistration({ ...valid, containerPort: '3000' }).containerPort).toBeUndefined();
  });
  it('브랜치는 255자까지', () => {
    expect(validateRegistration({ ...valid, branch: 'b'.repeat(256) }).branch).toBe('errBranchLong');
  });
});

describe('toGithubApplicationInput', () => {
  it('DTO 키만 보내고 backend 가 채우는 값(source_path, repo, default_branch, health_check)은 넣지 않는다', () => {
    const input = toGithubApplicationInput({ ...valid, name: ' Guestbook ', imageRepo: ' repo/x ', containerPort: ' 8080 ' });
    expect(input).toEqual({
      name: 'Guestbook',
      slug: 'guestbook',
      image_repo: 'repo/x',
      container_port: 8080,
      test_template: 'allow',
      requires_approval: false,
      installation_id: 90210001,
      repository_id: 50010001,
      branch: 'main',
      auto_deploy: true,
    });
    expect(Object.keys(input)).not.toContain('source_path');
    expect(Object.keys(input)).not.toContain('policy_path');
  });
});

describe('validateDeployment (CreateDeploymentDto 규칙)', () => {
  it('source_revision 은 7–40자리 소문자 16진수', () => {
    expect(validateDeployment({ sourceRevision: 'abcdef1', imageDigest: '' })).toEqual({});
    expect(validateDeployment({ sourceRevision: ' 1f6947dce692de48ef4580b1a3f5366adf66f5ae ', imageDigest: '' })).toEqual({});
    for (const bad of ['', 'abcdef', 'ABCDEF1', 'g'.repeat(8), 'a'.repeat(41)]) {
      expect(validateDeployment({ sourceRevision: bad, imageDigest: '' }).sourceRevision).toBe('errSourceRevision');
    }
  });
  it('image_digest 는 비어 있거나 sha256:+64자리', () => {
    expect(validateDeployment({ sourceRevision: 'abcdef1', imageDigest: `sha256:${'a'.repeat(64)}` })).toEqual({});
    expect(validateDeployment({ sourceRevision: 'abcdef1', imageDigest: 'sha256:abc' }).imageDigest).toBe('errImageDigest');
    expect(validateDeployment({ sourceRevision: 'abcdef1', imageDigest: 'a'.repeat(64) }).imageDigest).toBe('errImageDigest');
  });
  it('요청 본문은 DTO 키만, 빈 digest 는 생략', () => {
    expect(toCreateDeploymentInput({ sourceRevision: ' abcdef1 ', imageDigest: '  ' })).toEqual({ source_revision: 'abcdef1' });
    expect(toCreateDeploymentInput({ sourceRevision: 'abcdef1', imageDigest: `sha256:${'b'.repeat(64)}` })).toEqual({ source_revision: 'abcdef1', image_digest: `sha256:${'b'.repeat(64)}` });
  });
});

describe('friendlyBackendError', () => {
  it('backend 고정 메시지를 안내 키로 바꾸고 모르는 메시지는 null', () => {
    expect(friendlyBackendError('Application slug already exists')).toBe('beSlugTaken');
    expect(friendlyBackendError('Application public host already exists')).toBe('beSlugTaken');
    expect(friendlyBackendError('Repository is not accessible')).toBe('beRepoNotAccessible');
    expect(friendlyBackendError('GitHub login is required')).toBe('beGithubReconnect');
    expect(friendlyBackendError('Cannot connect to GitHub')).toBe('beGithubUnavailable');
    expect(friendlyBackendError('something else')).toBeNull();
  });
});

describe('registeredPath (등록 직후 이동)', () => {
  const view = { application: { id: 'app-1' } } as unknown as GithubApplicationCreated;
  it('initial_deployment 가 있으면 그 배포 상세로 간다', () => {
    const created = { ...view, initial_deployment: { id: 'dep-1' } } as GithubApplicationCreated;
    expect(registeredPath(created)).toBe(deploymentPath('dep-1'));
  });
  it('없으면 (#40 이전 backend) 앱 상세로 간다', () => {
    expect(registeredPath(view)).toBe(applicationPath('app-1'));
  });
});

describe('validateDeployment requireFullSha (GitHub 저장소 앱)', () => {
  const full = '1f6947dce692de48ef4580b1a3f5366adf66f5ae';
  it('40자리 소문자 16진수만 받는다', () => {
    expect(validateDeployment({ sourceRevision: full, imageDigest: '' }, { requireFullSha: true })).toEqual({});
    expect(validateDeployment({ sourceRevision: ` ${full} `, imageDigest: '' }, { requireFullSha: true })).toEqual({});
    for (const bad of ['abcdef1', full.slice(0, 39), full.toUpperCase(), `${full}0`]) {
      expect(validateDeployment({ sourceRevision: bad, imageDigest: '' }, { requireFullSha: true }).sourceRevision).toBe('errSourceRevisionFull');
    }
  });
  it('기본(GitHub 이 아닌 앱)은 DTO 규칙 7–40자리 그대로', () => {
    expect(validateDeployment({ sourceRevision: 'abcdef1', imageDigest: '' })).toEqual({});
  });
});

describe('isGithubSource (parity-test.stage isGithubSource 와 같은 규칙)', () => {
  it('backend 가 GitHub 등록 때 만드는 sourcePath 만 true', () => {
    expect(isGithubSource('https://github.com/hibiscus-demo/guestbook.git')).toBe(true);
    expect(isGithubSource('/srv/apps/guestbook')).toBe(false);
    expect(isGithubSource('https://github.com/hibiscus-demo/guestbook')).toBe(false);
    expect(isGithubSource('https://gitlab.com/a/b.git')).toBe(false);
  });
});

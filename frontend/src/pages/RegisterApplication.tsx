import { Building2, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, type DataSource } from '../api/client';
import type { GithubBranchesPage, GithubConnection, GithubInstallation, GithubRepository } from '../api/types';
import { GITHUB_PAGE_SIZE } from '../api/real';
import { ErrorNotice, describeError } from '../components/ErrorNotice';
import { EnvironmentEditor } from '../components/EnvironmentEditor';
import { Collapsible, Crumbs, Empty, Notice, PageTitle, Pill } from '../components/ui';
import { EMPTY_REGISTRATION, friendlyBackendError, registeredPath, repoShortName, slugify, toGithubApplicationInput, validateRegistration, type RegistrationDraft, type RegistrationErrors } from '../lib/forms';
import { useLang } from '../lib/i18n';
import { APPLICATIONS_PATH, navigate, realHref } from '../lib/router';

type Loadable<T> = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; error: unknown };

function useLoadable<T>(load: (() => Promise<T>) | null, deps: unknown[]): Loadable<T> {
  const [value, setValue] = useState<Loadable<T>>({ state: 'idle' });
  useEffect(() => {
    if (!load) {
      setValue({ state: 'idle' });
      return;
    }
    let cancelled = false;
    setValue({ state: 'loading' });
    load().then(
      (v) => !cancelled && setValue({ state: 'ok', value: v }),
      (error: unknown) => !cancelled && setValue({ state: 'error', error }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/**
 * GitHub 저장소로 애플리케이션 등록. backend-v2 (origin/main) 의
 * GET /github/connection → /installations → /repositories → /branches 를 차례로 읽고 POST /github/applications 로 보낸다.
 * mock 에서는 같은 흐름을 in-memory 로 흉내낸다.
 */
export function RegisterApplication({ source }: { source: DataSource }) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState<RegistrationDraft>(EMPTY_REGISTRATION);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const connection = useLoadable<GithubConnection>(() => source.getGithubConnection(), [source]);
  const connected = connection.state === 'ok' && connection.value.connected;
  const installations = useLoadable(connected ? () => source.listGithubInstallations() : null, [source, connected]);
  const repositories = useLoadable(draft.installationId !== null ? () => source.listGithubRepositories(draft.installationId!) : null, [source, draft.installationId]);
  const branches = useLoadable<GithubBranchesPage>(
    draft.installationId !== null && draft.repositoryId !== null ? () => source.listGithubBranches(draft.installationId!, draft.repositoryId!) : null,
    [source, draft.installationId, draft.repositoryId],
  );

  // 설치가 하나뿐이면 바로 고른다
  useEffect(() => {
    if (installations.state === 'ok' && installations.value.installations.length === 1 && draft.installationId === null) {
      setDraft((d) => ({ ...d, installationId: installations.value.installations[0]!.id }));
    }
  }, [installations, draft.installationId]);

  // 브랜치 목록이 오면 기본 브랜치를 미리 고른다
  useEffect(() => {
    if (branches.state === 'ok' && !draft.branch) setDraft((d) => ({ ...d, branch: branches.value.default_branch }));
  }, [branches, draft.branch]);

  const errors: RegistrationErrors = useMemo(() => validateRegistration(draft), [draft]);
  const showError = (field: keyof RegistrationErrors) => (touched && errors[field] ? t(errors[field]!) : null);

  const pickInstallation = (id: number) => setDraft((d) => ({ ...d, installationId: id, repositoryId: null, branch: '' }));
  const pickRepository = (repo: GithubRepository) =>
    setDraft((d) => {
      const short = repoShortName(repo.full_name);
      return {
        ...d,
        repositoryId: repo.id,
        branch: '',
        name: d.name || short,
        slug: d.slug || slugify(short),
      };
    });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await source.createGithubApplication(toGithubApplicationInput(draft));
      navigate(registeredPath(created));
    } catch (error) {
      setSubmitError(error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page page-narrow register">
      <PageTitle crumbs={<Crumbs items={[{ label: t('crumbApps'), href: realHref(APPLICATIONS_PATH) }, { label: t('registerApp') }]} />} title={t('registerTitle')} sub={t('registerSub')} />

      <Notice tone={source.kind === 'real' ? 'warning' : 'muted'}>{source.kind === 'real' ? t('registerRealNote') : t('registerMockNote')}</Notice>

      <form className="stack" onSubmit={submit} noValidate>
        {/* 1. GitHub 연결 */}
        <StepCard n={1} title={t('stepGithub')} aside={connected ? <Pill tone="success">{t('githubConnected')}</Pill> : connection.state === 'ok' ? <Pill tone="danger">{t('githubNotConnected')}</Pill> : null}>
          {connection.state === 'loading' && <Empty>{t('loading')}</Empty>}
          {connection.state === 'error' && <ErrorNotice error={connection.error} />}
          {connection.state === 'ok' && !connection.value.connected && <p className="check-help">{t('githubReconnectHelp')}</p>}
          {connected && (
            <div className="stack-sm">
              <div className="field-label">{t('installationLabel')}</div>
              {installations.state === 'loading' && <Empty>{t('loading')}</Empty>}
              {installations.state === 'error' && <ErrorNotice error={installations.error} />}
              {installations.state === 'ok' && installations.value.installations.length === 0 && (
                <InstallHelp url={connection.state === 'ok' ? connection.value.installation_url : null} />
              )}
              {installations.state === 'ok' && installations.value.installations.length > 0 && (
                <>
                  <ChoiceList
                    items={installations.value.installations}
                    selected={draft.installationId}
                    keyOf={(i: GithubInstallation) => i.id}
                    onPick={(i) => pickInstallation(i.id)}
                    render={(i) => (
                      <>
                        <Building2 size={14} className="kind-icon" aria-hidden />
                        <strong>{i.account}</strong>
                      </>
                    )}
                  />
                  {installations.value.total_count > GITHUB_PAGE_SIZE && <p className="small muted">{t('truncatedList', { n: GITHUB_PAGE_SIZE })}</p>}
                  {connection.state === 'ok' && connection.value.installation_url && (
                    <a className="small" href={connection.value.installation_url} target="_blank" rel="noreferrer">
                      {t('installApp')} <ExternalLink size={12} className="inline-icon" aria-hidden />
                    </a>
                  )}
                </>
              )}
              {showError('installationId') && <p className="form-error">{showError('installationId')}</p>}
            </div>
          )}
        </StepCard>

        {/* 2. 저장소와 브랜치 */}
        <StepCard n={2} title={t('stepRepo')}>
          {draft.installationId === null && <Empty>{t('errInstallation')}</Empty>}
          {repositories.state === 'loading' && <Empty>{t('loading')}</Empty>}
          {repositories.state === 'error' && <ErrorNotice error={repositories.error} />}
          {repositories.state === 'ok' && (
            <div className="stack-sm">
              <div className="field-label">{t('repositoryLabel')}</div>
              {repositories.value.repositories.length === 0 ? (
                <Empty>{t('noRepositories')}</Empty>
              ) : (
                <ChoiceList
                  items={repositories.value.repositories}
                  selected={draft.repositoryId}
                  keyOf={(r: GithubRepository) => r.id}
                  onPick={pickRepository}
                  render={(r) => (
                    <>
                      <strong>{r.full_name}</strong>
                      {r.private && <span className="tag">{t('privateTag')}</span>}
                      <span className="small muted">{r.default_branch}</span>
                    </>
                  )}
                />
              )}
              {repositories.value.total_count > GITHUB_PAGE_SIZE && <p className="small muted">{t('truncatedList', { n: GITHUB_PAGE_SIZE })}</p>}
              {showError('repositoryId') && <p className="form-error">{showError('repositoryId')}</p>}
            </div>
          )}
          {draft.repositoryId !== null && (
            <div className="stack-sm" style={{ marginTop: 14 }}>
              <label className="field-label" htmlFor="branch">
                {t('branchLabel')}
              </label>
              {branches.state === 'loading' && <Empty>{t('loading')}</Empty>}
              {branches.state === 'error' && <ErrorNotice error={branches.error} />}
              {branches.state === 'ok' && (
                <div className="row">
                  <select id="branch" className="input" value={draft.branch} onChange={(e) => setDraft((d) => ({ ...d, branch: e.target.value }))}>
                    {branches.value.branches.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                        {b.name === branches.value.default_branch ? ` (${t('defaultBranchTag')})` : ''}
                      </option>
                    ))}
                  </select>
                  {draft.autoDeploy && draft.branch && <span className="small muted">{t('autoDeployLabel')}</span>}
                </div>
              )}
              {showError('branch') && <p className="form-error">{showError('branch')}</p>}
            </div>
          )}
        </StepCard>

        {/* 3. 앱 설정 */}
        <StepCard n={3} title={t('stepSettings')}>
          <div className="form-grid">
            <Field label={t('appNameLabel')} htmlFor="name" error={showError('name')}>
              <input id="name" className="input" value={draft.name} maxLength={64} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </Field>
            <Field label={t('slugLabel')} htmlFor="slug" hint={t('slugHint')} error={showError('slug')}>
              <input id="slug" className="input mono" value={draft.slug} maxLength={64} spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))} />
            </Field>
            <Field label={t('imageRepoLabel')} htmlFor="imageRepo" hint={t('imageRepoHint')} error={showError('imageRepo')} wide>
              <input id="imageRepo" className="input mono" value={draft.imageRepo} spellCheck={false} placeholder={`asia-northeast3-docker.pkg.dev/<project>/apps/${draft.slug || 'app'}`} onChange={(e) => setDraft((d) => ({ ...d, imageRepo: e.target.value }))} />
            </Field>
            <Field label={t('containerPortLabel')} htmlFor="port" error={showError('containerPort')}>
              <input id="port" className="input mono" inputMode="numeric" value={draft.containerPort} onChange={(e) => setDraft((d) => ({ ...d, containerPort: e.target.value }))} />
            </Field>
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>
            {t('autoFilledNote')}
          </p>
          <div className="fold-list" style={{ marginTop: 10 }}>
            <Collapsible title={t('advancedSettings')}>
              <div className="stack-sm">
                <label className="check-row">
                  <input type="checkbox" checked={draft.autoDeploy} onChange={(e) => setDraft((d) => ({ ...d, autoDeploy: e.target.checked }))} /> {t('autoDeployLabel')}
                </label>
                <p className="form-hint">{t('autoDeployHint')}</p>
                <label className="check-row">
                  <input type="checkbox" checked={draft.requiresApproval} onChange={(e) => setDraft((d) => ({ ...d, requiresApproval: e.target.checked }))} /> {t('requiresApprovalLabel')}
                </label>
                <Field label={t('testTemplateLabel')} htmlFor="testTemplate">
                  <select id="testTemplate" className="input" value={draft.testTemplate} onChange={(e) => setDraft((d) => ({ ...d, testTemplate: e.target.value as RegistrationDraft['testTemplate'] }))}>
                    <option value="allow">{t('testTemplateAllow')}</option>
                    <option value="block-test-failed">{t('testTemplateBlock')}</option>
                  </select>
                </Field>
                <div className="form-field">
                  <span className="field-label">{t('environmentTitle')}</span>
                  <p className="form-hint">{t('environmentRegisterHint')}</p>
                  <EnvironmentEditor value={draft.environment} onChange={(environment) => setDraft((d) => ({ ...d, environment }))} />
                </div>
                <div className="form-field">
                  <span className="field-label">{t('testEnvironmentTitle')}</span>
                  <p className="form-hint">{t('testEnvironmentRegisterHint')}</p>
                  <EnvironmentEditor value={draft.testEnvironment} onChange={(testEnvironment) => setDraft((d) => ({ ...d, testEnvironment }))} />
                </div>
              </div>
            </Collapsible>
          </div>
        </StepCard>

        <p className="small muted">{t('registerInitialDeploy')}</p>

        {submitError !== null && <SubmitError error={submitError} lang={lang} />}

        <div className="row form-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting || !connected}>
            {submitting ? t('submitting') : t('submitRegister')}
          </button>
          <a className="btn" href={realHref(APPLICATIONS_PATH)}>
            {t('cancel')}
          </a>
          {touched && Object.keys(errors).length > 0 && <span className="form-error">{t(Object.values(errors)[0]!)}</span>}
        </div>
      </form>
    </div>
  );
}

function StepCard({ n, title, aside, children }: { n: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <span className="step-card-mark" aria-hidden>
            <span className="num">{n}</span>
          </span>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, htmlFor, hint, error, wide, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`form-field ${wide ? 'form-field-wide' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <span className="form-error">{error}</span> : hint ? <span className="form-hint">{hint}</span> : null}
    </div>
  );
}

function ChoiceList<T>({ items, selected, keyOf, onPick, render }: { items: T[]; selected: number | null; keyOf: (item: T) => number; onPick: (item: T) => void; render: (item: T) => ReactNode }) {
  return (
    <ul className="choice-list" role="radiogroup">
      {items.map((item) => {
        const key = keyOf(item);
        const active = key === selected;
        return (
          <li key={key}>
            <button type="button" role="radio" aria-checked={active} className={`choice ${active ? 'choice-active' : ''}`} onClick={() => onPick(item)}>
              <span className={`choice-dot ${active ? 'choice-dot-on' : ''}`} aria-hidden />
              <span className="row row-tight">{render(item)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function InstallHelp({ url }: { url: string | null }) {
  const { t } = useLang();
  return (
    <div className="stack-sm">
      <p className="check-help">{t('noInstallations')}</p>
      {url ? (
        <a className="btn btn-small" href={url} target="_blank" rel="noreferrer">
          {t('installApp')} <ExternalLink size={12} aria-hidden />
        </a>
      ) : (
        <p className="small muted">{t('installAppNoUrl')}</p>
      )}
    </div>
  );
}

/** backend 오류를 사람이 읽는 문장으로. 알려진 메시지는 안내문, 나머지는 원문 */
function SubmitError({ error, lang }: { error: unknown; lang: 'ko' | 'ja' }) {
  const { t } = useLang();
  const friendly = error instanceof ApiError ? friendlyBackendError(error.message) : null;
  const described = describeError(error, lang);
  return (
    <Notice tone={described.unauthorized ? 'warning' : 'danger'} title={t('registerFailed')}>
      {friendly ? t(friendly) : described.title}
      {described.detail && !friendly && <span className="mono small"> ({described.detail})</span>}
    </Notice>
  );
}

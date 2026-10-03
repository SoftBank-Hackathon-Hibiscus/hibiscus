import { Check, Clock, Cloud, FlaskConical, LoaderCircle, Lock, Minus, Rocket, Scale, Server, ShieldX, TriangleAlert, UserCheck, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { DataSource } from '../api/client';
import type { Approval, PiiReport, SignLog, TestResult } from '../api/contracts';
import type { ApplicationView, Decision, DeploymentStatus, DeploymentView, StageName } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Loader } from '../components/Loader';
import { Modal } from '../components/Modal';
import { Collapsible, Crumbs, DemoBadge, Empty, Hash, Kv, PageTitle, Pill, type Tone } from '../components/ui';
import { useMinVisible } from '../hooks/useMinVisible';
import { usePolling } from '../hooks/usePolling';
import { findArtifact, latestStages, parseJsonArtifact } from '../lib/artifacts';
import { fmtTime, relTime, targetLabel } from '../lib/format';
import { pickLang, useLang, type DictKey } from '../lib/i18n';
import { Markdown, prepareExplain } from '../lib/markdown';
import { APPLICATIONS_PATH, applicationPath, hrefFor } from '../lib/router';
import { summarizeDeployment, type DeploymentSummary, type ProofLink } from '../lib/summary';

const PROGRESSING: DeploymentStatus[] = ['queued', 'running', 'awaiting_approval'];
const STATUS_KEY: Record<DeploymentStatus, DictKey> = { queued: 'statusQueued', running: 'statusRunning', awaiting_approval: 'statusAwaiting', blocked: 'statusBlocked', failed: 'statusFailed', succeeded: 'statusSucceeded' };
const STATUS_TONE: Record<DeploymentStatus, Tone> = { queued: 'info', running: 'info', awaiting_approval: 'warning', blocked: 'danger', failed: 'danger', succeeded: 'success' };
const STATUS_ICON: Record<DeploymentStatus, LucideIcon> = { queued: Minus, running: LoaderCircle, awaiting_approval: Clock, blocked: ShieldX, failed: X, succeeded: Check };
const DECISION_TONE: Record<Decision, Tone> = { allow: 'success', needs_approval: 'warning', block: 'danger' };
const DECISION_LABEL: Record<Decision, string> = { allow: 'ALLOW', needs_approval: 'NEEDS_APPROVAL', block: 'BLOCK' };
const STEP_DETAIL_KEY: Record<StageName, DictKey> = { test: 'testDetail', policy: 'policyDetail', sign: 'signDetail', deploy: 'deployDetail' };
/** 상태 표시용 작은 단색 아이콘. 색은 아이콘 자체에만 쓴다. */
const TONE_ICON: Record<Tone, LucideIcon> = { success: Check, warning: TriangleAlert, danger: X, info: LoaderCircle, muted: Minus };

/** 재생 테스트 조건 이름(none/restart/replace)을 화면 말로. */
function conditionName(t: (key: DictKey) => string, name: string): string {
  return name === 'none' ? t('conditionNone') : name === 'restart' ? t('conditionRestart') : name === 'replace' ? t('conditionReplace') : name;
}

function KindIcon({ kind, size = 13 }: { kind: string; size?: number }) {
  return kind === 'onprem' ? <Server size={size} aria-hidden /> : <Cloud size={size} aria-hidden />;
}

function CardTitle({ icon: Icon, children, aside }: { icon?: LucideIcon; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="card-head">
      <h2 className="card-title">
        {Icon && <Icon size={16} className="title-icon" aria-hidden />}
        {children}
      </h2>
      {aside}
    </div>
  );
}

/**
 * 배포 상세. 기본 UI 는 자연어 결론·판단·고쳐야 할 것·증명 체인까지만 보여 준다.
 * digest/plan_hash/rule id 같은 값은 각 카드 안의 작은 접기 영역에만 두고, 원본 JSON 은 내지 않는다.
 */
export function DeploymentDetail({ id, source }: { id: string; source: DataSource }) {
  const { t, lang } = useLang();
  const [progressing, setProgressing] = useState(false);
  const poll = usePolling(() => source.getDeployment(id), progressing ? 2000 : null, [id, source]);
  const view = poll.data;

  useEffect(() => {
    if (view) setProgressing(PROGRESSING.includes(view.deployment.status));
  }, [view]);

  const [app, setApp] = useState<ApplicationView | null>(null);
  const applicationId = view?.deployment.applicationId;
  useEffect(() => {
    if (!applicationId) return;
    let cancelled = false;
    source.getApplication(applicationId).then((a) => !cancelled && setApp(a)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applicationId, source]);

  const summary = useMemo(() => (view ? summarizeDeployment(view, lang) : null), [view, lang]);

  const showLoader = useMinVisible(poll.loading && !view, 900);

  if (showLoader) return <Loader label={t('loading')} />;
  if (!view || !summary) return <ErrorNotice error={poll.error ?? new Error('no data')} />;
  const d = view.deployment;
  const appName = app?.application.name ?? d.applicationId;
  const needsApproval = d.decision === 'needs_approval' || d.status === 'awaiting_approval';
  const HeadIcon = TONE_ICON[summary.tone];

  return (
    <div className="page">
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <PageTitle
        crumbs={<Crumbs items={[{ label: t('crumbApps'), href: hrefFor(APPLICATIONS_PATH) }, { label: appName, href: hrefFor(applicationPath(d.applicationId)) }, { label: `v${d.version}` }]} />}
        title={
          <>
            {appName} <span className="muted">v{d.version}</span>
          </>
        }
        right={
          <div className="title-badges">
            {summary.decision && <Pill tone={DECISION_TONE[summary.decision]}>{DECISION_LABEL[summary.decision]}</Pill>}
            <Pill tone={STATUS_TONE[d.status]} icon={STATUS_ICON[d.status]} spin={d.status === 'running'}>
              {t(STATUS_KEY[d.status])}
            </Pill>
            {d.deploymentPerformed && <Pill tone="success">{t('deployed')}</Pill>}
            {progressing && (
              <span className="live">
                {t('refreshing2s')}
                {poll.lastUpdated ? `, ${relTime(new Date(poll.lastUpdated).toISOString())}` : ''}
              </span>
            )}
          </div>
        }
      />

      <Stepper view={view} summary={summary} />

      <section key={summary.conclusion} className="card headline-card">
        <span className={`headline-icon tone-${summary.tone}`} aria-hidden>
          <HeadIcon size={14} />
        </span>
        <p className="headline-text">{summary.conclusion}</p>
      </section>

      <div className="grid-2">
        <section className="card">
          <CardTitle icon={FlaskConical}>{t(STEP_DETAIL_KEY.test)}</CardTitle>
          <TestDetail view={view} summary={summary} />
        </section>
        <section className="card">
          <CardTitle icon={Scale}>{t(STEP_DETAIL_KEY.policy)}</CardTitle>
          <PolicyDetail view={view} summary={summary} appName={appName} />
        </section>
      </div>

      {needsApproval ? (
        <>
          <div className="grid-2">
            <section className="card">
              <CardTitle icon={UserCheck}>{t('approvalTitle')}</CardTitle>
              <ApprovalCard view={view} source={source} onChanged={poll.refresh} />
            </section>
            <section className="card">
              <CardTitle icon={Lock}>{t(STEP_DETAIL_KEY.sign)}</CardTitle>
              <SignDetail view={view} summary={summary} />
            </section>
          </div>
          <section className="card">
            <CardTitle icon={Rocket}>{t(STEP_DETAIL_KEY.deploy)}</CardTitle>
            <DeployDetail summary={summary} />
          </section>
        </>
      ) : (
        <div className="grid-2">
          <section className="card">
            <CardTitle icon={Lock}>{t(STEP_DETAIL_KEY.sign)}</CardTitle>
            <SignDetail view={view} summary={summary} />
          </section>
          <section className="card">
            <CardTitle icon={Rocket}>{t(STEP_DETAIL_KEY.deploy)}</CardTitle>
            <DeployDetail summary={summary} />
          </section>
        </div>
      )}

      <section className="card">
        <CardTitle aside={source.kind === 'mock' ? <DemoBadge small /> : undefined}>{t('proofChain')}</CardTitle>
        <ul className="proof-list">
          {summary.proof.map((link) => (
            <ProofRow key={link.id} link={link} />
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- stepper (빠른 파악용)

interface StepItem {
  key: string;
  label: string;
  short: string;
  tone: Tone;
}

function Stepper({ view, summary }: { view: DeploymentView; summary: DeploymentSummary }) {
  const { t } = useLang();
  const d = view.deployment;
  const [test, policy, sign, deploy] = summary.steps;
  const result = summary.parsed.test;
  const failedCondition = result?.facts?.conditions?.find((c) => c.failed);
  const testShort = !test?.stage
    ? t('shortNotRun')
    : result
      ? failedCondition
        ? `${conditionName(t, failedCondition.name)} ${failedCondition.matched}/${failedCondition.total}`
        : `${result.match.matched}/${result.match.total}`
      : test.tone === 'success'
        ? t('shortPassed')
        : test.tone === 'danger'
          ? t('shortFailed')
          : test.tone === 'info'
            ? t('shortRunning')
            : t('shortPending');

  const policyShort = summary.decision ? DECISION_LABEL[summary.decision] : policy?.stage ? (policy.tone === 'info' ? t('shortRunning') : t('shortPending')) : t('shortNotRun');

  let approvalShort = '-';
  let approvalTone: Tone = 'muted';
  if (summary.decision === 'allow') approvalShort = t('shortAuto');
  else if (summary.decision === 'needs_approval') {
    if (d.approver) {
      approvalShort = t('shortApproved');
      approvalTone = 'success';
    } else if (d.status === 'awaiting_approval') {
      approvalShort = t('shortAwaiting');
      approvalTone = 'warning';
    } else approvalShort = t('shortPending');
  } else if (summary.decision === 'block') approvalShort = t('shortNotRun');

  const signShort = !sign?.stage ? t('shortNotRun') : summary.parsed.sign ? (summary.parsed.sign.signature_ref.startsWith('dry-run:') ? t('shortDryRun') : t('shortSigned')) : sign.tone === 'danger' ? t('shortRefused') : sign.tone === 'info' ? t('shortRunning') : t('shortPending');

  const dr = summary.parsed.deployResult;
  const deployShort = !deploy?.stage
    ? t('shortNotRun')
    : dr
      ? dr.decision === 'activated'
        ? dr.routing.result === 'ok'
          ? t('shortDeployed')
          : t('shortSwitchFailed')
        : dr.decision === 'held'
          ? t('shortHeld')
          : dr.decision === 'rolled_back'
            ? t('shortRolledBack')
            : t('shortError')
      : deploy.stage.status === 'skipped'
        ? t('shortSkipped')
        : deploy.tone === 'info'
          ? t('shortRunning')
          : deploy.tone === 'danger'
            ? t('shortError')
            : t('shortPending');

  const items: StepItem[] = [
    { key: 'test', label: t('stepTest'), short: testShort, tone: test?.tone ?? 'muted' },
    { key: 'policy', label: t('stepPolicy'), short: policyShort, tone: policy?.tone ?? 'muted' },
    { key: 'approval', label: t('stepApproval'), short: approvalShort, tone: approvalTone },
    { key: 'sign', label: t('stepSign'), short: signShort, tone: sign?.tone ?? 'muted' },
    { key: 'deploy', label: t('stepDeploy'), short: deployShort, tone: deploy?.tone ?? 'muted' },
  ];

  return (
    <section className="card">
      <ol className="stepper" aria-label="pipeline">
        {items.map((item, i) => {
          const Icon = item.tone === 'muted' && item.short === t('shortPending') ? Clock : TONE_ICON[item.tone];
          return (
            <li key={item.key} className={`step step-${item.tone}`} style={{ '--i': i } as CSSProperties}>
              {/* 상태가 바뀌면 key 가 바뀌어 표시가 다시 그려지면서 한 번 튄다 */}
              <span key={item.tone} className="step-mark" aria-hidden>
                <Icon size={14} className={item.tone === 'info' ? 'spin' : undefined} />
              </span>
              <span className="step-label">{item.label}</span>
              <span className="step-short">{item.short}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- proof chain

const PROOF_STATE: Record<ProofLink['state'], { tone: Tone; key: DictKey }> = {
  ok: { tone: 'success', key: 'proofOk' },
  mismatch: { tone: 'danger', key: 'proofMismatch' },
  pending: { tone: 'muted', key: 'proofPending' },
  unverified: { tone: 'muted', key: 'proofUnverified' },
  na: { tone: 'muted', key: 'proofNa' },
};

function ProofRow({ link }: { link: ProofLink }) {
  const { t } = useLang();
  const state = PROOF_STATE[link.state];
  const Icon = state.tone === 'success' ? Check : state.tone === 'danger' ? X : Minus;
  return (
    <li className="proof-row">
      <span className={`proof-mark tone-${state.tone}`} aria-hidden>
        <Icon size={13} />
      </span>
      <div className="proof-text">
        <span className="proof-title">{link.title}</span>
        <span className="proof-detail">{link.detail}</span>
      </div>
      <Pill tone={state.tone}>{t(state.key)}</Pill>
    </li>
  );
}

// ---------------------------------------------------------------- policy

function TargetList({ targets }: { targets: string[] }) {
  const { t } = useLang();
  if (targets.length === 0) return <span className="muted">{t('none')}</span>;
  return (
    <span className="row row-tight">
      {targets.map((kind) => (
        <span key={kind} className="inline-kind">
          <KindIcon kind={kind} size={14} />
          {targetLabel(kind)}
        </span>
      ))}
    </span>
  );
}

function PolicyDetail({ view, summary, appName }: { view: DeploymentView; summary: DeploymentSummary; appName: string }) {
  const { t, lang, setLang } = useLang();
  const d = view.deployment;
  const skeleton = d.executionMode === 'skeleton';
  const stage = latestStages(view.stages).policy;
  const pii = parseJsonArtifact<PiiReport>(findArtifact(view, 'pii', stage));
  const explainKo = findArtifact(view, 'explain.ko', stage);
  const explainJa = findArtifact(view, 'explain.ja', stage);
  const explain = (lang === 'ja' ? explainJa : explainKo) ?? explainKo ?? explainJa;
  const [explainOpen, setExplainOpen] = useState(false);
  const decision = summary.decision;
  const plan = summary.parsed.plan;
  const rules = plan?.rules ?? [];
  const hit = rules.filter((r) => r.result !== 'not_matched');
  const planHash = view.policyResult?.planHash ?? plan?.plan_hash ?? null;

  if (!decision && !stage) return <Empty>{t('resultPending')}</Empty>;

  return (
    <div className="stack">
      <dl className="facts">
        <div className="fact">
          <dt>{t('decision')}</dt>
          <dd>{decision ? <Pill tone={DECISION_TONE[decision]}>{DECISION_LABEL[decision]}</Pill> : <span className="muted">{t('none')}</span>}</dd>
        </div>
        <div className="fact">
          <dt>{t('targets')}</dt>
          <dd>
            <TargetList targets={summary.targets} />
          </dd>
        </div>
        <div className="fact">
          <dt>{t('failoverLabel')}</dt>
          <dd>
            {summary.failoverAllowed === null ? <span className="muted">{t('none')}</span> : summary.failoverAllowed ? t('failoverOn') : t('failoverOff')}
            {summary.failoverWhy && <div className="small muted">{summary.failoverWhy}</div>}
          </dd>
        </div>
      </dl>

      {summary.reasons.length > 0 && (
        <div>
          <div className="sub-title">{t('whyTitle')}</div>
          <ul className="reasons">
            {summary.reasons.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {skeleton && <p className="small muted">{t('stubPolicy')}</p>}

      {!skeleton && pii?.ok && pii.value.pii && pii.value.pii.length > 0 && (
        <div>
          <div className="sub-title">{t('piiTitle')}</div>
          <table className="table small">
            <tbody>
              {pii.value.pii.map((p, i) => (
                <tr key={i}>
                  <td className="mono">
                    {p.table}.{p.column}
                  </td>
                  <td>{p.confident ? <Pill tone="danger">{t('piiConfident')}</Pill> : <Pill tone="warning">{t('piiReview')}</Pill>}</td>
                  <td className="small muted">{p.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!skeleton && explain && (
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setExplainOpen(true)}>
            {t('explainOpen')}
          </button>
        </div>
      )}

      {(summary.requires.length > 0 || hit.length > 0 || planHash) && (
        <div className="fold-list">
          {summary.requires.length > 0 && (
            <Collapsible title={t('requires')} summary={<span className="muted small">{summary.requires.length}</span>}>
              <div className="fold-items">
                {summary.requires.map((r) => (
                  <Collapsible
                    key={`${r.id}-${r.ruleId}`}
                    title={r.title}
                    summary={
                      <span className="muted small">
                        {r.id} · {r.ruleId}
                      </span>
                    }
                  >
                    <div className="fold-body">
                      {r.why && <p>{r.why}</p>}
                      <div className="small">
                        <span className="muted">{r.unlocks.length ? `${t('fixUnlocks')}: ` : ''}</span>
                        {r.unlocks.length ? <TargetList targets={r.unlocks} /> : <span className="muted">{t('fixUnlocksNone')}</span>}
                      </div>
                    </div>
                  </Collapsible>
                ))}
              </div>
            </Collapsible>
          )}
          {hit.length > 0 && (
            <Collapsible title={t('rulesTitle')} summary={<span className="muted small">{hit.length}</span>}>
              <div className="fold-body">
                <ul className="rule-rows">
                  {hit.map((r) => {
                    const reason = pickLang(lang, r.reason, r.reason_i18n);
                    return (
                      <li key={r.id} className="rule-row">
                        <span className="mono rule-id">{r.id}</span>
                        <span className="rule-reason">{reason ?? <span className="muted">{t('none')}</span>}</span>
                        {r.result === 'matched_after_block' && <span className="tag">{t('matchedAfterBlock')}</span>}
                      </li>
                    );
                  })}
                </ul>
                <p className="small muted">{t('rulesEvaluated', { total: rules.length, hit: hit.length })}</p>
              </div>
            </Collapsible>
          )}
          {planHash && (
            <Collapsible title={t('policyDetails')}>
              <div className="fold-body">
                <Kv columns={1} items={[['plan_hash', <Hash value={planHash} length={24} />]]} />
              </div>
            </Collapsible>
          )}
        </div>
      )}

      {explainOpen && explain && <ExplainModal source={explain.content} title={`${appName} v${d.version}`} onClose={() => setExplainOpen(false)} lang={lang} setLang={setLang} hasKo={Boolean(explainKo)} hasJa={Boolean(explainJa)} />}
    </div>
  );
}

function ExplainModal({ source, title, onClose, lang, setLang, hasKo, hasJa }: { source: string; title: string; onClose: () => void; lang: 'ko' | 'ja'; setLang: (l: 'ko' | 'ja') => void; hasKo: boolean; hasJa: boolean }) {
  const { t } = useLang();
  // 본문만 보여 준다. run_id/rule id 가 담긴 기술 꼬리말은 prepareExplain 이 분리하며 기본 UI 에서는 내지 않는다.
  const prepared = useMemo(() => prepareExplain(source), [source]);
  return (
    <Modal
      title={
        <>
          {title} <span className="muted">· {t('policyDecision')}</span>
        </>
      }
      onClose={onClose}
      toolbar={
        <div className="lang-switch" role="group" aria-label="language" data-active={lang}>
          <button type="button" className={lang === 'ko' ? 'lang-on' : ''} onClick={() => setLang('ko')} disabled={!hasKo}>KO</button>
          <button type="button" className={lang === 'ja' ? 'lang-on' : ''} onClick={() => setLang('ja')} disabled={!hasJa}>JA</button>
        </div>
      }
    >
      <div lang={lang} className="explain-body">
        <Markdown source={prepared.body} />
      </div>
    </Modal>
  );
}

function ApprovalCard({ view, source, onChanged }: { view: DeploymentView; source: DataSource; onChanged: () => void }) {
  const { t } = useLang();
  const d = view.deployment;
  const approval = parseJsonArtifact<Approval>(findArtifact(view, 'approval'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const awaiting = d.status === 'awaiting_approval';
  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await source.approveDeployment(d.id);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="row">{awaiting ? <Pill tone="warning">{t('awaitingApproval')}</Pill> : d.approver ? <Pill tone="success">{t('approved')}</Pill> : <Pill tone="muted">{t('none')}</Pill>}</div>
      <Kv columns={2} items={[[t('approver'), d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">{t('none')}</span>], approval?.ok ? [t('approvedAt'), fmtTime(approval.value.approved_at)] : null]} />
      {awaiting && (
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
            {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
            {busy ? t('approving') : t('approve')}
          </button>
          <span className="small muted">{t('selfApprovalNote')}</span>
        </div>
      )}
      {error !== null && <ErrorNotice error={error} />}
    </div>
  );
}

// ---------------------------------------------------------------- test

function TestDetail({ view, summary }: { view: DeploymentView; summary: DeploymentSummary }) {
  const { t } = useLang();
  const stage = latestStages(view.stages).test;
  const parsed = parseJsonArtifact<TestResult>(findArtifact(view, 'test_result', stage));
  const result = summary.parsed.test;
  const stub = (stage?.summary as { stub?: boolean } | null)?.stub === true;
  const step = summary.steps.find((s) => s.name === 'test');
  if (!stage) return <Empty>{step?.result ?? t('resultPending')}</Empty>;
  if (!result) {
    // validationError(run_id/digest 불일치) 는 parseJsonArtifact 가 ok:false 로 돌려 주고, 여기서 사람이 읽을 오류로만 보여 준다.
    return parsed && !parsed.ok ? <ErrorNotice error={new Error(parsed.error)} /> : <Empty>{t('noTestResult')}</Empty>;
  }
  const conditions = result.facts?.conditions ?? [];
  const localFiles = result.facts?.writes_local_file ?? [];
  const withMismatch = conditions.filter((c) => c.mismatches.length > 0);
  return (
    <div className="stack">
      <div className="row">
        <Pill tone={result.passed ? 'success' : 'danger'} icon={result.passed ? Check : X}>
          {step?.result}
        </Pill>
      </div>
      {stub && <p className="small muted">{t('stubTest')}</p>}
      <dl className="facts">
        <div className="fact">
          <dt>{conditions.length ? t('baseMatch') : t('requestsMatched')}</dt>
          <dd className="num">
            {result.match.matched}/{result.match.total}
          </dd>
        </div>
        {result.facts?.db && (
          <div className="fact">
            <dt>{t('dbLabel')}</dt>
            <dd className="mono">{result.facts.db}</dd>
          </div>
        )}
        {localFiles.length > 0 && (
          <div className="fact">
            <dt>{t('localWrites')}</dt>
            <dd className="mono">{localFiles.join(', ')}</dd>
          </div>
        )}
      </dl>
      {conditions.length > 0 && (
        <div>
          <div className="sub-title">{t('conditionsTitle')}</div>
          <div className="conditions">
            {conditions.map((c, i) => {
              const pct = c.total ? Math.round((c.matched / c.total) * 100) : 0;
              return (
                <div key={c.name} className="condition">
                  <div className="condition-head">
                    <span>{conditionName(t, c.name)}</span>
                    <span className={`num ${c.failed ? 'tone-danger' : 'tone-success'}`}>
                      <strong>{c.matched}</strong>/{c.total}
                    </span>
                  </div>
                  <div className="bar" aria-hidden>
                    <span className={`bar-fill ${c.failed ? 'bar-danger' : 'bar-success'}`} style={{ width: `${pct}%`, animationDelay: `${i * 90}ms` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {withMismatch.length > 0 && (
        <div className="fold-list">
          {withMismatch.map((c) => (
            <Collapsible key={c.name} title={t('mismatchIn', { name: conditionName(t, c.name), n: c.mismatches.length })}>
              <table className="table small">
                <tbody>
                  {c.mismatches.map((m) => (
                    <tr key={m.index}>
                      <td className="num muted">#{m.index}</td>
                      <td className="mono">{m.request}</td>
                      <td>{m.related_kind ? <span className="tag">{m.related_kind}</span> : <span className="small muted">{t('unknownCause')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Collapsible>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- sign

function SignDetail({ view, summary }: { view: DeploymentView; summary: DeploymentSummary }) {
  const { t } = useLang();
  const stage = latestStages(view.stages).sign;
  const sign = summary.parsed.sign;
  const signLogs = view.auditLogs.filter((l) => l.kind === 'sign').map((l) => l.payload as unknown as SignLog);
  const lastLog = signLogs[signLogs.length - 1];
  const step = summary.steps.find((s) => s.name === 'sign');
  if (!stage) return <Empty>{step?.result ?? t('resultPending')}</Empty>;
  if (!sign && !lastLog) return <Empty>{t('noSign')}</Empty>;
  const dryRun = sign?.signature_ref.startsWith('dry-run:') ?? false;
  const refused = lastLog?.result === 'refused';
  const ref = sign?.signature_ref ?? lastLog?.signature_ref ?? null;
  return (
    <div className="stack">
      <div className="row">
        <Pill tone={refused ? 'danger' : dryRun ? 'muted' : 'success'} icon={refused ? X : Lock}>
          {step?.result}
        </Pill>
      </div>
      <p>{refused ? t('signLineRefused') : dryRun ? t('signLineDry') : t('signLineOk')}</p>
      <Kv
        columns={3}
        items={[
          [t('signedBy'), <span className="mono">{sign?.approver ?? lastLog?.approver ?? t('none')}</span>],
          [t('signedAt'), fmtTime(sign?.signed_at ?? lastLog?.time)],
          sign ? [t('signedTargets'), <TargetList targets={sign.targets} />] : null,
        ]}
      />
      {ref && (
        <div className="fold-list">
          <Collapsible title={t('signRef')}>
            <div className="fold-body">
              <Hash value={ref} length={48} />
            </div>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- deploy

function DeployDetail({ summary }: { summary: DeploymentSummary }) {
  const { t } = useLang();
  const result = summary.parsed.deployResult;
  const step = summary.steps.find((s) => s.name === 'deploy');
  const r = result?.routing;
  return (
    <div className="stack">
      <div className="row">{step && <Pill tone={step.tone}>{step.result}</Pill>}</div>
      <ul className="reasons">
        {summary.deployLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {result && r?.result === 'ok' && (
        <Kv
          columns={3}
          items={[
            [t('routeTarget'), r.kind ? <TargetList targets={[r.kind]} /> : <span className="muted">{t('none')}</span>],
            [t('switchCount'), r.revision ?? t('none')],
            r.standby_target_id ? [targetLabel(r.kind === 'onprem' ? 'cloud_run' : 'onprem'), r.standby_enabled ? t('standbyReady') : t('standbyOff')] : null,
          ]}
        />
      )}
    </div>
  );
}

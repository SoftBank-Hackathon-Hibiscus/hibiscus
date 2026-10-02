import { useEffect, useMemo, useState } from 'react';
import type { DataSource } from '../api/client';
import type { Approval, PiiReport, SignLog, TestResult } from '../api/contracts';
import type { ApplicationView, Decision, DeploymentStatus, DeploymentView, StageName } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Modal } from '../components/Modal';
import { Collapsible, DemoBadge, Empty, Kv, PageTitle, Pill, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { findArtifact, latestStages, parseJsonArtifact } from '../lib/artifacts';
import { fmtTime, relTime, targetLabel } from '../lib/format';
import { useLang, type DictKey } from '../lib/i18n';
import { Markdown, prepareExplain } from '../lib/markdown';
import { applicationPath, hrefFor } from '../lib/router';
import { summarizeDeployment, type DeploymentSummary, type ProofLink } from '../lib/summary';

const PROGRESSING: DeploymentStatus[] = ['queued', 'running', 'awaiting_approval'];
const STATUS_KEY: Record<DeploymentStatus, DictKey> = { queued: 'statusQueued', running: 'statusRunning', awaiting_approval: 'statusAwaiting', blocked: 'statusBlocked', failed: 'statusFailed', succeeded: 'statusSucceeded' };
const STATUS_TONE: Record<DeploymentStatus, Tone> = { queued: 'info', running: 'info', awaiting_approval: 'warning', blocked: 'danger', failed: 'danger', succeeded: 'success' };
const DECISION_TONE: Record<Decision, Tone> = { allow: 'success', needs_approval: 'warning', block: 'danger' };
const DECISION_LABEL: Record<Decision, string> = { allow: 'ALLOW', needs_approval: 'NEEDS_APPROVAL', block: 'BLOCK' };
const STEP_DETAIL_KEY: Record<StageName, DictKey> = { test: 'testDetail', policy: 'policyDetail', sign: 'signDetail', deploy: 'deployDetail' };
const TONE_ICON: Record<Tone, string> = { success: '✓', warning: '!', danger: '✕', info: '…', muted: '–' };

/** 재생 테스트 조건 이름(none/restart/replace)을 화면 말로. */
function conditionName(t: (key: DictKey) => string, name: string): string {
  return name === 'none' ? t('conditionNone') : name === 'restart' ? t('conditionRestart') : name === 'replace' ? t('conditionReplace') : name;
}

/**
 * 배포 상세. 기본 UI 는 자연어 결론·판단·고칠 것·증명 체인까지만 보여 준다.
 * digest/plan_hash/rule id/artifact 원본은 데이터 계층(lib/summary, lib/artifacts)에 남아 있지만 화면에는 내지 않는다.
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

  if (poll.loading && !view) return <Empty>{t('loading')}</Empty>;
  if (!view || !summary) return <ErrorNotice error={poll.error ?? new Error('no data')} />;
  const d = view.deployment;
  const appName = app?.application.name ?? d.applicationId;

  return (
    <div className="page">
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <PageTitle
        title={
          <>
            <a className="crumb-link" href={hrefFor(applicationPath(d.applicationId))}>{appName}</a> <span className="muted">v{d.version}</span>
          </>
        }
        right={
          <div className="title-badges">
            {summary.decision && <Pill tone={DECISION_TONE[summary.decision]}>{DECISION_LABEL[summary.decision]}</Pill>}
            <Pill tone={STATUS_TONE[d.status]}>{t(STATUS_KEY[d.status])}</Pill>
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

      <section className={`card headline-card headline-${summary.tone}`}>
        <span className="headline-icon" aria-hidden>{TONE_ICON[summary.tone]}</span>
        <p className="headline-text">{summary.conclusion}</p>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2 className="card-title">{t(STEP_DETAIL_KEY.test)}</h2>
          <TestDetail view={view} summary={summary} />
        </section>
        <section className="card">
          <h2 className="card-title">{t(STEP_DETAIL_KEY.policy)}</h2>
          <PolicyDetail view={view} summary={summary} source={source} onChanged={poll.refresh} appName={appName} />
        </section>
      </div>

      {summary.requires.length > 0 && (
        <section className="card">
          <h2 className="card-title">{t('requires')}</h2>
          <div className="requires">
            {summary.requires.map((r) => (
              <div key={`${r.id}-${r.ruleId}`} className="require">
                <div className="require-title">{r.title}</div>
                {r.why && <div className="require-why">{r.why}</div>}
                <div className="require-unlock">{r.unlocks.length ? `${t('fixUnlocks')}: ${r.unlocks.map(targetLabel).join(', ')}` : t('fixUnlocksNone')}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <h2 className="card-title">{t(STEP_DETAIL_KEY.sign)}</h2>
          <SignDetail view={view} summary={summary} />
        </section>
        <section className="card">
          <h2 className="card-title">{t(STEP_DETAIL_KEY.deploy)}</h2>
          <DeployDetail summary={summary} />
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('proofChain')}</h2>
          {source.kind === 'mock' && <DemoBadge small />}
        </div>
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
    <ol className="stepper card" aria-label="pipeline">
      {items.map((item, i) => (
        <li key={item.key} className={`step step-${item.tone}`}>
          <span className="step-dot" aria-hidden>{TONE_ICON[item.tone]}</span>
          {i < items.length - 1 && <span className="step-line" aria-hidden />}
          <span className="step-label">{item.label}</span>
          <span className={`step-short tone-${item.tone}`}>{item.short}</span>
        </li>
      ))}
    </ol>
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
  return (
    <li className="proof-row">
      <div className="proof-line">
        <span className={`proof-mark proof-mark-${state.tone}`} aria-hidden>{state.tone === 'success' ? '✓' : state.tone === 'danger' ? '✕' : '–'}</span>
        <div className="proof-text">
          <span className="proof-title">{link.title}</span>
          <span className="proof-detail">{link.detail}</span>
        </div>
        <Pill tone={state.tone}>{t(state.key)}</Pill>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- policy

function PolicyDetail({ view, summary, source, onChanged, appName }: { view: DeploymentView; summary: DeploymentSummary; source: DataSource; onChanged: () => void; appName: string }) {
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
  const needsApproval = d.decision === 'needs_approval' || d.status === 'awaiting_approval';

  if (!decision && !stage) return <Empty>{t('resultPending')}</Empty>;

  return (
    <div className="stack">
      <div className="decision-row">
        <div>
          <div className="field-label">{t('decision')}</div>
          <div className={`decision-value tone-${decision ? DECISION_TONE[decision] : 'muted'}`}>{decision ? DECISION_LABEL[decision] : t('none')}</div>
        </div>
        <div>
          <div className="field-label">{t('targets')}</div>
          <div className="field-value">{summary.targets.length ? summary.targets.map(targetLabel).join(' + ') : <span className="muted">{t('none')}</span>}</div>
        </div>
        <div>
          <div className="field-label">{t('failoverLabel')}</div>
          <div className="field-value">
            {summary.failoverAllowed === null ? <span className="muted">{t('none')}</span> : summary.failoverAllowed ? t('failoverOn') : t('failoverOff')}
            {summary.failoverWhy && <div className="small muted">{summary.failoverWhy}</div>}
          </div>
        </div>
      </div>

      {summary.reasons.length > 0 && (
        <div>
          <div className="field-label">{t('whyTitle')}</div>
          <ul className="reasons">
            {summary.reasons.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {needsApproval && <ApprovalCard view={view} source={source} onChanged={onChanged} />}

      {skeleton && <p className="small muted">{t('stubPolicy')}</p>}

      {!skeleton && pii?.ok && pii.value.pii && pii.value.pii.length > 0 && (
        <div>
          <div className="field-label">{t('piiTitle')}</div>
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
          <button type="button" className="btn btn-primary btn-small" onClick={() => setExplainOpen(true)}>
            {t('explainOpen')}
          </button>
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
        <div className="lang-switch" role="group" aria-label="language">
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
    <div className="approval">
      <div className="approval-head">
        <strong>{t('approvalTitle')}</strong>
        {awaiting ? <Pill tone="warning">{t('awaitingApproval')}</Pill> : d.approver ? <Pill tone="success">{t('approved')}</Pill> : <Pill tone="muted">{t('none')}</Pill>}
      </div>
      <div className="row">
        <Kv columns={2} items={[[t('approver'), d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">{t('none')}</span>], approval?.ok ? [t('approvedAt'), fmtTime(approval.value.approved_at)] : null]} />
        {awaiting && (
          <div className="approval-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
              {busy ? t('approving') : t('approve')}
            </button>
            <div className="small muted">{t('selfApprovalNote')}</div>
          </div>
        )}
      </div>
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
  const conditions = result.facts?.conditions;
  return (
    <div className="stack">
      <div className="row">
        <Pill tone={result.passed ? 'success' : 'danger'}>{step?.result}</Pill>
        {!conditions && (
          <span className="field-value">
            {result.match.matched} / {result.match.total} {t('requestsMatched')}
          </span>
        )}
      </div>
      {stub && <p className="small muted">{t('stubTest')}</p>}
      {conditions && conditions.length > 0 && (
        <div className="conditions">
          {conditions.map((c) => {
            const pct = c.total ? Math.round((c.matched / c.total) * 100) : 0;
            return (
              <div key={c.name} className="condition">
                <div className="condition-head">
                  <span>{conditionName(t, c.name)}</span>
                  <span className={c.failed ? 'tone-danger' : 'tone-success'}>
                    <strong>{c.matched}</strong>/{c.total}
                  </span>
                </div>
                <div className="bar" aria-hidden>
                  <span className={`bar-fill ${c.failed ? 'bar-danger' : 'bar-success'}`} style={{ width: `${pct}%` }} />
                </div>
                {c.mismatches.length > 0 && (
                  <Collapsible title={<span className="small">{t('mismatches')} {c.mismatches.length}</span>}>
                    <table className="table small">
                      <tbody>
                        {c.mismatches.map((m) => (
                          <tr key={m.index}>
                            <td className="mono">{m.request}</td>
                            <td className="small muted">{m.related_kind ? `${t('relatedFact')}: ${m.related_kind}` : t('unknownCause')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Collapsible>
                )}
              </div>
            );
          })}
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
  return (
    <div className="stack">
      <div className="row">
        <Pill tone={refused ? 'danger' : dryRun ? 'muted' : 'success'}>{step?.result}</Pill>
      </div>
      <p className="small">{refused ? t('signLineRefused') : dryRun ? t('signLineDry') : t('signLineOk')}</p>
      <Kv
        columns={3}
        items={[
          [t('signedBy'), <span className="mono">{sign?.approver ?? lastLog?.approver ?? t('none')}</span>],
          [t('signedAt'), fmtTime(sign?.signed_at ?? lastLog?.time)],
          sign ? [t('signedTargets'), sign.targets.map(targetLabel).join(' + ')] : null,
        ]}
      />
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
            [t('routeTarget'), targetLabel(r.kind)],
            [t('switchCount'), r.revision ?? t('none')],
            r.standby_target_id ? [targetLabel(r.kind === 'onprem' ? 'cloud_run' : 'onprem'), r.standby_enabled ? t('standbyReady') : t('standbyOff')] : null,
          ]}
        />
      )}
    </div>
  );
}

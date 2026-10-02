import { FlaskConical, PenLine, Rocket, Scale, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DataSource } from '../api/client';
import type { Approval, DeployResult, PiiReport, Plan, PlanRequire, SignLog, TestResult } from '../api/contracts';
import type { ApplicationView, Decision, DeploymentStatus, DeploymentView, StageExecution, StageName } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Collapsible, DemoBadge, Empty, Hash, IconTile, JsonBlock, Kv, MoreToggle, Notice, PageTitle, Pill, RawToggle, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { STAGE_ORDER, artifactsOf, findArtifact, latestStages, parseJsonArtifact } from '../lib/artifacts';
import { deriveDeployDisplay } from '../lib/deployState';
import { compactJson, fmtTime, relTime, targetLabel } from '../lib/format';
import { pickLang, useLang, type DictKey } from '../lib/i18n';
import { applicationPath, hrefFor } from '../lib/router';
import { summarizeDeployment, type DeploymentSummary, type ProofLink, type StepSummary } from '../lib/summary';

const PROGRESSING: DeploymentStatus[] = ['queued', 'running', 'awaiting_approval'];
const STATUS_KEY: Record<DeploymentStatus, DictKey> = {
  queued: 'statusQueued',
  running: 'statusRunning',
  awaiting_approval: 'statusAwaiting',
  blocked: 'statusBlocked',
  failed: 'statusFailed',
  succeeded: 'statusSucceeded',
};
const STATUS_TONE: Record<DeploymentStatus, Tone> = { queued: 'info', running: 'info', awaiting_approval: 'warning', blocked: 'danger', failed: 'danger', succeeded: 'success' };
const DECISION_TONE: Record<Decision, Tone> = { allow: 'success', needs_approval: 'warning', block: 'danger' };
const DECISION_LABEL: Record<Decision, string> = { allow: 'ALLOW', needs_approval: 'NEEDS_APPROVAL', block: 'BLOCK' };
const STEP_ICON: Record<StageName, LucideIcon> = { test: FlaskConical, policy: Scale, sign: PenLine, deploy: Rocket };
const STEP_DETAIL_KEY: Record<StageName, DictKey> = { test: 'testDetail', policy: 'policyDetail', sign: 'signDetail', deploy: 'deployDetail' };

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
  const [selected, setSelected] = useState<StageName | null>(null);
  const current: StageName = selected ?? summary?.focusStep ?? 'policy';

  if (poll.loading && !view) return <Empty>{t('loading')}</Empty>;
  if (!view || !summary) return <ErrorNotice error={poll.error ?? new Error('no data')} />;
  const d = view.deployment;

  return (
    <div className="page">
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <PageTitle
        title={
          <>
            <a className="crumb-link" href={hrefFor(applicationPath(d.applicationId))}>{app?.application.name ?? d.applicationId}</a> <span className="muted">v{d.version}</span>
          </>
        }
        sub={
          <span className={`conclusion conclusion-${summary.tone}`}>
            <span className="conclusion-dot" aria-hidden />
            {summary.conclusion}
          </span>
        }
        right={
          <div className="title-badges">
            {summary.decision && <Pill tone={DECISION_TONE[summary.decision]}>{DECISION_LABEL[summary.decision]}</Pill>}
            <Pill tone={STATUS_TONE[d.status]}>{t(STATUS_KEY[d.status])}</Pill>
            {progressing && (
              <span className="live">
                {t('refreshing2s')}
                {poll.lastUpdated ? `, ${relTime(new Date(poll.lastUpdated).toISOString())}` : ''}
              </span>
            )}
          </div>
        }
      />

      <div className="pipeline">
        <aside className="steps-col">
          {summary.steps.map((step) => (
            <StepCard key={step.name} step={step} selected={step.name === current} onSelect={() => setSelected(step.name)} />
          ))}
        </aside>
        <div className="detail-col">
          <section className="card detail-card">
            <h2 className="card-title">{t(STEP_DETAIL_KEY[current])}</h2>
            {current === 'test' && <TestDetail view={view} summary={summary} />}
            {current === 'policy' && <PolicyDetail view={view} summary={summary} source={source} onChanged={poll.refresh} />}
            {current === 'sign' && <SignDetail view={view} summary={summary} />}
            {current === 'deploy' && <DeployDetail view={view} summary={summary} />}
          </section>
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
      </div>

      <section className="card card-collapsed">
        <Collapsible title={t('identifiers')}>
          <Kv
            columns={3}
            items={[
              [t('runId'), <Hash value={d.id} length={24} />],
              [t('commit'), <Hash value={d.sourceRevision} length={7} />],
              [t('digest'), <Hash value={d.imageDigest} length={16} />],
              [t('trigger'), d.trigger === 'webhook' ? t('webhook') : t('manual')],
              [t('execMode'), <span className="mono">{d.executionMode}</span>],
              [t('requester'), <span className="mono">{d.requester}</span>],
              [t('approver'), d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">{t('none')}</span>],
              [t('createdAt'), fmtTime(d.createdAt)],
              [t('updatedAt'), fmtTime(d.updatedAt)],
            ]}
          />
        </Collapsible>
        <AuditSection view={view} />
        <ArtifactsSection view={view} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- left column

function StepCard({ step, selected, onSelect }: { step: StepSummary; selected: boolean; onSelect: () => void }) {
  const Icon = STEP_ICON[step.name];
  return (
    <button type="button" className={`card step-card ${selected ? 'step-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <IconTile icon={Icon} tone={step.tone === 'muted' ? 'accent' : step.tone} size={38} />
      <span className="step-text">
        <span className="step-name">{step.label}</span>
        <span className="step-meta">
          <strong className={`tone-${step.tone}`}>{step.result}</strong>
          {step.duration && <span className="muted"> {step.duration}</span>}
        </span>
      </span>
      <Pill tone={step.tone}>{step.result}</Pill>
    </button>
  );
}

// ---------------------------------------------------------------- proof chain

const PROOF_STATE: Record<ProofLink['state'], { tone: Tone; key: DictKey }> = {
  ok: { tone: 'success', key: 'proofOk' },
  mismatch: { tone: 'danger', key: 'proofMismatch' },
  pending: { tone: 'muted', key: 'proofPending' },
  unverified: { tone: 'muted', key: 'proofUnverified' },
};

function ProofRow({ link }: { link: ProofLink }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const state = PROOF_STATE[link.state];
  return (
    <li className="proof-row">
      <button type="button" className="proof-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`proof-mark proof-mark-${state.tone}`} aria-hidden>{state.tone === 'success' ? '✓' : state.tone === 'danger' ? '✕' : '–'}</span>
        <span className="proof-title">{link.title}</span>
        <Pill tone={state.tone}>{t(state.key)}</Pill>
      </button>
      {open && (
        <div className="proof-body">
          <p className="small muted">{link.detail}</p>
          <div className="proof-legs">
            {link.legs.map((leg) => (
              <span key={leg.label} className="proof-leg">
                <span className="muted">{leg.label}</span>{' '}
                {leg.value ? leg.value.length > 24 ? <Hash value={leg.value} length={10} /> : <span className="mono">{leg.value}</span> : <span className="muted">{t('none')}</span>}
              </span>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- policy

function PolicyDetail({ view, summary, source, onChanged }: { view: DeploymentView; summary: DeploymentSummary; source: DataSource; onChanged: () => void }) {
  const { t, lang } = useLang();
  const d = view.deployment;
  const skeleton = d.executionMode === 'skeleton';
  const latest = latestStages(view.stages);
  const stage = latest.policy;
  const plan = summary.parsed.plan;
  const pii = parseJsonArtifact<PiiReport>(findArtifact(view, 'pii', stage));
  const explain = findArtifact(view, lang === 'ja' ? 'explain.ja' : 'explain.ko', stage) ?? findArtifact(view, 'explain.ko', stage);
  const planHash = view.policyResult?.planHash ?? plan?.plan_hash ?? null;
  const decision = summary.decision;
  const needsApproval = d.decision === 'needs_approval' || d.status === 'awaiting_approval';

  if (!decision && !stage) return <Empty>{t('pending')}</Empty>;

  return (
    <div className="stack">
      <div className="decision-row">
        <div>
          <div className="field-label">{t('decision')}</div>
          <div className={`decision-big tone-${decision ? DECISION_TONE[decision] : 'muted'}`}>{decision ? DECISION_LABEL[decision] : t('none')}</div>
        </div>
        <div>
          <div className="field-label">{t('targets')}</div>
          <div className="field-value">{summary.targets.length ? summary.targets.map(targetLabel).join(' + ') : <span className="muted">{t('none')}</span>}</div>
        </div>
        <div>
          <div className="field-label">{t('failover')}</div>
          <div className="field-value">{summary.failoverAllowed === null ? <span className="muted">{t('none')}</span> : summary.failoverAllowed ? t('allow') : t('denied')}</div>
        </div>
      </div>

      {needsApproval && <ApprovalCard view={view} source={source} onChanged={onChanged} />}

      {summary.requires.length > 0 ? (
        <div>
          <div className="field-label">{t('requires')}</div>
          <div className="requires">
            {summary.requires.map((r) => (
              <RequireCard key={`${r.id}-${r.rule_id}`} require={r} />
            ))}
          </div>
        </div>
      ) : (
        decision === 'allow' && <p className="muted">{t('nothingToFix')}</p>
      )}

      <MoreToggle>
        <div className="stack">
          {skeleton && <p className="muted">{t('stubPolicy')}</p>}
          {!skeleton && plan && <RulesView plan={plan} />}
          {!skeleton && explain && (
            <div>
              <div className="field-label">{t('explain')}</div>
              <pre className="prose" lang={lang}>{explain.content}</pre>
            </div>
          )}
          {!skeleton && pii?.ok && (
            <div>
              <div className="field-label">
                {t('pii')} <span className="muted">{pii.value.pii?.length ?? 0}</span>
              </div>
              {pii.value.pii && pii.value.pii.length > 0 ? (
                <table className="table small">
                  <tbody>
                    {pii.value.pii.map((p, i) => (
                      <tr key={i}>
                        <td className="mono">
                          {p.table}.{p.column}
                        </td>
                        <td className="mono">{p.kind}</td>
                        <td>{p.confident ? <Pill tone="danger">confident</Pill> : <Pill tone="warning">review</Pill>}</td>
                        <td className="small muted">{p.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <span className="muted">{t('piiNone')}</span>
              )}
            </div>
          )}
          <div className="small muted">
            {t('planHash')} <Hash value={planHash} />
          </div>
          {stage && <StageRaw stage={stage} />}
        </div>
      </MoreToggle>
    </div>
  );
}

function RequireCard({ require: r }: { require: PlanRequire }) {
  const { t, lang } = useLang();
  const hint = pickLang(lang, r.hint, r.hint_i18n);
  return (
    <div className="require">
      <div className="require-hint">{hint ?? <span className="mono">{r.id}</span>}</div>
      <div className="require-meta">
        <span className="mono muted">{r.id}</span>
        <span className="mono muted">{r.rule_id}</span>
        {r.allowed_targets?.length ? (
          <span className="muted">
            {t('allowedAfterFix')}: {r.allowed_targets.map(targetLabel).join(', ')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RulesView({ plan }: { plan: Plan }) {
  const { t, lang } = useLang();
  const matched = plan.rules.filter((r) => r.result !== 'not_matched');
  const notMatched = plan.rules.filter((r) => r.result === 'not_matched');
  return (
    <div>
      <div className="field-label">{t('matchedRules')}</div>
      {matched.length === 0 && <div className="small muted">{t('none')}</div>}
      <ul className="rules">
        {matched.map((r) => (
          <li key={r.id} className="rule">
            <span className="mono muted rule-id">{r.id}</span>
            <span>
              {pickLang(lang, r.reason, r.reason_i18n) ?? <span className="muted">{t('none')}</span>}
              {r.result === 'matched_after_block' && <span className="small muted"> ({t('afterBlock')})</span>}
            </span>
          </li>
        ))}
      </ul>
      {notMatched.length > 0 && (
        <div className="small muted">
          {t('passedRules')} {notMatched.length}: <span className="mono">{notMatched.map((r) => r.id).join(', ')}</span>
        </div>
      )}
    </div>
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
        <strong>{t('humanApproval')}</strong>
        {awaiting ? <Pill tone="warning">{t('awaitingApproval')}</Pill> : d.approver ? <Pill tone="success">{t('approved')}</Pill> : <Pill tone="muted">{t('none')}</Pill>}
      </div>
      <div className="row">
        <Kv
          columns={2}
          items={[
            [t('requester'), <span className="mono">{d.requester}</span>],
            [t('approver'), d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">{t('none')}</span>],
            approval?.ok ? [t('approvedAt'), fmtTime(approval.value.approved_at)] : null,
          ]}
        />
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
  if (!stage) return <Empty>{t('notRun')}</Empty>;
  if (!result) {
    return (
      <div className="stack">
        {parsed && !parsed.ok ? (
          <>
            <Notice tone="warning">{parsed.error}</Notice>
            <JsonBlock raw={parsed.raw} />
          </>
        ) : (
          <Empty>{t('noTestResult')}</Empty>
        )}
        <StageRaw stage={stage} />
      </div>
    );
  }
  const conditions = result.facts?.conditions;
  const facts = result.facts ?? {};
  return (
    <div className="stack">
      <div className="row">
        <Pill tone={result.passed ? 'success' : 'danger'}>{result.passed ? t('testPassed') : t('testFailed')}</Pill>
        <span className="field-value">
          <strong>{result.match.matched}</strong> / {result.match.total} {t('requestsMatched')}
          {conditions ? <span className="muted"> ({t('baselineNone')})</span> : null}
        </span>
      </div>
      {conditions && conditions.length > 0 && (
        <div className="conditions">
          {conditions.map((c) => {
            const pct = c.total ? Math.round((c.matched / c.total) * 100) : 0;
            return (
              <div key={c.name} className="condition">
                <div className="condition-head">
                  <span className="mono">{c.name}</span>
                  <span>
                    <strong>{c.matched}</strong>/{c.total}
                  </span>
                </div>
                <div className="bar" aria-hidden>
                  <span className={`bar-fill ${c.failed ? 'bar-danger' : 'bar-success'}`} style={{ width: `${pct}%` }} />
                </div>
                {c.mismatches.length > 0 && (
                  <Collapsible title={<span className="small">{t('mismatches')} {c.mismatches.length}</span>}>
                    <table className="table small">
                      <thead>
                        <tr>
                          <th>{t('mismatchIndex')}</th>
                          <th>{t('request')}</th>
                          <th>{t('relatedFact')}</th>
                          <th>{t('kind')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.mismatches.map((m) => (
                          <tr key={m.index}>
                            <td className="mono">{m.index}</td>
                            <td className="mono">{m.request}</td>
                            <td className="mono">{m.related_fact ?? <span className="muted">{t('none')}</span>}</td>
                            <td className="mono">{m.related_kind ?? <span className="muted">{t('unknownCause')}</span>}</td>
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
      <MoreToggle>
        <div className="stack">
          {stub && <p className="muted">{t('stubTest')}</p>}
          {result.failures && result.failures.length > 0 && (
            <div>
              <div className="field-label">failures {result.failures.length}</div>
              <ul className="plain mono small">
                {result.failures.map((f, i) => (
                  <li key={i}>{compactJson(f)}</li>
                ))}
              </ul>
            </div>
          )}
          <Kv
            columns={3}
            items={[
              [t('db'), <span className="mono">{facts.db ?? t('none')}</span>],
              [t('localFiles'), facts.writes_local_file?.length ? <span className="mono">{facts.writes_local_file.join(', ')}</span> : <span className="muted">{t('none')}</span>],
              facts.migration ? [t('migration'), facts.migration.destructive ? <Pill tone="danger">{t('destructive')}</Pill> : <Pill tone="success">{t('safe')}</Pill>] : null,
            ]}
          />
          <StageRaw stage={stage} />
        </div>
      </MoreToggle>
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
  if (!stage) return <Empty>{t('notRun')}</Empty>;
  if (!sign && !lastLog) {
    return (
      <div className="stack">
        {stage.error ? <Notice tone="danger">{stage.error}</Notice> : <Empty>{t('noSign')}</Empty>}
        <StageRaw stage={stage} />
      </div>
    );
  }
  const dryRun = sign?.signature_ref.startsWith('dry-run:') ?? false;
  const refused = lastLog?.result === 'refused';
  return (
    <div className="stack">
      <div className="decision-row">
        <div>
          <div className="field-label">{t('result')}</div>
          <div className={`decision-big tone-${refused ? 'danger' : dryRun ? 'muted' : 'success'}`}>{refused ? t('signatureRefused') : dryRun ? t('dryRun') : t('signed')}</div>
          {refused && lastLog?.reason && <span className="mono small muted">{lastLog.reason}</span>}
        </div>
        <div>
          <div className="field-label">{t('approver')}</div>
          <div className="field-value mono">{sign?.approver ?? lastLog?.approver ?? t('none')}</div>
        </div>
        <div>
          <div className="field-label">{t('signedAt')}</div>
          <div className="field-value">{fmtTime(sign?.signed_at ?? lastLog?.time)}</div>
        </div>
      </div>
      {sign && (
        <MoreToggle>
          <div className="stack">
            <Kv
              columns={2}
              items={[
                ['signature_ref', <Hash value={sign.signature_ref} length={36} />],
                [t('requester'), <span className="mono">{sign.requester}</span>],
                [t('signedTargets'), sign.targets.map(targetLabel).join(' + ')],
                [t('failover'), sign.failover_allowed ? t('allow') : t('denied')],
                ['plan_hash', <Hash value={sign.plan_hash} />],
                ['digest', <Hash value={sign.digest} />],
              ]}
            />
            <StageRaw stage={stage} />
          </div>
        </MoreToggle>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- deploy

function DeployDetail({ view, summary }: { view: DeploymentView; summary: DeploymentSummary }) {
  const { t, lang } = useLang();
  const stage = latestStages(view.stages).deploy;
  const result = summary.parsed.deployResult;
  const display = deriveDeployDisplay(stage, result);
  const r = result?.routing;
  return (
    <div className="stack">
      <Notice tone={display.tone} title={lang === 'ko' ? display.title : summary.conclusion}>
        {lang === 'ko' && display.details.length > 0 && (
          <ul className="plain">
            {display.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Notice>
      {result && (
        <div className="decision-row">
          <div>
            <div className="field-label">decision</div>
            <div className="field-value">
              <Pill tone={result.decision === 'activated' ? 'success' : result.decision === 'error' ? 'danger' : 'warning'}>{result.decision}</Pill>
            </div>
          </div>
          <div>
            <div className="field-label">{t('routing')}</div>
            <div className="field-value">
              <Pill tone={r?.result === 'ok' ? 'success' : r?.result === 'error' ? 'danger' : 'muted'}>{r?.result ?? t('none')}</Pill>
              {r?.kind && (
                <span>
                  {' '}
                  {targetLabel(r.kind)}
                  {r.revision !== undefined ? `, rev ${r.revision}` : ''}
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="field-label">{t('standby')}</div>
            <div className="field-value">{r?.standby_target_id ? (r.standby_enabled ? t('active') : t('inactive')) : <span className="muted">{t('none')}</span>}</div>
          </div>
        </div>
      )}
      {result && (
        <MoreToggle>
          <DeployResultView result={result} />
          {stage && <StageRaw stage={stage} />}
        </MoreToggle>
      )}
      {!result && stage && <StageRaw stage={stage} />}
    </div>
  );
}

function DeployResultView({ result }: { result: DeployResult }) {
  const { t } = useLang();
  const r = result.routing;
  return (
    <div className="stack">
      <Kv
        columns={3}
        items={[
          [t('image'), result.image ? <Hash value={result.image} length={28} /> : <span className="muted">{t('none')}</span>],
          [t('plannedTargets'), result.targets_planned.map(targetLabel).join(' + ')],
          [t('signatureCheck'), result.signature ? `${t('verified')}${result.signature.tlog ? `, tlog ${result.signature.tlog}` : ''}` : <Pill tone="danger">{t('unverified')}</Pill>],
          [t('startedAt'), fmtTime(result.started_at)],
          [t('finishedAt'), fmtTime(result.finished_at)],
          r.error ? [t('error'), <span className="mono small">{r.error}</span>] : null,
        ]}
      />
      <div>
        <div className="field-label">{t('stepResults')}</div>
        <table className="table small">
          <thead>
            <tr>
              <th>{t('target')}</th>
              <th>{t('phase')}</th>
              <th>{t('result')}</th>
              <th>{t('detail')}</th>
            </tr>
          </thead>
          <tbody>
            {result.targets.map((step, i) => (
              <tr key={i}>
                <td>{targetLabel(step.target)}</td>
                <td className="mono">{step.phase}</td>
                <td>
                  <Pill tone={step.result === 'ok' ? 'success' : step.result === 'error' ? 'danger' : 'muted'}>{step.result}</Pill>
                </td>
                <td className="small step-detail">
                  {step.revision && <Hash value={step.revision} length={24} />}
                  {step.container && <Hash value={step.container} length={24} />}
                  {step.serving && <Hash value={step.serving} length={20} />}
                  {step.previous && <span className="muted">prev <Hash value={step.previous} length={20} /></span>}
                  {step.candidate_url && <Hash value={step.candidate_url} length={30} />}
                  {step.reason && <span>{step.reason}</span>}
                  {step.error && <span className="tone-danger">{step.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.checks.length > 0 && (
        <div>
          <div className="field-label">{t('candidateChecks')}</div>
          <table className="table small">
            <tbody>
              {result.checks.map((c, i) => (
                <tr key={i}>
                  <td>{targetLabel(c.target)}</td>
                  <td>
                    <Pill tone={c.pass ? 'success' : 'danger'}>{c.pass ? t('pass') : t('fail')}</Pill>
                  </td>
                  <td className="mono">{c.checker}</td>
                  <td>{c.url ? <Hash value={c.url} length={30} /> : <span className="muted">{t('none')}</span>}</td>
                  <td className="mono small">{compactJson(c.checks)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function StageRaw({ stage }: { stage: StageExecution }) {
  const { t } = useLang();
  if (stage.summary === null || stage.summary === undefined) return null;
  return (
    <RawToggle label={t('stageSummary')}>
      <pre className="code">{compactJson(stage.summary)}</pre>
    </RawToggle>
  );
}

function AuditSection({ view }: { view: DeploymentView }) {
  const { t } = useLang();
  return (
    <Collapsible title={t('auditLog')} summary={<span className="muted small">{view.auditLogs.length}</span>}>
      {view.auditLogs.length === 0 ? (
        <Empty>{t('none')}</Empty>
      ) : (
        <table className="table small">
          <thead>
            <tr>
              <th>{t('kind')}</th>
              <th>{t('time')}</th>
              <th>{t('content')}</th>
              <th>plan_hash</th>
            </tr>
          </thead>
          <tbody>
            {view.auditLogs.map((log) => {
              const p = log.payload as Record<string, unknown>;
              const str = (key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);
              const list = (key: string): string[] | null => (Array.isArray(p[key]) ? (p[key] as unknown[]).map(String) : null);
              const decision = str('decision');
              return (
                <tr key={log.id}>
                  <td className="mono">{log.kind}</td>
                  <td>{fmtTime(str('time') ?? log.createdAt)}</td>
                  <td>
                    {log.kind === 'sign' ? (
                      <span>
                        <Pill tone={str('result') === 'signed' ? 'success' : 'danger'}>{str('result') ?? t('none')}</Pill>
                        {str('reason') && <span className="mono small"> {str('reason')}</span>}
                        <span className="small muted">
                          {' '}
                          {t('approver')} {str('approver') ?? t('none')}
                        </span>
                      </span>
                    ) : (
                      <span>
                        {decision && decision in DECISION_TONE ? <Pill tone={DECISION_TONE[decision as Decision]}>{decision}</Pill> : <span className="mono">{decision ?? t('none')}</span>}
                        {list('rule_ids') && (
                          <span className="small muted">
                            {' '}
                            {t('rules')} {list('rule_ids')!.join(', ')}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td>
                    <Hash value={str('plan_hash')} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Collapsible>
  );
}

function ArtifactsSection({ view }: { view: DeploymentView }) {
  const { t } = useLang();
  const latest = useMemo(() => latestStages(view.stages), [view.stages]);
  const grouped = STAGE_ORDER.map((name) => ({ name, items: artifactsOf(view, latest[name]) })).filter((g) => g.items.length > 0);
  return (
    <Collapsible title={t('artifacts')} summary={<span className="muted small">{view.artifacts.length}</span>}>
      {view.artifacts.length === 0 && <Empty>{t('none')}</Empty>}
      {grouped.map((g) => (
        <div key={g.name} className="artifact-group">
          <div className="field-label">{t(STEP_DETAIL_KEY[g.name])}</div>
          {g.items.map((a) => {
            const parsed = parseJsonArtifact(a);
            return (
              <Collapsible
                key={a.id}
                title={<span className="mono">{a.name}</span>}
                summary={
                  <>
                    <span className="mono small muted">{a.relativePath}</span>
                    {a.validationError && <Pill tone="danger">{a.validationError}</Pill>}
                  </>
                }
              >
                {parsed?.ok ? <JsonBlock value={parsed.value} /> : <pre className={a.mediaType === 'text/plain' ? 'prose' : 'code'}>{a.content}</pre>}
                <div className="small muted">
                  sha256 <Hash value={a.contentHash} /> {fmtTime(a.createdAt)}
                </div>
              </Collapsible>
            );
          })}
        </div>
      ))}
    </Collapsible>
  );
}

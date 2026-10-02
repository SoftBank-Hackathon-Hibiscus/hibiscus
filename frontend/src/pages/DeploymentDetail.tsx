import { FlaskConical, PenLine, Rocket, Scale, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DataSource } from '../api/client';
import type { Approval, PiiReport, Plan, SignLog, TestResult } from '../api/contracts';
import type { ApplicationView, Decision, DeploymentStatus, DeploymentView, StageExecution, StageName } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Modal } from '../components/Modal';
import { Collapsible, DemoBadge, Empty, Hash, IconTile, JsonBlock, Kv, MoreToggle, PageTitle, Pill, RawToggle, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { STAGE_ORDER, artifactsOf, findArtifact, latestStages, parseJsonArtifact } from '../lib/artifacts';
import { compactJson, fmtTime, relTime, targetLabel } from '../lib/format';
import { pickLang, useLang, type DictKey } from '../lib/i18n';
import { Markdown, prepareExplain } from '../lib/markdown';
import { applicationPath, hrefFor } from '../lib/router';
import { summarizeDeployment, type DeploymentSummary, type ProofLink, type StepSummary } from '../lib/summary';

const PROGRESSING: DeploymentStatus[] = ['queued', 'running', 'awaiting_approval'];
const STATUS_KEY: Record<DeploymentStatus, DictKey> = { queued: 'statusQueued', running: 'statusRunning', awaiting_approval: 'statusAwaiting', blocked: 'statusBlocked', failed: 'statusFailed', succeeded: 'statusSucceeded' };
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
          <section className={`card detail-card tint-${summary.steps.find((s) => s.name === current)?.tone ?? 'muted'}`}>
            <h2 className="card-title">{t(STEP_DETAIL_KEY[current])}</h2>
            {current === 'test' && <TestDetail view={view} summary={summary} />}
            {current === 'policy' && <PolicyDetail view={view} summary={summary} source={source} onChanged={poll.refresh} appName={appName} />}
            {current === 'sign' && <SignDetail view={view} summary={summary} />}
            {current === 'deploy' && <DeployDetail view={view} summary={summary} />}
          </section>
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">{t('proofChain')}</h2>
              {source.kind === 'mock' && <DemoBadge small />}
            </div>
            <ul className="proof-list frost">
              {summary.proof.map((link) => (
                <ProofRow key={link.id} link={link} />
              ))}
            </ul>
          </section>
        </div>
      </div>

      <section className="card card-collapsed">
        <Collapsible title={t('techDetails')}>
          <div className="stack">
            <div>
              <div className="field-label">{t('identifiers')}</div>
              <Kv
                columns={3}
                items={[
                  [t('runId'), <Hash value={d.id} length={24} />],
                  [t('commit'), <Hash value={d.sourceRevision} length={12} />],
                  [t('digest'), <Hash value={d.imageDigest} length={20} />],
                  [t('trigger'), d.trigger === 'webhook' ? t('webhook') : t('manual')],
                  [t('execMode'), <span className="mono">{d.executionMode}</span>],
                  [t('requester'), <span className="mono">{d.requester}</span>],
                  [t('approver'), d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">{t('none')}</span>],
                  [t('createdAt'), fmtTime(d.createdAt)],
                  [t('updatedAt'), fmtTime(d.updatedAt)],
                ]}
              />
            </div>
            <PolicyTech view={view} summary={summary} />
            <AuditSection view={view} />
            <ArtifactsSection view={view} />
          </div>
        </Collapsible>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- left column

function StepCard({ step, selected, onSelect }: { step: StepSummary; selected: boolean; onSelect: () => void }) {
  const Icon = STEP_ICON[step.name];
  return (
    <button type="button" className={`card step-card tint-${step.tone} ${selected ? 'step-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <IconTile icon={Icon} tone={step.tone === 'muted' ? 'accent' : step.tone} size={40} />
      <span className="step-text">
        <span className="step-name">{step.label}</span>
        <span className={`step-result tone-${step.tone}`}>{step.result}</span>
        {step.duration && <span className="step-duration">{step.duration}</span>}
      </span>
    </button>
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
  const [open, setOpen] = useState(false);
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
      <button type="button" className="link-btn proof-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? t('hideDetails') : t('techDetails')}
      </button>
      {open && (
        <div className="proof-legs">
          {link.legs.map((leg) => (
            <span key={leg.label} className="proof-leg">
              <span className="muted">{leg.label}</span> {leg.value ? leg.value.length > 24 ? <Hash value={leg.value} length={12} /> : <span className="mono">{leg.value}</span> : <span className="muted">{t('none')}</span>}
            </span>
          ))}
        </div>
      )}
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
          <div className={`decision-big tone-${decision ? DECISION_TONE[decision] : 'muted'}`}>{decision ? DECISION_LABEL[decision] : t('none')}</div>
        </div>
        <div>
          <div className="field-label">{t('targets')}</div>
          <div className="field-value">{summary.targets.length ? summary.targets.map(targetLabel).join(' + ') : <span className="muted">{t('none')}</span>}</div>
        </div>
        <div>
          <div className="field-label">{t('failoverLabel')}</div>
          <div className="field-value">
            {summary.failoverAllowed === null ? <span className="muted">{t('none')}</span> : summary.failoverAllowed ? t('failoverOn') : t('failoverOff')}
            {summary.failoverWhy && <span className="small muted"> ({summary.failoverWhy})</span>}
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

      {summary.requires.length > 0 ? (
        <div>
          <div className="field-label">{t('requires')}</div>
          <div className="requires frost">
            {summary.requires.map((r) => (
              <div key={`${r.id}-${r.ruleId}`} className="require">
                <div className="require-title">{r.title}</div>
                {r.why && <div className="require-why">{r.why}</div>}
                <div className="require-unlock">
                  {r.unlocks.length ? `${t('fixUnlocks')}: ${r.unlocks.map(targetLabel).join(', ')}` : t('fixUnlocksNone')}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        decision === 'allow' && <p className="muted">{t('nothingToFix')}</p>
      )}

      {skeleton && <p className="muted">{t('stubPolicy')}</p>}

      {!skeleton && pii?.ok && pii.value.pii && pii.value.pii.length > 0 && (
        <div>
          <div className="field-label">{t('piiTitle')}</div>
          <table className="table small frost">
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

      <div className="row">
        {!skeleton && explain && (
          <button type="button" className="btn btn-primary btn-small" onClick={() => setExplainOpen(true)}>
            {t('explainOpen')}
          </button>
        )}
        <MoreToggle>
          <div className="stack">
            {summary.requires.length > 0 && (
              <Kv columns={1} items={summary.requires.map((r) => [r.title, <span className="mono small">{r.id} ({r.ruleId})</span>])} />
            )}
            {stage && <StageRaw stage={stage} />}
          </div>
        </MoreToggle>
      </div>

      {explainOpen && explain && (
        <ExplainModal source={explain.content} title={`${appName} v${d.version}`} onClose={() => setExplainOpen(false)} lang={lang} setLang={setLang} hasKo={Boolean(explainKo)} hasJa={Boolean(explainJa)} />
      )}
    </div>
  );
}

function ExplainModal({ source, title, onClose, lang, setLang, hasKo, hasJa }: { source: string; title: string; onClose: () => void; lang: 'ko' | 'ja'; setLang: (l: 'ko' | 'ja') => void; hasKo: boolean; hasJa: boolean }) {
  const { t } = useLang();
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
      <div lang={lang} className="frost explain-body">
        <Markdown source={prepared.body} />
        {prepared.technical && (
          <RawToggle label={t('techDetails')}>
            <Markdown source={prepared.technical} />
          </RawToggle>
        )}
      </div>
    </Modal>
  );
}

function PolicyTech({ view, summary }: { view: DeploymentView; summary: DeploymentSummary }) {
  const { t, lang } = useLang();
  const plan = summary.parsed.plan;
  const planHash = view.policyResult?.planHash ?? plan?.plan_hash ?? null;
  return (
    <div>
      <div className="field-label">{t('policyTech')}</div>
      <Kv columns={1} items={[['plan_hash', <Hash value={planHash} length={20} />]]} />
      {plan && <RulesView plan={plan} lang={lang} />}
    </div>
  );
}

function RulesView({ plan, lang }: { plan: Plan; lang: 'ko' | 'ja' }) {
  const { t } = useLang();
  const matched = plan.rules.filter((r) => r.result !== 'not_matched');
  const notMatched = plan.rules.filter((r) => r.result === 'not_matched');
  return (
    <div className="stack-sm">
      <ul className="rules">
        {matched.map((r) => (
          <li key={r.id} className="rule">
            <span className="mono muted rule-id">{r.id}</span>
            <span>
              {pickLang(lang, r.reason, r.reason_i18n) ?? <span className="muted">{t('none')}</span>}
              {r.result === 'matched_after_block' && <span className="small muted"> (matched_after_block)</span>}
            </span>
          </li>
        ))}
      </ul>
      {notMatched.length > 0 && (
        <div className="small muted">
          not_matched: <span className="mono">{notMatched.map((r) => r.id).join(', ')}</span>
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
    <div className="approval frost">
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
    return (
      <div className="stack">
        <Empty>{t('noTestResult')}</Empty>
        {parsed && !parsed.ok && (
          <MoreToggle>
            <JsonBlock raw={parsed.raw} />
          </MoreToggle>
        )}
        {stage && <StageRaw stage={stage} />}
      </div>
    );
  }
  const conditions = result.facts?.conditions;
  const conditionName = (name: string) => (name === 'none' ? t('conditionNone') : name === 'restart' ? t('conditionRestart') : name === 'replace' ? t('conditionReplace') : name);
  const testReasons = summary.reasons.filter((r) => !r.startsWith('SQLite') && true);
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
      {stub && <p className="muted">{t('stubTest')}</p>}
      {conditions && conditions.length > 0 && (
        <div className="conditions">
          {conditions.map((c) => {
            const pct = c.total ? Math.round((c.matched / c.total) * 100) : 0;
            return (
              <div key={c.name} className="condition frost">
                <div className="condition-head">
                  <span>{conditionName(c.name)}</span>
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
      {testReasons.length > 0 && (
        <ul className="reasons">
          {summary.reasons.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <MoreToggle>
        <div className="stack">
          <Kv
            columns={3}
            items={[
              ['db', <span className="mono">{result.facts?.db ?? '-'}</span>],
              ['writes_local_file', result.facts?.writes_local_file?.length ? <span className="mono">{result.facts.writes_local_file.join(', ')}</span> : <span className="muted">-</span>],
              result.facts?.migration ? ['migration.destructive', <span className="mono">{String(result.facts.migration.destructive)}</span>] : null,
              ['match', <span className="mono">{result.match.matched}/{result.match.total}</span>],
              ['run_id', <Hash value={result.run_id} length={20} />],
              ['digest', <Hash value={result.digest} length={16} />],
            ]}
          />
          {result.failures && result.failures.length > 0 && (
            <ul className="plain mono small">
              {result.failures.map((f, i) => (
                <li key={i}>{compactJson(f)}</li>
              ))}
            </ul>
          )}
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
  const step = summary.steps.find((s) => s.name === 'sign');
  if (!stage) return <Empty>{step?.result ?? t('resultPending')}</Empty>;
  if (!sign && !lastLog) {
    return (
      <div className="stack">
        <Empty>{t('noSign')}</Empty>
        <StageRaw stage={stage} />
      </div>
    );
  }
  const dryRun = sign?.signature_ref.startsWith('dry-run:') ?? false;
  const refused = lastLog?.result === 'refused';
  return (
    <div className="stack">
      <div className="row">
        <Pill tone={refused ? 'danger' : dryRun ? 'muted' : 'success'}>{step?.result}</Pill>
      </div>
      <p>{refused ? t('signLineRefused') : dryRun ? t('signLineDry') : t('signLineOk')}</p>
      <Kv
        columns={3}
        items={[
          [t('signedBy'), <span className="mono">{sign?.approver ?? lastLog?.approver ?? t('none')}</span>],
          [t('signedAt'), fmtTime(sign?.signed_at ?? lastLog?.time)],
          sign ? [t('signedTargets'), sign.targets.map(targetLabel).join(' + ')] : null,
        ]}
      />
      {sign && (
        <MoreToggle>
          <div className="stack">
            <Kv
              columns={2}
              items={[
                ['signature_ref', <Hash value={sign.signature_ref} length={40} />],
                ['plan_hash', <Hash value={sign.plan_hash} length={20} />],
                ['digest', <Hash value={sign.digest} length={20} />],
                ['requester', <span className="mono">{sign.requester}</span>],
                ['failover_allowed', <span className="mono">{String(sign.failover_allowed)}</span>],
                refused && lastLog?.reason ? ['reason', <span className="mono">{lastLog.reason}</span>] : null,
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
  const { t } = useLang();
  const stage = latestStages(view.stages).deploy;
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
      {(result || stage) && (
        <MoreToggle>
          <div className="stack">
            {result && (
              <Kv
                columns={3}
                items={[
                  ['decision', <span className="mono">{result.decision}</span>],
                  ['routing.result', <span className="mono">{result.routing.result}</span>],
                  ['image', result.image ? <Hash value={result.image} length={28} /> : <span className="muted">-</span>],
                  ['signature', result.signature ? <span className="mono">verified{result.signature.tlog ? `, tlog ${result.signature.tlog}` : ''}</span> : <span className="mono">none</span>],
                  ['started_at', fmtTime(result.started_at)],
                  ['finished_at', fmtTime(result.finished_at)],
                  r?.target_id ? ['routing.target_id', <Hash value={r.target_id} length={20} />] : null,
                  r?.error ? ['routing.error', <span className="mono small">{r.error}</span>] : null,
                ]}
              />
            )}
            {result && (
              <table className="table small">
                <thead>
                  <tr>
                    <th>target</th>
                    <th>phase</th>
                    <th>result</th>
                    <th>detail</th>
                  </tr>
                </thead>
                <tbody>
                  {result.targets.map((s, i) => (
                    <tr key={i}>
                      <td className="mono">{s.target}</td>
                      <td className="mono">{s.phase}</td>
                      <td className="mono">{s.result}</td>
                      <td className="small step-detail">
                        {s.revision && <Hash value={s.revision} length={24} />}
                        {s.container && <Hash value={s.container} length={24} />}
                        {s.serving && <Hash value={s.serving} length={20} />}
                        {s.previous && <span className="muted">prev <Hash value={s.previous} length={20} /></span>}
                        {s.candidate_url && <Hash value={s.candidate_url} length={30} />}
                        {s.reason && <span>{s.reason}</span>}
                        {s.error && <span className="tone-danger">{s.error}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {result && result.checks.length > 0 && (
              <table className="table small">
                <tbody>
                  {result.checks.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.target}</td>
                      <td className="mono">{c.pass ? 'pass' : 'fail'}</td>
                      <td className="mono">{c.checker}</td>
                      <td>{c.url ? <Hash value={c.url} length={30} /> : <span className="muted">-</span>}</td>
                      <td className="mono small">{compactJson(c.checks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {stage?.error && <div className="mono small">{stage.error}</div>}
            {stage && <StageRaw stage={stage} />}
          </div>
        </MoreToggle>
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
    <div>
      <div className="field-label">
        {t('auditLog')} <span className="muted">{view.auditLogs.length}</span>
      </div>
      {view.auditLogs.length === 0 ? (
        <Empty>{t('none')}</Empty>
      ) : (
        <table className="table small">
          <thead>
            <tr>
              <th>kind</th>
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
              return (
                <tr key={log.id}>
                  <td className="mono">{log.kind}</td>
                  <td>{fmtTime(str('time') ?? log.createdAt)}</td>
                  <td className="mono small">
                    {log.kind === 'sign' ? `${str('result') ?? '-'}${str('reason') ? ` (${str('reason')})` : ''}, approver ${str('approver') ?? '-'}` : `${str('decision') ?? '-'}${list('rule_ids') ? ` [${list('rule_ids')!.join(', ')}]` : ''}`}
                  </td>
                  <td>
                    <Hash value={str('plan_hash')} length={16} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ArtifactsSection({ view }: { view: DeploymentView }) {
  const { t } = useLang();
  const latest = useMemo(() => latestStages(view.stages), [view.stages]);
  const grouped = STAGE_ORDER.map((name) => ({ name, items: artifactsOf(view, latest[name]) })).filter((g) => g.items.length > 0);
  return (
    <div>
      <div className="field-label">
        {t('artifacts')} <span className="muted">{view.artifacts.length}</span>
      </div>
      {view.artifacts.length === 0 && <Empty>{t('none')}</Empty>}
      {grouped.map((g) => (
        <div key={g.name} className="artifact-group">
          <div className="small muted">{t(STEP_DETAIL_KEY[g.name])}</div>
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
                  sha256 <Hash value={a.contentHash} length={16} /> {fmtTime(a.createdAt)}
                </div>
              </Collapsible>
            );
          })}
        </div>
      ))}
    </div>
  );
}

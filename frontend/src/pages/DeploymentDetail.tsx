import { useEffect, useMemo, useState } from 'react';
import type { DataSource } from '../api/client';
import type { Approval, DeployResult, PiiReport, Plan, PlanRequire, SignLog, SignResult, TestResult } from '../api/contracts';
import type { ApplicationView, Decision, DeploymentStatus, DeploymentView, StageExecution, StageName, StageStatus } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { Badge, Bilingual, Collapsible, Empty, Hash, JsonBlock, Kv, Notice, type Tone } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { STAGE_ORDER, artifactsOf, findArtifact, latestStages, parseJsonArtifact } from '../lib/artifacts';
import { deriveDeployDisplay } from '../lib/deployState';
import { compactJson, durationBetween, fmtTime, relTime, targetLabel } from '../lib/format';
import { applicationPath, hrefFor } from '../lib/router';

const PROGRESSING: DeploymentStatus[] = ['queued', 'running', 'awaiting_approval'];

const STATUS_TONE: Record<DeploymentStatus, Tone> = {
  queued: 'info',
  running: 'info',
  awaiting_approval: 'warning',
  blocked: 'danger',
  failed: 'danger',
  succeeded: 'success',
};
const STATUS_LABEL: Record<DeploymentStatus, string> = {
  queued: '대기 중',
  running: '진행 중',
  awaiting_approval: '승인 대기',
  blocked: '정책 차단',
  failed: '실패',
  succeeded: '완료',
};
const STAGE_TONE: Record<StageStatus, Tone> = {
  pending: 'muted',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'muted',
};
const STAGE_LABEL: Record<StageStatus, string> = {
  pending: '대기',
  running: '진행 중',
  succeeded: '성공',
  failed: '실패',
  skipped: '생략',
};
const STAGE_TITLE: Record<StageName, string> = {
  test: 'Test · parity 재생',
  policy: 'Policy · 정책 결정',
  sign: 'Sign · 승인·서명',
  deploy: 'Deploy · 배포',
};
const DECISION_TONE: Record<Decision, Tone> = { allow: 'success', needs_approval: 'warning', block: 'danger' };
const DECISION_LABEL: Record<Decision, string> = { allow: 'ALLOW', needs_approval: 'NEEDS_APPROVAL', block: 'BLOCK' };

export function DeploymentDetail({ id, source }: { id: string; source: DataSource }) {
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

  if (poll.loading && !view) return <Empty>배포 정보를 불러오는 중…</Empty>;
  if (!view) return <ErrorNotice error={poll.error ?? new Error('데이터 없음')} />;

  return (
    <div className="page">
      {poll.error ? <ErrorNotice error={poll.error} /> : null}
      <Header view={view} app={app} progressing={progressing} lastUpdated={poll.lastUpdated} />
      <Identity view={view} />
      <Timeline view={view} source={source} onChanged={poll.refresh} />
      <AuditSection view={view} />
      <ArtifactsSection view={view} />
    </div>
  );
}

// ---------------------------------------------------------------- header / identity

function Header({ view, app, progressing, lastUpdated }: { view: DeploymentView; app: ApplicationView | null; progressing: boolean; lastUpdated: number | null }) {
  const d = view.deployment;
  return (
    <header className="page-header">
      <div className="crumbs">
        {app ? (
          <a href={hrefFor(applicationPath(d.applicationId))}>{app.application.name}</a>
        ) : (
          <a href={hrefFor(applicationPath(d.applicationId))} className="mono">{d.applicationId}</a>
        )}
        <span className="crumb-sep">/</span>
        <span>배포 v{d.version}</span>
      </div>
      <div className="title-row">
        <h1>
          {app?.application.name ?? '앱'} <span className="muted">v{d.version}</span>
        </h1>
        <div className="title-badges">
          <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
          {d.decision && <Badge tone={DECISION_TONE[d.decision]}>{DECISION_LABEL[d.decision]}</Badge>}
          {d.deploymentPerformed ? <Badge tone="success">배포됨</Badge> : <Badge tone="muted">배포 안 됨</Badge>}
          {d.sourceRevisionVerified ? (
            <Badge tone="success" title="registry parity 검증이 끝나 테스트한 이미지가 이 커밋과 연결됨. 정책이 block 이어도 true 일 수 있음">테스트한 이미지 = 이 커밋</Badge>
          ) : (
            <Badge tone="muted" title="아직 registry parity 검증 전. manual·webhook 모두 false 로 시작">이미지·커밋 연결 미검증</Badge>
          )}
          {progressing && <span className="live">2초마다 갱신{lastUpdated ? ` · ${relTime(new Date(lastUpdated).toISOString())}` : ''}</span>}
        </div>
      </div>
      {d.error && (
        <Notice tone="danger" title="배포 오류">
          <span className="mono small">{d.error}</span>
        </Notice>
      )}
    </header>
  );
}

function Identity({ view }: { view: DeploymentView }) {
  const d = view.deployment;
  return (
    <section className="card">
      <Kv
        columns={3}
        items={[
          ['run_id', <Hash value={d.id} length={18} />],
          ['커밋', <Hash value={d.sourceRevision} length={7} />],
          ['이미지 digest', <Hash value={d.imageDigest} />],
          ['digest 출처', <span className="mono">{d.digestSource}</span>],
          ['트리거', <span className="mono">{d.trigger}</span>],
          ['실행 모드', <span className="mono">{d.executionMode}</span>],
          ['요청자', <span className="mono">{d.requester}</span>],
          ['승인자', d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">—</span>],
          ['현재 단계', <span className="mono">{d.currentStage ?? '—'}</span>],
          ['생성', fmtTime(d.createdAt)],
          ['갱신', `${fmtTime(d.updatedAt)} (${relTime(d.updatedAt)})`],
        ]}
      />
    </section>
  );
}

// ---------------------------------------------------------------- timeline

function Timeline({ view, source, onChanged }: { view: DeploymentView; source: DataSource; onChanged: () => void }) {
  const latest = useMemo(() => latestStages(view.stages), [view.stages]);
  const d = view.deployment;
  const needsApproval = d.decision === 'needs_approval' || d.status === 'awaiting_approval';
  return (
    <section className="timeline">
      {STAGE_ORDER.map((name) => (
        <div key={name} className="timeline-item">
          <StageCard name={name} stage={latest[name]} view={view} />
          {name === 'policy' && needsApproval && <ApprovalCard view={view} source={source} onChanged={onChanged} />}
        </div>
      ))}
    </section>
  );
}

function StageCard({ name, stage, view }: { name: StageName; stage: StageExecution | undefined; view: DeploymentView }) {
  const tone: Tone = stage ? STAGE_TONE[stage.status] : 'muted';
  const label = stage ? STAGE_LABEL[stage.status] : '미실행';
  const stageSummary = (
    <>
      <Badge tone={tone}>{label}</Badge>
      {stage && stage.attempt > 1 && <span className="chip">시도 {stage.attempt}</span>}
      {stage?.exitCode !== null && stage?.exitCode !== undefined && <span className="chip mono">exit {stage.exitCode}</span>}
      {stage && <span className="chip">{durationBetween(stage.startedAt, stage.finishedAt)}</span>}
      {stage?.error && <span className="chip chip-danger mono">{stage.error}</span>}
    </>
  );
  const testFailed = name === 'test' && typeof stage?.summary === 'object' && stage.summary !== null && (stage.summary as { test_passed?: unknown }).test_passed === false;
  const open = name === 'policy' || name === 'deploy' || stage?.status === 'failed' || testFailed;
  return (
    <div className={`stage stage-${tone}`}>
      <div className="stage-rail" aria-hidden>
        <span className="stage-dot" />
      </div>
      <Collapsible title={STAGE_TITLE[name]} summary={stageSummary} defaultOpen={open}>
        {!stage ? (
          <Empty>{name === 'deploy' ? '미실행 또는 생략' : '이 단계는 아직 실행되지 않음'}</Empty>
        ) : name === 'test' ? (
          <TestBody stage={stage} view={view} />
        ) : name === 'policy' ? (
          <PolicyBody stage={stage} view={view} />
        ) : name === 'sign' ? (
          <SignBody stage={stage} view={view} />
        ) : (
          <DeployBody stage={stage} view={view} />
        )}
      </Collapsible>
    </div>
  );
}

function SummaryLine({ stage }: { stage: StageExecution }) {
  if (stage.summary === null || stage.summary === undefined) return null;
  return (
    <div className="summary-line">
      <span className="muted small">summary</span> <span className="mono small">{compactJson(stage.summary)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- test

function TestBody({ stage, view }: { stage: StageExecution; view: DeploymentView }) {
  const parsed = parseJsonArtifact<TestResult>(findArtifact(view, 'test_result', stage));
  const summary = (stage.summary ?? {}) as { stub?: boolean; test_passed?: boolean; template?: string };
  return (
    <div className="stack">
      <div className="chips">
        {summary.stub === true && <span className="chip">stub (fixture 템플릿{summary.template ? ` ${summary.template}` : ''})</span>}
        {summary.stub === false && <span className="chip">실제 parity 실행</span>}
      </div>
      {!parsed && <Empty>test_result 산출물이 없음</Empty>}
      {parsed && !parsed.ok && (
        <>
          <Notice tone="warning" title="test_result 를 읽을 수 없어 원문을 표시">{parsed.error}</Notice>
          <JsonBlock raw={parsed.raw} />
        </>
      )}
      {parsed?.ok && <TestResultView result={parsed.value} />}
      <SummaryLine stage={stage} />
    </div>
  );
}

function TestResultView({ result }: { result: TestResult }) {
  const conditions = result.facts?.conditions;
  const facts = result.facts ?? {};
  return (
    <div className="stack">
      <div className="row">
        <Badge tone={result.passed ? 'success' : 'danger'}>{result.passed ? '테스트 통과' : '테스트 실패'}</Badge>
        <span className="metric">
          <strong>{result.match.matched}</strong> / {result.match.total} 요청 일치{conditions ? ' (기준 조건 none)' : ''}
        </span>
      </div>
      {conditions && conditions.length > 0 && (
        <div className="conditions">
          {conditions.map((c) => {
            const pct = c.total ? Math.round((c.matched / c.total) * 100) : 0;
            return (
              <div key={c.name} className={`condition ${c.failed ? 'condition-failed' : ''}`}>
                <div className="condition-head">
                  <span className="mono">{c.name}</span>
                  <span>
                    {c.matched}/{c.total} {c.failed ? <Badge tone="danger">불일치 {c.mismatches.length}</Badge> : <Badge tone="success">일치</Badge>}
                  </span>
                </div>
                <div className="bar" aria-hidden>
                  <span className={`bar-fill ${c.failed ? 'bar-danger' : 'bar-success'}`} style={{ width: `${pct}%` }} />
                </div>
                {c.mismatches.length > 0 && (
                  <Collapsible title={`어긋난 요청 ${c.mismatches.length}건`}>
                    <table className="table small">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>요청</th>
                          <th>관련 사실</th>
                          <th>종류</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.mismatches.map((m) => (
                          <tr key={m.index}>
                            <td className="mono">{m.index}</td>
                            <td className="mono">{m.request}</td>
                            <td className="mono">{m.related_fact ?? <span className="muted">—</span>}</td>
                            <td className="mono">{m.related_kind ?? <span className="muted">원인 미상</span>}</td>
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
      {result.failures && result.failures.length > 0 && (
        <Collapsible title={`failures ${result.failures.length}건`} defaultOpen={!conditions}>
          <table className="table small">
            <tbody>
              {result.failures.map((f, i) => (
                <tr key={i}>
                  <td className="mono">{compactJson(f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapsible>
      )}
      <Kv
        columns={3}
        items={[
          ['DB', <span className="mono">{facts.db ?? '—'}</span>],
          ['로컬 파일 쓰기', facts.writes_local_file?.length ? <span className="mono">{facts.writes_local_file.join(', ')}</span> : <span className="muted">없음</span>],
          facts.migration ? ['마이그레이션', facts.migration.destructive ? <Badge tone="danger">파괴적 변경</Badge> : <Badge tone="success">안전</Badge>] : null,
          ['app', <span className="mono">{result.app}</span>],
          ['run_id', <Hash value={result.run_id} length={18} />],
          ['digest', <Hash value={result.digest} />],
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------- policy

function PolicyBody({ stage, view }: { stage: StageExecution; view: DeploymentView }) {
  const skeleton = view.deployment.executionMode === 'skeleton';
  const plan = parseJsonArtifact<Plan>(findArtifact(view, 'plan', stage));
  const pii = parseJsonArtifact<PiiReport>(findArtifact(view, 'pii', stage));
  const explainKo = findArtifact(view, 'explain.ko', stage);
  const explainJa = findArtifact(view, 'explain.ja', stage);
  const pr = view.policyResult;

  const decision: Decision | null = pr?.decision ?? (plan?.ok ? plan.value.decision : null) ?? view.deployment.decision;
  const targets = pr?.targets ?? (plan?.ok ? plan.value.targets : []);
  const failoverAllowed = pr?.failoverAllowed ?? (plan?.ok ? plan.value.failover_allowed : null);
  const requires: PlanRequire[] = plan?.ok && plan.value.requires ? plan.value.requires : ((pr?.requires ?? []) as PlanRequire[]);
  const planHash = pr?.planHash ?? (plan?.ok ? plan.value.plan_hash : null);

  if (!pr && !plan) {
    return (
      <div className="stack">
        <Empty>정책 결과가 아직 없음</Empty>
        <SummaryLine stage={stage} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="decision-row">
        {decision ? (
          <div className={`decision decision-${DECISION_TONE[decision]}`}>
            <span className="decision-label">결정</span>
            <span className="decision-value">{DECISION_LABEL[decision]}</span>
          </div>
        ) : (
          <div className="decision decision-muted">
            <span className="decision-label">결정</span>
            <span className="decision-value">—</span>
          </div>
        )}
        <Kv
          columns={1}
          items={[
            ['허용 배포 위치', targets.length ? <span className="chips">{targets.map((t) => <span key={t} className="chip">{targetLabel(t)}</span>)}</span> : <span className="muted">없음</span>],
            ['failover', failoverAllowed === null ? '—' : failoverAllowed ? <Badge tone="success">허용</Badge> : <Badge tone="muted">불가</Badge>],
            ['결정 지문 (plan_hash)', <Hash value={planHash} />],
            ['모드', <span className="mono">{skeleton ? 'skeleton (stub)' : 'cli'}</span>],
          ]}
        />
      </div>

      {requires.length > 0 && (
        <div>
          <h3 className="h3">고칠 것 (requires)</h3>
          <div className="requires">
            {requires.map((r) => (
              <div key={`${r.id}-${r.rule_id}`} className="require">
                <div className="require-id mono">{r.id}</div>
                {r.hint && <Bilingual ko={r.hint} ja={r.hint_i18n?.ja} />}
                <div className="require-meta">
                  <span className="chip mono">{r.rule_id}</span>
                  <span className="small muted">해소되면 가능한 위치:</span>
                  {r.allowed_targets?.length ? r.allowed_targets.map((t) => <span key={t} className="chip">{targetLabel(t)}</span>) : <span className="small muted">없음</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {requires.length === 0 && decision === 'allow' && <div className="small muted">해결 조건 없음</div>}

      {!skeleton && plan?.ok && <RulesView plan={plan.value} />}
      {plan && !plan.ok && (
        <Collapsible title="plan.json 원문 (parse 실패)">
          <Notice tone="warning">{plan.error}</Notice>
          <JsonBlock raw={plan.raw} />
        </Collapsible>
      )}

      {!skeleton && (explainKo || explainJa) && (
        <Collapsible title="결정 설명 (explain)" defaultOpen>
          <div className="explain-grid">
            {explainKo && <pre className="prose">{explainKo.content}</pre>}
            {explainJa && <pre className="prose" lang="ja">{explainJa.content}</pre>}
          </div>
        </Collapsible>
      )}

      {!skeleton && pii && (
        <Collapsible title="개인정보 후보 (pii)" summary={pii.ok ? <span className="chip">{pii.value.pii?.length ?? 0}건</span> : undefined}>
          {pii.ok ? (
            pii.value.pii && pii.value.pii.length > 0 ? (
              <table className="table small">
                <thead>
                  <tr>
                    <th>테이블</th>
                    <th>칼럼</th>
                    <th>종류</th>
                    <th>확신</th>
                    <th>근거</th>
                  </tr>
                </thead>
                <tbody>
                  {pii.value.pii.map((p, i) => (
                    <tr key={i}>
                      <td className="mono">{p.table}</td>
                      <td className="mono">{p.column}</td>
                      <td className="mono">{p.kind}</td>
                      <td>{p.confident ? <Badge tone="danger">확신</Badge> : <Badge tone="warning">사람 확인 필요</Badge>}</td>
                      <td className="small">{p.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="muted">개인정보 후보 없음</span>
            )
          ) : (
            <JsonBlock raw={pii.raw} />
          )}
        </Collapsible>
      )}
      <SummaryLine stage={stage} />
    </div>
  );
}

function RulesView({ plan }: { plan: Plan }) {
  const matched = plan.rules.filter((r) => r.result !== 'not_matched');
  const notMatched = plan.rules.filter((r) => r.result === 'not_matched');
  return (
    <div>
      <h3 className="h3">걸린 규칙</h3>
      {matched.length === 0 && <div className="small muted">걸린 규칙 없음</div>}
      <ul className="rules">
        {matched.map((r) => (
          <li key={r.id} className="rule">
            <span className="chip mono">{r.id}</span>
            {r.result === 'matched_after_block' && <span className="chip chip-muted">차단 뒤에 걸림</span>}
            <Bilingual ko={r.reason ?? <span className="muted">이유 없음</span>} ja={r.reason_i18n?.ja} />
          </li>
        ))}
      </ul>
      {notMatched.length > 0 && (
        <div className="small muted">
          통과한 규칙 {notMatched.length}개: <span className="mono">{notMatched.map((r) => r.id).join(', ')}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- approval

function ApprovalCard({ view, source, onChanged }: { view: DeploymentView; source: DataSource; onChanged: () => void }) {
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
    <div className={`stage stage-${awaiting ? 'warning' : d.approver ? 'success' : 'muted'} stage-approval`}>
      <div className="stage-rail" aria-hidden>
        <span className="stage-dot" />
      </div>
      <div className="approval">
        <div className="approval-head">
          <strong>Approval · 사람 승인</strong>
          {awaiting ? <Badge tone="warning">승인 대기</Badge> : d.approver ? <Badge tone="success">승인됨</Badge> : <Badge tone="muted">—</Badge>}
        </div>
        <div className="row">
          <Kv
            columns={2}
            items={[
              ['요청자', <span className="mono">{d.requester}</span>],
              ['승인자', d.approver ? <span className="mono">{d.approver}</span> : <span className="muted">—</span>],
              approval?.ok ? ['승인 시각', fmtTime(approval.value.approved_at)] : null,
              approval?.ok ? ['plan_sha256', <Hash value={approval.value.plan_sha256} />] : null,
            ]}
          />
          {awaiting && (
            <div className="approval-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
                {busy ? '승인 중…' : '승인 (POST /approve)'}
              </button>
              <div className="small muted">요청자 본인은 승인할 수 없음 (403)</div>
            </div>
          )}
        </div>
        {error !== null && <ErrorNotice error={error} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sign

function SignBody({ stage, view }: { stage: StageExecution; view: DeploymentView }) {
  const sign = parseJsonArtifact<SignResult>(findArtifact(view, 'sign_result', stage));
  const signLogs = view.auditLogs.filter((l) => l.kind === 'sign').map((l) => l.payload as unknown as SignLog);
  const lastLog = signLogs[signLogs.length - 1];
  const dryRun = sign?.ok && sign.value.signature_ref.startsWith('dry-run:');
  return (
    <div className="stack">
      {!sign && !lastLog && <Empty>서명 결과가 없음</Empty>}
      {lastLog && (
        <div className="row">
          {lastLog.result === 'signed' ? <Badge tone="success">서명됨</Badge> : <Badge tone="danger">서명 거부</Badge>}
          {lastLog.reason && <span className="chip chip-danger mono">{lastLog.reason}</span>}
          {dryRun && <Badge tone="muted">모의 서명 (dry-run)</Badge>}
          {sign?.ok && !dryRun && <Badge tone="success">cosign</Badge>}
        </div>
      )}
      {sign?.ok && (
        <Kv
          columns={2}
          items={[
            ['signature_ref', <span className="mono wrap">{sign.value.signature_ref}</span>],
            ['서명 시각', fmtTime(sign.value.signed_at)],
            ['요청자', <span className="mono">{sign.value.requester}</span>],
            ['승인자', <span className="mono">{sign.value.approver}</span>],
            ['서명된 배포 위치', <span className="chips">{sign.value.targets.map((t) => <span key={t} className="chip">{targetLabel(t)}</span>)}</span>],
            ['failover', sign.value.failover_allowed ? <Badge tone="success">허용</Badge> : <Badge tone="muted">불가</Badge>],
            ['plan_hash', <Hash value={sign.value.plan_hash} />],
            ['digest', <Hash value={sign.value.digest} />],
          ]}
        />
      )}
      {sign && !sign.ok && (
        <>
          <Notice tone="warning" title="sign_result 를 읽을 수 없어 원문을 표시">{sign.error}</Notice>
          <JsonBlock raw={sign.raw} />
        </>
      )}
      <SummaryLine stage={stage} />
    </div>
  );
}

// ---------------------------------------------------------------- deploy

function DeployBody({ stage, view }: { stage: StageExecution; view: DeploymentView }) {
  const parsed = parseJsonArtifact<DeployResult>(findArtifact(view, 'deploy_result', stage));
  const result = parsed?.ok ? parsed.value : null;
  const display = deriveDeployDisplay(stage, result);
  return (
    <div className="stack">
      <Notice tone={display.tone} title={display.title}>
        {(display.decisionLabel || display.routingLabel) && (
          <div className="chips" style={{ marginBottom: 6 }}>
            {display.decisionLabel && <span className="chip mono">{display.decisionLabel}</span>}
            {display.routingLabel && display.routingTone && <Badge tone={display.routingTone}>{display.routingLabel}</Badge>}
          </div>
        )}
        {display.details.length > 0 && (
          <ul className="plain">
            {display.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Notice>
      {parsed && !parsed.ok && (
        <>
          <Notice tone="warning" title="deploy_result 를 읽을 수 없어 원문을 표시">{parsed.error}</Notice>
          <JsonBlock raw={parsed.raw} />
        </>
      )}
      {result && <DeployResultView result={result} />}
      <SummaryLine stage={stage} />
    </div>
  );
}

function DeployResultView({ result }: { result: DeployResult }) {
  const r = result.routing;
  return (
    <div className="stack">
      <Kv
        columns={3}
        items={[
          ['이미지', result.image ? <span className="mono wrap small">{result.image}</span> : <span className="muted">—</span>],
          ['계획된 위치', <span className="chips">{result.targets_planned.map((t) => <span key={t} className="chip">{targetLabel(t)}</span>)}</span>],
          ['failover', result.failover_allowed === null ? '—' : result.failover_allowed ? <Badge tone="success">허용</Badge> : <Badge tone="muted">불가</Badge>],
          [
            '서명 검증',
            result.signature ? (
              <span className="row">
                <Badge tone="success">검증됨</Badge>
                {result.signature.tlog && <span className="chip mono">tlog {result.signature.tlog}</span>}
              </span>
            ) : (
              <Badge tone="danger">미검증</Badge>
            ),
          ],
          ['시작', fmtTime(result.started_at)],
          ['종료', fmtTime(result.finished_at)],
        ]}
      />
      <div>
        <h3 className="h3">트래픽 전환 (routing)</h3>
        <Kv
          columns={3}
          items={[
            ['결과', <Badge tone={r.result === 'ok' ? 'success' : r.result === 'error' ? 'danger' : 'muted'}>{r.result}</Badge>],
            ['전환 대상', r.kind ? <span>{targetLabel(r.kind)} <Hash value={r.target_id} length={10} /></span> : <span className="muted">—</span>],
            ['route revision', r.revision ?? '—'],
            r.standby_target_id ? ['standby', <span>{r.standby_enabled ? <Badge tone="success">활성</Badge> : <Badge tone="muted">비활성</Badge>} <Hash value={r.standby_target_id} length={10} /></span>] : null,
            r.error ? ['오류', <span className="mono small">{r.error}</span>] : null,
            r.reason ? ['이유', r.reason] : null,
          ]}
        />
      </div>
      <div>
        <h3 className="h3">단계별 결과</h3>
        <table className="table small">
          <thead>
            <tr>
              <th>대상</th>
              <th>단계</th>
              <th>결과</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
            {result.targets.map((step, i) => (
              <tr key={i}>
                <td>{targetLabel(step.target)}</td>
                <td className="mono">{step.phase}</td>
                <td>
                  <Badge tone={step.result === 'ok' ? 'success' : step.result === 'error' ? 'danger' : 'muted'}>{step.result}</Badge>
                </td>
                <td className="mono small">
                  {[
                    step.revision && `revision ${step.revision}`,
                    step.container && `container ${step.container}`,
                    step.serving && `serving ${step.serving}`,
                    step.previous && `previous ${step.previous}`,
                    step.candidate_url && step.candidate_url,
                    step.job_id && `job ${step.job_id}`,
                    step.reason,
                    step.error && `오류: ${step.error}`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.checks.length > 0 && (
        <div>
          <h3 className="h3">후보 검사</h3>
          <table className="table small">
            <thead>
              <tr>
                <th>대상</th>
                <th>결과</th>
                <th>checker</th>
                <th>URL</th>
                <th>상세</th>
              </tr>
            </thead>
            <tbody>
              {result.checks.map((c, i) => (
                <tr key={i}>
                  <td>{targetLabel(c.target)}</td>
                  <td>{c.pass ? <Badge tone="success">통과</Badge> : <Badge tone="danger">실패</Badge>}</td>
                  <td className="mono">{c.checker}</td>
                  <td className="mono small">{c.url ?? '—'}</td>
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

// ---------------------------------------------------------------- audit / artifacts

function AuditSection({ view }: { view: DeploymentView }) {
  return (
    <section className="card">
      <Collapsible title="감사 기록 (auditLogs)" summary={<span className="chip">{view.auditLogs.length}건</span>} defaultOpen={view.auditLogs.length > 0}>
        {view.auditLogs.length === 0 ? (
          <Empty>감사 기록 없음</Empty>
        ) : (
          <table className="table small">
            <thead>
              <tr>
                <th>kind</th>
                <th>시각</th>
                <th>내용</th>
                <th>plan_hash</th>
              </tr>
            </thead>
            <tbody>
              {view.auditLogs.map((log) => {
                // payload 는 DecisionLog(deploy/rollback) 또는 SignLog 한 줄. 느슨하게 읽는다.
                const p = log.payload as Record<string, unknown>;
                const str = (key: string): string | null => (typeof p[key] === 'string' ? (p[key] as string) : null);
                const list = (key: string): string[] | null => (Array.isArray(p[key]) ? (p[key] as unknown[]).map(String) : null);
                const decision = str('decision');
                const ruleIds = list('rule_ids');
                const targets = list('targets');
                return (
                  <tr key={log.id}>
                    <td className="mono">{log.kind}</td>
                    <td>{fmtTime(str('time') ?? log.createdAt)}</td>
                    <td>
                      {log.kind === 'sign' ? (
                        <span>
                          {str('result') === 'signed' ? <Badge tone="success">signed</Badge> : <Badge tone="danger">{str('result') ?? '—'}</Badge>}
                          {str('reason') && <span className="chip chip-danger mono">{str('reason')}</span>}
                          <span className="small muted"> 승인자 {str('approver') ?? '—'}</span>
                        </span>
                      ) : (
                        <span>
                          {decision && decision in DECISION_TONE ? <Badge tone={DECISION_TONE[decision as Decision]}>{decision}</Badge> : <span className="mono">{decision ?? '—'}</span>}
                          {ruleIds && <span className="small muted"> 규칙 {ruleIds.join(', ')}</span>}
                          {targets && <span className="small muted"> → {targets.length ? targets.map(targetLabel).join(', ') : '없음'}</span>}
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
    </section>
  );
}

function ArtifactsSection({ view }: { view: DeploymentView }) {
  const latest = useMemo(() => latestStages(view.stages), [view.stages]);
  const grouped = STAGE_ORDER.map((name) => ({ name, items: artifactsOf(view, latest[name]) })).filter((g) => g.items.length > 0);
  const total = view.artifacts.length;
  return (
    <section className="card">
      <Collapsible title="산출물 (artifacts)" summary={<span className="chip">{total}건</span>}>
        {total === 0 && <Empty>산출물 없음</Empty>}
        {grouped.map((g) => (
          <div key={g.name} className="artifact-group">
            <div className="small muted">{g.name}</div>
            {g.items.map((a) => {
              const parsed = parseJsonArtifact(a);
              return (
                <Collapsible
                  key={a.id}
                  title={<span className="mono">{a.name}</span>}
                  summary={
                    <>
                      <span className="chip mono">{a.relativePath}</span>
                      <span className="chip">{a.mediaType === 'application/json' ? 'json' : 'text'}</span>
                      {a.schemaName && <span className="chip mono small">{a.schemaName}</span>}
                      {a.validationError && <span className="chip chip-danger">{a.validationError}</span>}
                    </>
                  }
                >
                  {parsed?.ok ? <JsonBlock value={parsed.value} /> : <pre className={a.mediaType === 'text/plain' ? 'prose' : 'code'}>{a.content}</pre>}
                  <div className="small muted">
                    sha256 <Hash value={a.contentHash} /> · {fmtTime(a.createdAt)}
                  </div>
                </Collapsible>
              );
            })}
          </div>
        ))}
      </Collapsible>
    </section>
  );
}

import { useState, type ReactNode } from "react";
import { api } from "../api";
import { ApiError } from "../api/client";
import type {
  DeployResult,
  Deployment,
  DeploymentAuditLog,
  DeploymentView,
  Plan,
  PolicyResult,
  SignLog,
  SignResult,
  StageExecution,
  TestResult,
  User,
} from "../api/types";
import { ConditionBars } from "../components/ConditionBars";
import { Icon } from "../components/Icon";
import { Stepper } from "../components/Stepper";
import { Bool, Card, Empty, ErrorNote, Fields, Loading, Mono, Pill } from "../components/ui";
import { usePolling } from "../hooks";
import { parseArtifact } from "../lib/artifacts";
import { describeDeploy, type Tone } from "../lib/deployStatus";
import { formatTime, personLabel, short, shortDigest, targetLabel } from "../lib/format";
import type { IconName } from "../lib/icons";
import { buildSteps } from "../lib/pipeline";
import { latestAttempts } from "../lib/stages";
import { href } from "../router";

const STATUS: Record<Deployment["status"], [Tone, IconName, string]> = {
  queued: ["neutral", "clock", "대기열"],
  running: ["info", "spinner", "진행 중"],
  awaiting_approval: ["warning", "clock", "승인 대기"],
  blocked: ["danger", "shield", "차단"],
  failed: ["danger", "x", "실패"],
  succeeded: ["success", "check", "완료"],
};

const STAGE_LABEL = { test: "테스트", policy: "정책", sign: "서명", deploy: "배포" };

const SIGN_REASON: Record<string, string> = {
  policy_block: "정책 차단",
  no_targets: "배포 대상 없음",
  approval_missing: "승인 기록 없음",
  approval_mismatch: "승인 기록이 plan 과 다름",
  requester_mismatch: "요청자 불일치",
  self_approval: "본인 승인",
  sign_failed: "서명 실패",
};

const IN_PROGRESS = ["queued", "running"];

export function DeploymentDetail({ id }: { id: string }) {
  const [interval, setIntervalMs] = useState<number | null>(2000);
  const view = usePolling(
    async () => {
      const data = await api.getDeployment(id);
      // 진행 중일 때만 2초 폴링
      setIntervalMs(IN_PROGRESS.includes(data.deployment.status) ? 2000 : null);
      return data;
    },
    interval,
    id,
  );
  const me = usePolling(() => api.me(), null, "me");

  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ErrorNote error={view.error} />;
  return <DeploymentBody view={view.data} me={me.data} error={view.error} reload={view.refresh} polling={interval !== null} />;
}

function DeploymentBody({
  view,
  me,
  error,
  reload,
  polling,
}: {
  view: DeploymentView;
  me: User | undefined;
  error: Error | null;
  reload: () => Promise<void>;
  polling: boolean;
}) {
  const { deployment, artifacts, policyResult, auditLogs } = view;
  const latest = latestAttempts(view.stages);
  const ids = (stage: StageExecution | undefined) => (stage ? [stage.id] : []);
  const test = parseArtifact<TestResult>(artifacts, "test_result", ids(latest.test));
  const plan = policyResult?.planArtifactId
    ? parseArtifact<Plan>(
        artifacts.filter((artifact) => artifact.id === policyResult.planArtifactId),
        "plan",
      )
    : parseArtifact<Plan>(artifacts, "plan", ids(latest.policy));
  const sign = parseArtifact<SignResult>(artifacts, "sign_result", ids(latest.sign));
  const approval = parseArtifact<{ approver: string; approved_at: string }>(artifacts, "approval", ids(latest.sign));
  const deployResult = parseArtifact<DeployResult>(artifacts, "deploy_result", ids(latest.deploy));
  const signLogs = auditLogs.filter((log) => log.kind === "sign");
  const signLog = (signLogs.filter((log) => log.stageExecutionId === latest.sign?.id).at(-1) ?? signLogs.at(-1))
    ?.payload as unknown as SignLog | undefined;
  const signRefused = signLog?.result === "refused";
  const outcome = describeDeploy(deployment, latest.deploy, deployResult.data);
  const steps = buildSteps(deployment, latest, test.data, signRefused, outcome);

  let [tone, icon, label] = STATUS[deployment.status];
  if (deployment.status === "succeeded" && !deployment.deploymentPerformed) {
    tone = "neutral";
    label = "완료 (배포 생략)";
  }

  return (
    <div className="stack">
      <div className="crumbs">
        <a href={href.home()}>앱</a>
        <span>/</span>
        <a href={href.application(deployment.applicationId)}>{plan.data?.app ?? test.data?.app ?? "앱"}</a>
        <span>/</span>
        <span>v{deployment.version}</span>
      </div>

      <div className="page-head row-between">
        <div>
          <h1>
            배포 v{deployment.version}{" "}
            <Pill tone={tone} icon={icon}>
              {label}
            </Pill>
          </h1>
          <p className="sub">
            {deployment.currentStage ? `현재 단계: ${STAGE_LABEL[deployment.currentStage]}` : "아직 시작 전"}
            {polling && <span className="live"> · 2초마다 갱신</span>}
          </p>
        </div>
        <button className="btn" type="button" onClick={() => void reload()}>
          새로고침
        </button>
      </div>
      <ErrorNote error={error} />
      {deployment.error && (
        <div className="banner tone-danger">
          <Icon name="alert" />
          <span>
            <Mono>{deployment.error}</Mono>
          </span>
        </div>
      )}

      <Card>
        <Stepper steps={steps} />
      </Card>

      <Card title="실행 정보">
        <Fields
          items={[
            ["트리거", deployment.trigger === "webhook" ? "GitHub push" : "수동 요청"],
            [
              "커밋",
              <span className="inline">
                <Mono title={deployment.sourceRevision}>{short(deployment.sourceRevision, 7)}</Mono>
                {deployment.sourceRevisionVerified ? (
                  <Pill tone="success" icon="check">
                    테스트한 이미지 = 이 커밋
                  </Pill>
                ) : (
                  <Pill tone="neutral" icon="minus">
                    커밋 검증 안 됨
                  </Pill>
                )}
              </span>,
            ],
            [
              "이미지",
              <span className="inline">
                <Mono title={deployment.imageDigest}>{shortDigest(deployment.imageDigest)}</Mono>
                {deployment.digestSource === "registry" ? (
                  <Pill tone="success" icon="check">
                    registry
                  </Pill>
                ) : (
                  <Pill tone="warning" icon="alert">
                    placeholder
                  </Pill>
                )}
              </span>,
            ],
            ["실제 배포", <Bool value={deployment.deploymentPerformed} yes="수행함" no="수행 안 함" />],
            ["요청자", personLabel(deployment.requester, me)],
            ["승인자", personLabel(deployment.approver, me)],
            ["실행 모드", deployment.executionMode === "skeleton" ? "skeleton (내부 stub)" : "cli"],
            ["생성", formatTime(deployment.createdAt)],
          ]}
        />
      </Card>

      <div className="grid-2">
        <TestCard stage={latest.test} test={test.data} error={test.error} />
        <PolicyCard stage={latest.policy} policy={policyResult} plan={plan.data} />
      </div>

      <div className="grid-2">
        <ApprovalCard
          deployment={deployment}
          me={me}
          approvedAt={approval.data?.approved_at ?? null}
          onApproved={reload}
        />
        <SignCard stage={latest.sign} sign={sign.data} log={signLog} deployment={deployment} />
      </div>

      <DeployCard outcome={outcome} result={deployResult.data} stage={latest.deploy} />

      <AuditCard logs={auditLogs} />

      <Card title="산출물 원문">
        {artifacts.length === 0 ? (
          <Empty>없음</Empty>
        ) : (
          <div className="raw-list">
            {artifacts.map((artifact) => (
              <details key={artifact.id} className="raw">
                <summary>
                  <Mono>{artifact.relativePath}</Mono>
                  {artifact.validationError && <Pill tone="danger" icon="alert">{artifact.validationError}</Pill>}
                </summary>
                <pre>{artifact.content}</pre>
              </details>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function StageError({ stage }: { stage: StageExecution | undefined }) {
  if (!stage || stage.status !== "failed" || !stage.error) return null;
  const summary = stage.summary as { stderr?: unknown; details?: unknown } | null;
  const extra = typeof summary?.stderr === "string" ? summary.stderr : typeof summary?.details === "string" ? summary.details : null;
  return (
    <div className="note tone-danger">
      <Mono>{stage.error}</Mono>
      {extra && <pre className="small-pre">{extra}</pre>}
    </div>
  );
}

function TestCard({ stage, test, error }: { stage: StageExecution | undefined; test: TestResult | null; error: string | null }) {
  const conditions = test?.facts?.conditions;
  return (
    <Card
      title="테스트"
      aside={
        test ? (
          test.passed ? (
            <Pill tone="success" icon="check">통과</Pill>
          ) : (
            <Pill tone="danger" icon="x">실패</Pill>
          )
        ) : null
      }
    >
      {!stage && <Empty>아직 실행 안 됨</Empty>}
      <StageError stage={stage} />
      {error && <div className="note tone-danger">{error}</div>}
      {test && (
        <>
          <Fields
            items={[
              [conditions?.length ? "기준 조건 일치" : "일치", `${test.match.matched}/${test.match.total}`],
              ...(test.failures?.length || !conditions?.length
                ? ([["실패 요청", `${test.failures?.length ?? 0}건`]] as [string, string][])
                : []),
              ...(test.facts?.db ? ([["DB", test.facts.db]] as [string, string][]) : []),
              ...(test.facts?.writes_local_file?.length
                ? ([["로컬 파일 쓰기", test.facts.writes_local_file.join(", ")]] as [string, string][])
                : []),
            ]}
          />
          {conditions && conditions.length > 0 && (
            <>
              <h3 className="sub-title">조건별 재생</h3>
              <ConditionBars conditions={conditions} />
              {conditions
                .filter((condition) => condition.mismatches.length > 0)
                .map((condition) => (
                  <details key={condition.name} className="mismatch">
                    <summary>
                      {condition.name} 불일치 {condition.mismatches.length}건
                    </summary>
                    <ul className="plain">
                      {condition.mismatches.map((item) => {
                        const note = (item as { summary?: unknown }).summary;
                        return (
                          <li key={item.index}>
                            <Mono>#{item.index}</Mono> <Mono>{item.request}</Mono>
                            {typeof note === "string" && <span className="muted"> {note}</span>}
                            {item.related_kind && (
                              <span className="tag">
                                {item.related_kind}
                                {item.related_fact ? ` ${item.related_fact}` : ""}
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ))}
            </>
          )}
        </>
      )}
    </Card>
  );
}

function TargetPills({ targets }: { targets: string[] }) {
  if (targets.length === 0) return <span className="muted">없음</span>;
  return (
    <span className="inline">
      {targets.map((target) => (
        <Pill key={target} tone="neutral" icon={target === "onprem" ? "server" : "cloud"}>
          {targetLabel(target)}
        </Pill>
      ))}
    </span>
  );
}

function PolicyCard({
  stage,
  policy,
  plan,
}: {
  stage: StageExecution | undefined;
  policy: PolicyResult | null;
  plan: Plan | null;
}) {
  const decision = policy?.decision ?? plan?.decision;
  const requires = plan?.requires ?? policy?.requires ?? [];
  const rules = plan?.rules ?? [];
  const hit = rules.filter((rule) => rule.result !== "not_matched");
  const decisionPill =
    decision === "allow" ? (
      <Pill tone="success" icon="check">허용</Pill>
    ) : decision === "block" ? (
      <Pill tone="danger" icon="shield">차단</Pill>
    ) : decision === "needs_approval" ? (
      <Pill tone="warning" icon="clock">승인 필요</Pill>
    ) : null;
  return (
    <Card title="정책" aside={decisionPill}>
      {!stage && <Empty>아직 실행 안 됨</Empty>}
      <StageError stage={stage} />
      {(policy || plan) && (
        <>
          <Fields
            items={[
              ["배포 위치", <TargetPills targets={policy?.targets ?? plan?.targets ?? []} />],
              [
                "failover",
                <Bool value={policy?.failoverAllowed ?? plan?.failover_allowed ?? false} yes="허용" no="막힘" />,
              ],
              ...((policy?.planHash ?? plan?.plan_hash)
                ? ([["plan_hash", <Mono title={policy?.planHash ?? plan?.plan_hash}>{short(policy?.planHash ?? plan?.plan_hash, 12)}</Mono>]] as [string, ReactNode][])
                : []),
            ]}
          />
          {requires.length > 0 && (
            <>
              <h3 className="sub-title">고쳐야 할 것</h3>
              <ul className="requires">
                {requires.map((item) => (
                  <li key={item.id}>
                    <div className="inline">
                      <Mono>{item.id}</Mono>
                      <span className="muted">규칙 {item.rule_id}</span>
                    </div>
                    {item.hint && <p>{item.hint}</p>}
                    {item.hint_i18n?.ja && (
                      <p className="ja" lang="ja">
                        {item.hint_i18n.ja}
                      </p>
                    )}
                    <div className="inline small">
                      <span className="muted">고치면 가능한 위치</span>
                      <TargetPills targets={item.allowed_targets} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {hit.length > 0 && (
            <>
              <h3 className="sub-title">걸린 규칙</h3>
              <ul className="rules">
                {hit.map((rule) => (
                  <li key={rule.id}>
                    <span className="inline">
                      <Mono>{rule.id}</Mono>
                      {rule.result === "matched_after_block" && <span className="tag">차단 뒤 추가로 걸림</span>}
                    </span>
                    {rule.reason && <p>{rule.reason}</p>}
                    {rule.reason_i18n?.ja && (
                      <p className="ja" lang="ja">
                        {rule.reason_i18n.ja}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {rules.length > hit.length && (
                <p className="muted small">
                  평가한 규칙 {rules.length}개 중 {hit.length}개 걸림
                </p>
              )}
            </>
          )}
        </>
      )}
    </Card>
  );
}

function ApprovalCard({
  deployment,
  me,
  approvedAt,
  onApproved,
}: {
  deployment: Deployment;
  me: User | undefined;
  approvedAt: string | null;
  onApproved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = deployment.status === "awaiting_approval";
  const isRequester = !!me && me.id === deployment.requester;

  async function approve() {
    setBusy(true);
    setMessage(null);
    try {
      await api.approve(deployment.id);
      await onApproved();
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) setMessage("본인이 요청한 배포는 승인할 수 없음");
      else if (error instanceof ApiError && error.status === 409) setMessage("이미 처리됨 (승인 대기 상태가 아님)");
      else setMessage(error instanceof Error ? error.message : String(error));
      await onApproved();
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (deployment.decision === "allow") body = <p>정책이 허용해서 승인 없이 진행 (approver: auto)</p>;
  else if (deployment.decision === "block") body = <Empty>차단된 배포라 승인 단계 없음</Empty>;
  else if (deployment.decision !== "needs_approval") body = <Empty>정책 결과 전</Empty>;
  else if (pending)
    body = (
      <div className="stack-sm">
        <p>정책이 사람 승인을 요구함. 요청자와 다른 사람만 승인 가능</p>
        <div className="row">
          <button
            className="btn primary"
            type="button"
            disabled={busy || isRequester || !me}
            onClick={() => void approve()}
          >
            {busy ? "승인 중" : "승인"}
          </button>
          {isRequester && <span className="muted small">내가 요청한 배포</span>}
        </div>
      </div>
    );
  else
    body = (
      <Fields
        items={[
          ["승인자", deployment.approver ? personLabel(deployment.approver, me) : "-"],
          ["승인 시각", formatTime(approvedAt)],
        ]}
      />
    );

  return (
    <Card
      title="승인"
      aside={
        pending ? (
          <Pill tone="warning" icon="clock">대기</Pill>
        ) : deployment.decision === "needs_approval" && deployment.approver ? (
          <Pill tone="success" icon="check">승인됨</Pill>
        ) : null
      }
    >
      {body}
      {message && <p className="danger-text">{message}</p>}
    </Card>
  );
}

function SignCard({
  stage,
  sign,
  log,
  deployment,
}: {
  stage: StageExecution | undefined;
  sign: SignResult | null;
  log: SignLog | undefined;
  deployment: Deployment;
}) {
  const refused = log?.result === "refused";
  const ref = sign?.signature_ref ?? log?.signature_ref ?? null;
  const dryRun = ref?.startsWith("dry-run:");
  return (
    <Card
      title="서명"
      aside={
        refused ? (
          <Pill tone="danger" icon="x">거부</Pill>
        ) : sign ? (
          <Pill tone="success" icon="lock">서명됨</Pill>
        ) : stage?.status === "running" ? (
          <Pill tone="info" icon="spinner">진행 중</Pill>
        ) : null
      }
    >
      {!stage && <Empty>{deployment.status === "blocked" ? "차단되어 서명하지 않음" : "아직 실행 안 됨"}</Empty>}
      {refused && (
        <div className="note tone-danger">
          거부 이유: {SIGN_REASON[log?.reason ?? ""] ?? log?.reason ?? "알 수 없음"}
          {log?.reason && <Mono>{log.reason}</Mono>}
        </div>
      )}
      {!refused && <StageError stage={stage} />}
      {ref && (
        <Fields
          items={[
            [
              "signature_ref",
              <span className="stack-xs">
                {dryRun ? (
                  <Pill tone="warning" icon="alert">dry-run (실제 서명 아님)</Pill>
                ) : ref.startsWith("cosign:") ? (
                  <Pill tone="success" icon="lock">cosign</Pill>
                ) : null}
                <Mono>{ref}</Mono>
              </span>,
            ],
            ["서명 시각", formatTime(sign?.signed_at ?? log?.time)],
            ["approver", sign?.approver ?? log?.approver ?? "-"],
          ]}
        />
      )}
    </Card>
  );
}

function DeployCard({
  outcome,
  result,
  stage,
}: {
  outcome: ReturnType<typeof describeDeploy>;
  result: DeployResult | null;
  stage: StageExecution | undefined;
}) {
  const routing = result?.routing;
  return (
    <Card title="배포">
      <div className={`outcome tone-${outcome.tone}`}>
        <span className="outcome-icon">
          <Icon name={outcome.icon} size={20} />
        </span>
        <div>
          <strong>{outcome.title}</strong>
          {outcome.notes.map((note) => (
            <p key={note} className="small">
              {note}
            </p>
          ))}
        </div>
      </div>
      {result && (
        <>
          <Fields
            items={[
              ["decision", <Mono>{result.decision}</Mono>],
              ["routing.result", <Mono>{routing?.result ?? "-"}</Mono>],
              [
                "활성",
                routing?.result === "ok" && routing.kind ? (
                  <span className="inline">
                    <Pill tone="success" icon={routing.kind === "onprem" ? "server" : "cloud"}>
                      {targetLabel(routing.kind)}
                    </Pill>
                    <span className="muted">rev {routing.revision}</span>
                  </span>
                ) : (
                  "-"
                ),
              ],
              [
                "대기",
                routing?.standby_target_id ? (
                  <span className="inline">
                    <Pill tone="neutral" icon="cloud">Cloud Run</Pill>
                    {routing.standby_enabled ? (
                      <span className="muted">failover 가능</span>
                    ) : (
                      <span className="muted">비활성 (정책이 failover 막음)</span>
                    )}
                  </span>
                ) : (
                  "-"
                ),
              ],
              [
                "서명 확인",
                result.signature ? (
                  <span className="inline">
                    <Bool value={result.signature.verified} yes="확인됨" no="실패" />
                    {result.signature.tlog && <span className="muted">tlog {result.signature.tlog}</span>}
                  </span>
                ) : (
                  "-"
                ),
              ],
            ]}
          />
          <h3 className="sub-title">대상별 진행</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>대상</th>
                  <th>단계</th>
                  <th>결과</th>
                  <th>내용</th>
                </tr>
              </thead>
              <tbody>
                {result.targets.map((step, index) => (
                  <tr key={index}>
                    <td>{targetLabel(step.target)}</td>
                    <td>
                      <Mono>{step.phase}</Mono>
                    </td>
                    <td>
                      <Pill
                        tone={step.result === "ok" ? "success" : step.result === "error" ? "danger" : "neutral"}
                        icon={step.result === "ok" ? "check" : step.result === "error" ? "x" : "minus"}
                      >
                        {step.result}
                      </Pill>
                    </td>
                    <td className="muted small">
                      {step.error ?? step.reason ?? step.serving ?? step.revision ?? step.container ?? ""}
                    </td>
                  </tr>
                ))}
                {result.checks.map((check, index) => (
                  <tr key={`check-${index}`}>
                    <td>{targetLabel(check.target)}</td>
                    <td>
                      <Mono>check</Mono>
                    </td>
                    <td>
                      <Pill tone={check.pass ? "success" : "danger"} icon={check.pass ? "check" : "x"}>
                        {check.pass ? "pass" : "fail"}
                      </Pill>
                    </td>
                    <td className="muted small">{check.url ?? check.checker}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!result && stage?.status === "failed" && <StageError stage={stage} />}
    </Card>
  );
}

function auditLine(log: DeploymentAuditLog): string {
  const p = log.payload;
  const list = (value: unknown) => (Array.isArray(value) ? value.join(", ") || "없음" : "-");
  if (log.kind === "deploy")
    return `${String(p.decision)} · 위치 ${list(p.targets)} · 규칙 ${list(p.rule_ids)}`;
  if (log.kind === "sign") {
    const reason = p.reason ? ` · ${SIGN_REASON[String(p.reason)] ?? String(p.reason)}` : "";
    return `${String(p.result)}${reason}${p.signature_ref ? ` · ${String(p.signature_ref)}` : ""}`;
  }
  return JSON.stringify(p);
}

function AuditCard({ logs }: { logs: DeploymentAuditLog[] }) {
  return (
    <Card title="결정 기록">
      {logs.length === 0 ? (
        <Empty>없음</Empty>
      ) : (
        <ul className="audit">
          {logs.map((log) => (
            <li key={log.id}>
              <span className="audit-time">{formatTime(String(log.payload.time ?? log.createdAt))}</span>
              <span className={`tag kind-${log.kind}`}>{log.kind}</span>
              <span className="audit-text">{auditLine(log)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

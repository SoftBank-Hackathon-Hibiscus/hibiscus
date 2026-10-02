import type { Deployment, StageExecution, StageName, TestResult } from "../api/types";
import type { DeployOutcome } from "./deployStatus";

export type StepState = "done" | "failed" | "attention" | "running" | "waiting" | "skipped" | "idle";

export interface Step {
  key: "test" | "policy" | "approval" | "sign" | "deploy";
  label: string;
  state: StepState;
  note: string;
}

const fromStage = (stage: StageExecution | undefined): StepState => {
  if (!stage) return "idle";
  switch (stage.status) {
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "running";
  }
};

export function buildSteps(
  deployment: Deployment,
  latest: Partial<Record<StageName, StageExecution>>,
  test: TestResult | null,
  signRefused: boolean,
  deploy: DeployOutcome,
): Step[] {
  // 테스트 단계 자체는 성공해도 결과 파일이 실패일 수 있음
  let testState = fromStage(latest.test);
  if (testState === "done" && test && !test.passed) testState = "failed";
  // 조건별 결과가 있으면 처음 어긋난 조건을 표시 (match 는 기준 조건 none 값)
  const failedCondition = test?.facts?.conditions?.find((condition) => condition.failed);
  const testNote =
    test && testState !== "running"
      ? failedCondition
        ? `${failedCondition.name} ${failedCondition.matched}/${failedCondition.total}`
        : `${test.match.matched}/${test.match.total} 일치`
      : stateNote(testState);

  let policyState = fromStage(latest.policy);
  let policyNote = stateNote(policyState);
  if (policyState === "done" && deployment.decision) {
    policyState =
      deployment.decision === "block"
        ? "failed"
        : deployment.decision === "needs_approval" && !deployment.approver
          ? "attention"
          : "done";
    policyNote = { allow: "허용", needs_approval: "승인 필요", block: "차단" }[deployment.decision];
  }

  let approvalState: StepState = "idle";
  let approvalNote = "-";
  if (deployment.decision === "allow") {
    approvalState = "skipped";
    approvalNote = "자동 (auto)";
  } else if (deployment.decision === "needs_approval") {
    if (deployment.approver) {
      approvalState = "done";
      approvalNote = "승인됨";
    } else if (deployment.status === "awaiting_approval") {
      approvalState = "attention";
      approvalNote = "승인 대기";
    }
  }

  let signState = fromStage(latest.sign);
  let signNote = stateNote(signState);
  if (signRefused) {
    signState = "failed";
    signNote = "서명 거부";
  } else if (signState === "done") signNote = "서명됨";

  const deployState: StepState = {
    activated: "done",
    activated_unrouted: "attention",
    held: "attention",
    rolled_back: "attention",
    rolled_back_routing: "attention",
    error: "failed",
    running: "running",
    skipped: "skipped",
    gate_failed: "failed",
    not_started: "idle",
    waiting: "idle",
  }[deploy.kind] as StepState;

  return [
    { key: "test", label: "테스트", state: testState, note: testNote },
    { key: "policy", label: "정책", state: policyState, note: policyNote },
    { key: "approval", label: "승인", state: approvalState, note: approvalNote },
    { key: "sign", label: "서명", state: signState, note: signNote },
    { key: "deploy", label: "배포", state: deployState, note: shortDeploy(deploy) },
  ];
}

function shortDeploy(deploy: DeployOutcome): string {
  return {
    activated: "전환됨",
    activated_unrouted: "전환 실패",
    held: "기존 유지",
    rolled_back: "복구됨",
    rolled_back_routing: "복구됨",
    error: "오류",
    running: "진행 중",
    skipped: "생략",
    gate_failed: "시작 안 됨",
    not_started: "-",
    waiting: "-",
  }[deploy.kind];
}

function stateNote(state: StepState): string {
  return {
    done: "완료",
    failed: "실패",
    attention: "확인 필요",
    running: "진행 중",
    waiting: "대기",
    skipped: "생략",
    idle: "-",
  }[state];
}

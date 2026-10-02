import type { DeployResult, Deployment, StageExecution } from "../api/types";
import type { IconName } from "./icons";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export interface DeployOutcome {
  kind:
    | "activated"
    | "activated_unrouted"
    | "held"
    | "rolled_back"
    | "rolled_back_routing"
    | "error"
    | "running"
    | "skipped"
    | "gate_failed"
    | "not_started"
    | "waiting";
  tone: Tone;
  icon: IconName;
  title: string;
  notes: string[];
}

const IN_PROGRESS = ["queued", "running", "awaiting_approval"];

// deploy_result 의 decision 과 routing.result 를 따로 읽음.
// #26 이후 대표 경로 변경 실패는 rolled_back(복구 성공) 또는 error(복구 실패) + routing error 로 남음
export function describeDeploy(
  deployment: Deployment,
  stage: StageExecution | undefined,
  result: DeployResult | null,
): DeployOutcome {
  if (result) return fromResult(deployment, result);

  if (!stage) {
    if (IN_PROGRESS.includes(deployment.status))
      return { kind: "waiting", tone: "neutral", icon: "clock", title: "배포 전", notes: [] };
    return {
      kind: "not_started",
      tone: "neutral",
      icon: "minus",
      title: "배포 시작 안 됨",
      notes: [deployment.status === "blocked" ? "정책에서 차단됨" : "앞 단계에서 멈춤"],
    };
  }
  if (stage.status === "running" || stage.status === "pending")
    return { kind: "running", tone: "info", icon: "spinner", title: "배포 진행 중", notes: [] };
  if (stage.status === "skipped") {
    const reason = (stage.summary as { reason?: unknown } | null)?.reason;
    return {
      kind: "skipped",
      tone: "neutral",
      icon: "minus",
      title: "배포 생략",
      notes: [typeof reason === "string" ? reason : "배포 단계를 실행하지 않음", "실제 배포는 하지 않음"],
    };
  }
  // 결과 파일 없이 실패: 서명·digest 확인 같은 배포 전 검사에서 멈춘 경우
  return {
    kind: "gate_failed",
    tone: "danger",
    icon: "x",
    title: "배포 시작 안 됨 (사전 검사 실패)",
    notes: stage.error ? [stage.error] : [],
  };
}

function rollbackErrors(result: DeployResult) {
  return result.targets.filter((step) => step.phase === "rollback" && step.result === "error");
}

function fromResult(deployment: Deployment, result: DeployResult): DeployOutcome {
  const routing = result.routing.result;
  const notes: string[] = [];
  if (result.error) notes.push(result.error);

  switch (result.decision) {
    case "activated":
      if (routing === "ok" && deployment.deploymentPerformed)
        return { kind: "activated", tone: "success", icon: "check", title: "배포 완료, 트래픽 전환됨", notes };
      if (routing === "ok")
        notes.push("결과는 activated 인데 배포 기록이 완료로 남지 않음");
      else notes.push(result.routing.error ?? result.routing.reason ?? "대표 경로가 예전 대상을 가리킴");
      return {
        kind: "activated_unrouted",
        tone: "warning",
        icon: "alert",
        title: "새 버전은 떴지만 트래픽 전환 실패",
        notes,
      };
    case "held":
      return { kind: "held", tone: "info", icon: "shield", title: "후보 검사 실패, 기존 서비스 유지", notes };
    case "rolled_back":
      if (routing === "error")
        return {
          kind: "rolled_back_routing",
          tone: "warning",
          icon: "undo",
          title: "트래픽 전환 실패, 이전 버전으로 복구",
          notes,
        };
      return { kind: "rolled_back", tone: "warning", icon: "undo", title: "전환 중 실패, 이전 버전으로 복구", notes };
    case "error": {
      for (const step of rollbackErrors(result)) {
        notes.push(
          step.target === "cloud_run"
            ? "Cloud Run이 새 버전을 서빙 중일 수 있음"
            : "On-Prem이 새 버전을 서빙 중일 수 있음",
        );
      }
      return {
        kind: "error",
        tone: "danger",
        icon: "x",
        title: routing === "error" ? "트래픽 전환 실패, 복구도 실패" : "배포 오류",
        notes,
      };
    }
  }
}

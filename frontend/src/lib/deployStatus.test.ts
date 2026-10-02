import { describe, expect, it } from "vitest";
import { describeDeploy } from "./deployStatus";
import { makeDeployment, makeResult, makeStage } from "./test-fixtures";

describe("describeDeploy", () => {
  it("activated + routing ok 만 배포 완료", () => {
    const outcome = describeDeploy(makeDeployment(), makeStage(), makeResult());
    expect(outcome.kind).toBe("activated");
    expect(outcome.tone).toBe("success");
  });

  it("activated + routing error 는 성공처럼 보이면 안 됨", () => {
    const outcome = describeDeploy(
      makeDeployment(),
      makeStage(),
      makeResult({ routing: { result: "error", error: "revision mismatch" } }),
    );
    expect(outcome.kind).toBe("activated_unrouted");
    expect(outcome.tone).not.toBe("success");
    expect(outcome.title).toContain("트래픽 전환 실패");
    expect(outcome.notes).toContain("revision mismatch");
  });

  it("activated 인데 deploymentPerformed false 면 완료로 보지 않음", () => {
    const outcome = describeDeploy(makeDeployment({ deploymentPerformed: false }), makeStage(), makeResult());
    expect(outcome.tone).not.toBe("success");
  });

  it("held + skipped 는 기존 서비스 유지", () => {
    const outcome = describeDeploy(
      makeDeployment({ status: "failed", deploymentPerformed: false }),
      makeStage({ status: "failed" }),
      makeResult({ decision: "held", routing: { result: "skipped" } }),
    );
    expect(outcome.kind).toBe("held");
    expect(outcome.title).toContain("기존 서비스 유지");
  });

  it("rolled_back + skipped 는 전환 중 실패 복구", () => {
    const outcome = describeDeploy(
      makeDeployment({ status: "failed", deploymentPerformed: false }),
      makeStage({ status: "failed" }),
      makeResult({ decision: "rolled_back", routing: { result: "skipped" } }),
    );
    expect(outcome.kind).toBe("rolled_back");
  });

  it("rolled_back + routing error 는 #26 의 경로 변경 실패 복구", () => {
    const outcome = describeDeploy(
      makeDeployment({ status: "failed", deploymentPerformed: false }),
      makeStage({ status: "failed" }),
      makeResult({ decision: "rolled_back", routing: { result: "error", error: "boom" } }),
    );
    expect(outcome.kind).toBe("rolled_back_routing");
  });

  it("error + Cloud Run rollback 실패면 새 버전 서빙 가능성 경고", () => {
    const outcome = describeDeploy(
      makeDeployment({ status: "failed", deploymentPerformed: false }),
      makeStage({ status: "failed" }),
      makeResult({
        decision: "error",
        routing: { result: "skipped" },
        targets: [{ target: "cloud_run", phase: "rollback", result: "error", error: "x" }],
      }),
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.notes).toContain("Cloud Run이 새 버전을 서빙 중일 수 있음");
  });

  it("error + skipped, rollback 없음이면 경고 없이 오류", () => {
    const outcome = describeDeploy(
      makeDeployment({ status: "failed", deploymentPerformed: false }),
      makeStage({ status: "failed" }),
      makeResult({ decision: "error", routing: { result: "skipped" }, error: "GCP_PROJECT_ID is not set" }),
    );
    expect(outcome.title).toBe("배포 오류");
    expect(outcome.notes).toEqual(["GCP_PROJECT_ID is not set"]);
  });

  it("deploy_result 없이 skipped 단계는 배포 생략, 배포됨이라고 하지 않음", () => {
    const outcome = describeDeploy(
      makeDeployment({ deploymentPerformed: false }),
      makeStage({ status: "skipped", summary: { mode: "off", reason: "실제 배포 조율기를 호출하지 않음" } }),
      null,
    );
    expect(outcome.kind).toBe("skipped");
    expect(outcome.title).not.toContain("배포됨");
    expect(outcome.notes[0]).toBe("실제 배포 조율기를 호출하지 않음");
  });

  it("deploy_result 없이 실패한 단계는 사전 검사 실패", () => {
    const outcome = describeDeploy(
      makeDeployment({ status: "failed", deploymentPerformed: false }),
      makeStage({ status: "failed", error: "Real deploy requires a registry image digest" }),
      null,
    );
    expect(outcome.kind).toBe("gate_failed");
    expect(outcome.notes).toEqual(["Real deploy requires a registry image digest"]);
  });

  it("단계가 없고 차단이면 시작 안 됨", () => {
    const outcome = describeDeploy(makeDeployment({ status: "blocked", decision: "block" }), undefined, null);
    expect(outcome.kind).toBe("not_started");
  });
});

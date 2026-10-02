import { describe, expect, it } from "vitest";
import { parseArtifact, pickArtifact } from "./artifacts";
import { makeArtifact } from "./test-fixtures";

describe("pickArtifact / parseArtifact", () => {
  const artifacts = [
    makeArtifact({ id: "p1", stageExecutionId: "policy-1", name: "plan", content: '{"decision":"block"}' }),
    makeArtifact({ id: "p2", stageExecutionId: "policy-2", name: "plan", content: '{"decision":"allow"}' }),
    makeArtifact({ id: "bad", stageExecutionId: "sign-1", name: "sign_result", content: "{oops" }),
    makeArtifact({ id: "log", stageExecutionId: "sign-1", name: "audit_log", mediaType: "text/plain", content: "x" }),
  ];

  it("같은 이름이 여러 개면 마지막(최신 시도)", () => {
    expect(pickArtifact(artifacts, "plan")?.id).toBe("p2");
  });

  it("시도 id 를 주면 그 시도 것만", () => {
    expect(pickArtifact(artifacts, "plan", ["policy-1"])?.id).toBe("p1");
    expect(pickArtifact(artifacts, "plan", [])).toBeNull();
  });

  it("content 원문을 JSON 으로 읽음", () => {
    expect(parseArtifact<{ decision: string }>(artifacts, "plan").data).toEqual({ decision: "allow" });
  });

  it("없으면 data·error 모두 null", () => {
    expect(parseArtifact(artifacts, "deploy_result")).toEqual({ artifact: null, data: null, error: null });
  });

  it("깨진 JSON 은 error 로", () => {
    const parsed = parseArtifact(artifacts, "sign_result");
    expect(parsed.data).toBeNull();
    expect(parsed.error).toBeTruthy();
  });

  it("서버가 남긴 validationError 를 그대로 전달", () => {
    const parsed = parseArtifact(
      [makeArtifact({ validationError: "plan does not match the current deployment" })],
      "plan",
    );
    expect(parsed.error).toBe("plan does not match the current deployment");
  });
});

import { describe, expect, it } from "vitest";
import { makeStage } from "./test-fixtures";
import { latestAttempts } from "./stages";

describe("latestAttempts", () => {
  it("단계마다 attempt 가 가장 큰 행만 남김", () => {
    const latest = latestAttempts([
      makeStage({ id: "t1", stage: "test", attempt: 1 }),
      makeStage({ id: "s2", stage: "sign", attempt: 2, status: "succeeded" }),
      makeStage({ id: "s1", stage: "sign", attempt: 1, status: "failed" }),
      makeStage({ id: "s3", stage: "sign", attempt: 3, status: "running" }),
    ]);
    expect(latest.test?.id).toBe("t1");
    expect(latest.sign?.id).toBe("s3");
    expect(latest.deploy).toBeUndefined();
  });

  it("빈 목록이면 빈 객체", () => {
    expect(latestAttempts([])).toEqual({});
  });
});

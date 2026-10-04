import { describe, it, expect } from "vitest";
import { prepareSettingsEnvironment } from "./settings";
describe("deployment settings environment", () => {
  it("keeps stored secrets when the field is untouched and sends only replacement values", () => {
    expect(
      prepareSettingsEnvironment([
        { name: "SECRET", value: "", stored: true },
        { name: "LOG_LEVEL", value: "info", stored: true },
        { name: "NEW_KEY", value: "value", stored: false },
      ]),
    ).toEqual([
      { name: "SECRET" },
      { name: "LOG_LEVEL", value: "info" },
      { name: "NEW_KEY", value: "value" },
    ]);
  });
  it("rejects duplicate, reserved and incomplete new variables", () => {
    expect(() =>
      prepareSettingsEnvironment([
        { name: "PORT", value: "8080", stored: false },
      ]),
    ).toThrow();
    expect(() =>
      prepareSettingsEnvironment([{ name: "NEW", value: "", stored: false }]),
    ).toThrow();
    expect(() =>
      prepareSettingsEnvironment([
        { name: "KEY", value: "", stored: true },
        { name: "KEY", value: "x", stored: false },
      ]),
    ).toThrow();
  });
});

import { settingsDeploymentRevision } from "./settings";
it("redeploys the routed commit instead of the latest cancelled commit", () => {
  const deployments = [
    { id: "v3", sourceRevision: "cancelled" },
    { id: "v2", sourceRevision: "serving" },
  ];
  expect(settingsDeploymentRevision(deployments, "v2")).toBe("serving");
  expect(() => settingsDeploymentRevision(deployments)).toThrow(
    "현재 서비스 배포가 없습니다",
  );
  expect(() => settingsDeploymentRevision(deployments, "missing")).toThrow();
});

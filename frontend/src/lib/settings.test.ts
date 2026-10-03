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

import { describe, expect, it } from "vitest";
import { parsePastedTokens } from "./session";

describe("parsePastedTokens", () => {
  it("콜백 JSON 전체에서 두 토큰을 꺼냄", () => {
    expect(parsePastedTokens('{"access_token":"a","refresh_token":"r","user":{}}', "")).toEqual({
      accessToken: "a",
      refreshToken: "r",
    });
  });

  it("access 만 붙여넣으면 refresh 는 따로 받은 값", () => {
    expect(parsePastedTokens(" Bearer abc ", " ref ")).toEqual({ accessToken: "abc", refreshToken: "ref" });
    expect(parsePastedTokens("abc", "")).toEqual({ accessToken: "abc", refreshToken: null });
  });

  it("빈 값·깨진 JSON 은 null", () => {
    expect(parsePastedTokens("", "")).toBeNull();
    expect(parsePastedTokens("{nope", "")).toBeNull();
  });
});

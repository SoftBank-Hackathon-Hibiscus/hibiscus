/**
 * 루트 contracts/ (팀 공개 계약) 에 복사해 둔 policy 소유 스키마가 policy/contracts/ (생성 원본) 와 같은지.
 *
 * 구현 원본은 src/schema.ts 이고, policy/contracts/ 는 npm run contracts 가 만든다 (contracts.test.ts 가 최신인지 확인).
 * 루트 contracts/ 는 그 파일을 바이트 그대로 복사한 공개본이라, 둘이 다르면 "복사가 빠졌다" 는 뜻이다.
 * signer 소유 파일(SignResult, SignLog)은 여기서 검사하지 않는다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const POLICY_ROOT = join(import.meta.dirname, "..");
const ROOT_CONTRACTS = join(POLICY_ROOT, "..", "contracts");
const POLICY_CONTRACTS = join(POLICY_ROOT, "contracts");

/** 루트 contracts/ 에 공개한 policy 소유 스키마 */
const PUBLISHED = ["Plan", "RollbackRequest", "RollbackPlan", "DecisionLog"] as const;

/** 줄바꿈만 다른 것은 같은 내용으로 본다 (core.autocrlf=true 체크아웃에서 CRLF 로 바뀔 수 있다) */
const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

describe("루트 contracts/ 의 policy 스키마 복사본", () => {
  it.each(PUBLISHED)("%s.schema.json 이 policy/contracts/ 와 같다 (다르면 policy/contracts/ 에서 다시 복사)", (name) => {
    const file = `${name}.schema.json`;
    const published = join(ROOT_CONTRACTS, file);
    const source = join(POLICY_CONTRACTS, file);
    expect(existsSync(published), `${published} 없음. policy/contracts/${file} 을 루트 contracts/ 로 복사하세요`).toBe(true);
    expect(normalizeEol(readFileSync(published, "utf8")), `contracts/${file} 가 policy/contracts/${file} 과 다름. 다시 복사하세요`).toBe(
      normalizeEol(readFileSync(source, "utf8")),
    );
  });

  it("복사본도 올바른 JSON 이다", () => {
    for (const name of PUBLISHED) {
      const parsed = JSON.parse(readFileSync(join(ROOT_CONTRACTS, `${name}.schema.json`), "utf8")) as Record<string, unknown>;
      expect(parsed.$id).toBe(`${name}.schema.json`);
      expect(parsed.title).toBe(name);
    }
  });
});

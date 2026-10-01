// 루트 contracts/ 에 공개한 signer 소유 스키마가 signer/contracts/ 와 같은지 (다르면 루트에 복사가 빠진 것)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_DIR } from "../src/contracts.js";

const ROOT_CONTRACTS = join(CONTRACTS_DIR, "..", "..", "contracts");
const PUBLISHED = ["SignResult", "SignLog"] as const;
const normalizeEol = (text: string) => text.replace(/\r\n/g, "\n");

describe("루트 contracts/", () => {
  it.each(PUBLISHED)("%s.schema.json 이 signer/contracts 와 같음", (name) => {
    const root = readFileSync(join(ROOT_CONTRACTS, `${name}.schema.json`), "utf8");
    const own = readFileSync(join(CONTRACTS_DIR, `${name}.schema.json`), "utf8");
    expect(normalizeEol(root)).toBe(normalizeEol(own));
  });
});

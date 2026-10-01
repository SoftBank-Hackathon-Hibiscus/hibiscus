import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS, CONTRACTS_DIR, renderSchema } from "../src/contracts.js";

describe("contracts/", () => {
  it.each(CONTRACTS.map((c) => [c.name, c] as const))("%s.schema.json 이 src/schema.ts 와 같음 (다르면 npm run contracts)", (name, contract) => {
    expect(readFileSync(join(CONTRACTS_DIR, `${name}.schema.json`), "utf8")).toBe(renderSchema(contract));
  });
});

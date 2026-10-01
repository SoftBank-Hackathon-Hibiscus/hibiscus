// npm run contracts: src/schema.ts 로 contracts/*.schema.json 생성
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS, CONTRACTS_DIR, renderSchema } from "../src/contracts.js";

mkdirSync(CONTRACTS_DIR, { recursive: true });
for (const contract of CONTRACTS) {
  writeFileSync(join(CONTRACTS_DIR, `${contract.name}.schema.json`), renderSchema(contract), "utf8");
  console.log(`wrote contracts/${contract.name}.schema.json`);
}

/**
 * contracts/ 를 생성한다: 계약 6개의 JSON Schema + README.md
 *
 *   npm run contracts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS, type JsonSchema, ROOT, renderReadme, schemaFileName, toJsonSchema } from "../src/contracts.js";

const outDir = join(ROOT, "contracts");
mkdirSync(outDir, { recursive: true });

const schemas = new Map<string, JsonSchema>();
for (const contract of CONTRACTS) {
  const schema = toJsonSchema(contract);
  schemas.set(contract.name, schema);
  const file = join(outDir, schemaFileName(contract));
  writeFileSync(file, JSON.stringify(schema, null, 2) + "\n", "utf8");
  console.log(`wrote contracts/${schemaFileName(contract)}`);
}

writeFileSync(join(outDir, "README.md"), renderReadme(CONTRACTS, schemas), "utf8");
console.log("wrote contracts/README.md");

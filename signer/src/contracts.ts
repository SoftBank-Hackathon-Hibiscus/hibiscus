// contracts/*.schema.json 생성용. 손으로 고치지 말고 npm run contracts
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuditAnchorSchema } from "./anchor.js";
import { DeployPredicateSchema } from "./attestation.js";
import { ApprovalSchema, AuditLineSchema, ObservedSchema, SignLogSchema, SignResultSchema } from "./schema.js";

export const CONTRACTS_DIR = fileURLToPath(new URL("../contracts/", import.meta.url));

export const CONTRACTS = [
  { name: "SignResult", schema: SignResultSchema },
  { name: "SignLog", schema: SignLogSchema },
  { name: "Approval", schema: ApprovalSchema },
  { name: "AuditLine", schema: AuditLineSchema },
  { name: "DeployAttestation", schema: DeployPredicateSchema },
  { name: "AuditAnchor", schema: AuditAnchorSchema },
  { name: "Observed", schema: ObservedSchema },
] as const;

export function toJsonSchema(contract: (typeof CONTRACTS)[number]): Record<string, unknown> {
  const schema = z.toJSONSchema(contract.schema, { target: "draft-2020-12", io: "output", unrepresentable: "any" });
  return { $id: `${contract.name}.schema.json`, title: contract.name, ...schema };
}

export function renderSchema(contract: (typeof CONTRACTS)[number]): string {
  return JSON.stringify(toJsonSchema(contract), null, 2) + "\n";
}

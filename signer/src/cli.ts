// approve / sign 명령. 종료 코드 0 서명 / 1 거절 / 2 오류
import { parseArgs } from "node:util";
import { createApproval } from "./approval.js";
import { CosignSigner, DryRunSigner } from "./cosign.js";
import { SignerError, writeJson } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { runSign } from "./sign.js";

const USAGE = `사용법
  npx tsx src/cli.ts approve --plan <plan.json> --requester <id> --approver <id> [--out approval.json]
  npx tsx src/cli.ts sign --plan <plan.json> --requester <id> [--approval <approval.json>]
                          --image-repo <저장소> (--key <cosign.key> [--no-tlog] | --dry-run)
                          [--out sign_result.json] [--log decisions.jsonl] [--plan-schema <Plan.schema.json>]

  --image-repo  태그 없는 이미지 저장소 (예: asia-northeast3-docker.pkg.dev/<프로젝트>/<저장소>/<이미지>). 없으면 IMAGE_REPO 환경변수
  --key         cosign 개인키 경로. 없으면 SIGNER_COSIGN_KEY 환경변수. 비밀번호는 COSIGN_PASSWORD 환경변수
  --no-tlog     Rekor 에 안 올리고 서명 (Rekor 장애 대비). 배포 쪽 verify 에도 --insecure-ignore-tlog=true 필요
  --dry-run     cosign 을 부르지 않고 signature_ref 를 dry-run:... 으로 채움 (연결 확인용, 실제 배포에 쓰지 말 것)

종료 코드: 0 서명함 / 1 서명 거절 / 2 실행 오류`;

function required(value: string | undefined, name: string): string {
  if (!value) throw new SignerError("ARG_MISSING", `--${name} 가 필요함\n\n${USAGE}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      plan: { type: "string" },
      requester: { type: "string" },
      approver: { type: "string" },
      approval: { type: "string" },
      "image-repo": { type: "string" },
      key: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-tlog": { type: "boolean", default: false },
      out: { type: "string" },
      log: { type: "string" },
      "plan-schema": { type: "string" },
    },
  });
  const planSchema = values["plan-schema"] ?? DEFAULT_PLAN_SCHEMA;

  if (command === "approve") {
    const loaded = loadPlan(required(values.plan, "plan"), planSchema);
    const approval = createApproval(loaded, required(values.requester, "requester"), required(values.approver, "approver"), new Date());
    const out = values.out ?? "approval.json";
    writeJson(out, approval);
    console.log(`[signer] 승인 기록 저장: ${out} (run_id=${approval.run_id}, approver=${approval.approver})`);
    return 0;
  }

  if (command === "sign") {
    const dryRun = values["dry-run"] === true;
    const noTlog = values["no-tlog"] === true;
    const signer = dryRun
      ? new DryRunSigner()
      : new CosignSigner(required(values.key ?? process.env.SIGNER_COSIGN_KEY, "key"), "cosign", { noTlog });
    const out = values.out ?? "sign_result.json";
    const outcome = await runSign({
      planPath: required(values.plan, "plan"),
      requester: required(values.requester, "requester"),
      ...(values.approval ? { approvalPath: values.approval } : {}),
      imageRepo: required(values["image-repo"] ?? process.env.IMAGE_REPO, "image-repo"),
      outPath: out,
      logPath: values.log ?? "decisions.jsonl",
      signer,
      planSchemaPath: planSchema,
    });
    if (outcome.code === 0) {
      const r = outcome.result;
      console.log(`[signer] 서명함 run_id=${r.run_id} digest=${r.digest}`);
      console.log(`  targets  : ${r.targets.join(", ")}`);
      console.log(`  approver : ${r.approver}`);
      console.log(`  signature: ${r.signature_ref}${dryRun ? "  (시험 실행)" : noTlog ? "  (Rekor 없이)" : ""}`);
      console.log(`  저장     : ${out}`);
    } else {
      console.error(`[signer] 서명 안 함 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof SignerError) console.error(`[signer] 오류 ${e.code}: ${e.message}`);
    else console.error(`[signer] 오류: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);

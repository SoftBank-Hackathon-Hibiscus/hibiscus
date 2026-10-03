// approve / sign / verify / audit 명령. 종료 코드 0 서명·확인 / 1 거절·확인 실패 / 2 오류
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { createApproval } from "./approval.js";
import { CosignSigner, CosignVerifier, DryRunSigner, isKmsKey } from "./cosign.js";
import { SignerError, writeJson } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { checkPublicKeyPin, publicKeyFingerprint } from "./keys.js";
import { runSign } from "./sign.js";
import { DEFAULT_PUBLIC_KEY, runAuditVerify, runVerify } from "./verify.js";

const USAGE = `사용법
  npx tsx src/cli.ts approve --plan <plan.json> --requester <id> --approver <id> [--out approval.json]
  npx tsx src/cli.ts sign --plan <plan.json> --requester <id> [--approval <approval.json>]
                          --image-repo <저장소> (--key <cosign.key> [--no-tlog] | --dry-run)
                          [--out sign_result.json] [--log decisions.jsonl] [--audit <감사 로그>] [--approval-ttl <분>]
                          [--plan-schema <Plan.schema.json>]
  npx tsx src/cli.ts verify --result <sign_result.json> [--plan <plan.json>] [--audit <감사 로그>] [--image-repo <저장소>]
                            [--pub <cosign.pub>] [--no-tlog] [--plan-schema <Plan.schema.json>]
  npx tsx src/cli.ts audit --audit <감사 로그> [--images [--image-repo <저장소>] [--pub <cosign.pub>] [--no-tlog]]
  npx tsx src/cli.ts fingerprint [--pub <cosign.pub>] [--pubkey-sha256 <지문>]

  --image-repo  태그 없는 이미지 저장소 (예: asia-northeast3-docker.pkg.dev/<프로젝트>/<저장소>/<이미지>). 없으면 IMAGE_REPO 환경변수
  --key         cosign 개인키 경로 또는 KMS 키 주소(gcpkms://...). 없으면 SIGNER_COSIGN_KEY 환경변수. 비밀번호는 COSIGN_PASSWORD 환경변수 (KMS 는 필요 없음)
  --no-tlog     Rekor 에 안 올리고 서명 (Rekor 장애 대비). 없으면 SIGNER_NO_TLOG=1 환경변수
                배포 쪽 verify 에도 --insecure-ignore-tlog=true 필요
  --dry-run     cosign 을 부르지 않고 signature_ref 를 dry-run:... 으로 채움 (연결 확인용, 실제 배포에 쓰지 말 것)
  --audit       서명 감사 로그(해시 체인) 경로. 없으면 SIGNER_AUDIT_LOG 환경변수, 둘 다 없으면 안 씀
  --self-verify 서명 직후 공개키(--pub)로 바로 다시 확인. 실패하면 sign_result 안 남김. 없으면 SIGNER_SELF_VERIFY=1
  --pubkey-sha256 공개키 지문 고정. 확인에 쓰는 공개키가 이 지문과 다르면 멈춤. 없으면 SIGNER_PUBKEY_SHA256
  --approval-ttl 승인 유효시간(분). 승인한 지 이보다 오래되면 서명 안 함 (approval_expired). 없으면 SIGNER_APPROVAL_TTL_MIN 환경변수, 둘 다 없으면 시간은 안 봄

  verify        sign_result.json 의 targets·approver 등이 서명된 값 그대로인지 cosign verify 로 확인
  --plan        plan 내용과 plan 파일 해시까지 확인
  --pub         cosign 공개키 경로 또는 KMS 키 주소. 없으면 COSIGN_PUBLIC_KEY 환경변수, 그것도 없으면 keys/cosign.pub
  --no-tlog     Rekor 없이 서명한 이미지 확인 (cosign verify --insecure-ignore-tlog=true)

  audit         감사 로그가 처음부터 끝까지 이어지는지 확인. 끊긴 첫 줄 번호를 알려줌
  --images      레지스트리 서명과 맞춰 봄: signed 줄마다 맞는 서명이 있는지, audit_head 가 붙은 서명이 전부 로그에 있는지
                (체인을 통째로 다시 계산하거나 signed 줄을 지우거나 거절로 바꾼 것도 잡음). 거절 줄 digest 는 --image-repo 저장소에서 찾음

종료 코드: 0 서명함·확인함 / 1 서명 거절·확인 실패 / 2 실행 오류`;

function required(value: string | undefined, name: string): string {
  if (!value) throw new SignerError("ARG_MISSING", `--${name} 가 필요함\n\n${USAGE}`);
  return value;
}

/** 분 단위 양수 → ms. 없으면 undefined */
function minutes(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new SignerError("ARG_INVALID", `--${name} 는 0 보다 큰 분 단위 숫자여야 함: ${value}`);
  return n * 60_000;
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
      result: { type: "string" },
      pub: { type: "string" },
      audit: { type: "string" },
      images: { type: "boolean", default: false },
      "approval-ttl": { type: "string" },
      "pubkey-sha256": { type: "string" },
      "self-verify": { type: "boolean", default: false },
    },
  });
  const planSchema = values["plan-schema"] ?? DEFAULT_PLAN_SCHEMA;
  const noTlog = values["no-tlog"] === true || process.env.SIGNER_NO_TLOG === "1";
  // 빈 환경변수는 없는 것으로 봄 (backend 기본값이 '' 인 경우가 있음)
  // 빈 플래그(--audit "")도 없는 것으로 봄
  const auditPath = values.audit || process.env.SIGNER_AUDIT_LOG || undefined;
  const pub = values.pub || process.env.COSIGN_PUBLIC_KEY || DEFAULT_PUBLIC_KEY;
  const pinnedPub = values["pubkey-sha256"] || process.env.SIGNER_PUBKEY_SHA256 || undefined;
  // 확인에 쓸 공개키. 지문을 고정했으면 다른 키로는 확인하지 않음
  const trustedPub = (): string => {
    if (pinnedPub !== undefined) checkPublicKeyPin(pub, pinnedPub);
    return pub;
  };

  if (command === "approve") {
    const loaded = loadPlan(required(values.plan, "plan"), planSchema);
    const approval = createApproval(loaded, required(values.requester, "requester"), required(values.approver, "approver"), new Date());
    const out = values.out ?? "approval.json";
    writeJson(out, approval);
    console.log(`[signer] 승인 기록 저장: ${out} (run_id=${approval.run_id}, approver=${approval.approver})`);
    return 0;
  }

  if (command === "sign") {
    // 인자 검사 전에 지움. 인자 오류로 끝나도 예전 결과가 남지 않게
    const out = values.out ?? "sign_result.json";
    rmSync(out, { force: true });
    const dryRun = values["dry-run"] === true;
    const approvalTtlMs = minutes(values["approval-ttl"] || process.env.SIGNER_APPROVAL_TTL_MIN, "approval-ttl");
    const signer = dryRun
      ? new DryRunSigner()
      : new CosignSigner(required(values.key ?? process.env.SIGNER_COSIGN_KEY, "key"), "cosign", { noTlog });
    // 시험 실행은 실제 서명이 없어서 자기 확인을 안 함. 지문 확인은 서명 전에 끝냄
    const selfVerify = !dryRun && (values["self-verify"] === true || process.env.SIGNER_SELF_VERIFY === "1");
    const selfVerifier = selfVerify ? new CosignVerifier(trustedPub(), "cosign", { noTlog }) : undefined;
    const outcome = await runSign({
      planPath: required(values.plan, "plan"),
      requester: required(values.requester, "requester"),
      ...(values.approval ? { approvalPath: values.approval } : {}),
      imageRepo: required(values["image-repo"] ?? process.env.IMAGE_REPO, "image-repo"),
      outPath: out,
      logPath: values.log ?? "decisions.jsonl",
      signer,
      planSchemaPath: planSchema,
      ...(auditPath !== undefined ? { auditPath } : {}),
      ...(approvalTtlMs !== undefined ? { approvalTtlMs } : {}),
      ...(selfVerifier !== undefined ? { selfVerifier } : {}),
    });
    if (outcome.code === 0) {
      const r = outcome.result;
      console.log(`[signer] 서명함 run_id=${r.run_id} digest=${r.digest}`);
      console.log(`  targets  : ${r.targets.join(", ")}`);
      console.log(`  approver : ${r.approver}`);
      console.log(`  signature: ${r.signature_ref}${dryRun ? "  (시험 실행)" : noTlog ? "  (Rekor 없이)" : ""}`);
      console.log(`  저장     : ${out}`);
      if (auditPath !== undefined) console.log(`  감사 로그: ${auditPath}`);
      if (selfVerifier !== undefined) console.log(`  자기 확인: 통과 (${pub})`);
    } else {
      console.error(`[signer] 서명 안 함 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  if (command === "verify") {
    const imageRepo = values["image-repo"] || process.env.IMAGE_REPO || undefined;
    const outcome = await runVerify({
      resultPath: required(values.result, "result"),
      verifier: new CosignVerifier(trustedPub(), "cosign", { noTlog }),
      ...(imageRepo !== undefined ? { imageRepo } : {}),
      ...(values.plan !== undefined ? { planPath: values.plan } : {}),
      planSchemaPath: planSchema,
      ...(auditPath !== undefined ? { auditPath } : {}),
    });
    if (outcome.code === 0) {
      const r = outcome.result;
      console.log(`[signer] 서명 확인함 run_id=${r.run_id} digest=${r.digest}`);
      console.log(`  targets  : ${r.targets.join(", ")}`);
      console.log(`  approver : ${r.approver}`);
      console.log(`  확인한 주석: ${Object.keys(outcome.annotations).join(", ")}`);
      if (!isKmsKey(pub)) console.log(`  공개키 지문: sha256:${publicKeyFingerprint(pub)}${pinnedPub !== undefined ? " (고정값과 같음)" : ""}`);
    } else {
      console.error(`[signer] 서명 확인 실패 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  if (command === "audit") {
    const imageRepo = values["image-repo"] || process.env.IMAGE_REPO || undefined;
    const outcome = await runAuditVerify({
      auditPath: required(auditPath, "audit"),
      ...(values.images === true ? { verifier: new CosignVerifier(trustedPub(), "cosign", { noTlog }) } : {}),
      ...(imageRepo !== undefined ? { imageRepo } : {}),
    });
    if (outcome.code === 0) {
      console.log(`[signer] 감사 로그 이상 없음: ${outcome.lines}줄, head=${outcome.head}`);
      if (values.images === true) console.log(`  이미지 ${outcome.images}개 확인: signed 줄 ${outcome.signed}개 모두 서명과 일치, 로그에 없는 서명 없음`);
    } else {
      const where = outcome.line > 0 ? `${outcome.line}번째 줄` : "";
      console.error(`[signer] 감사 로그 ${where}${where ? " " : ""}문제 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  if (command === "fingerprint") {
    const fingerprint = pinnedPub !== undefined ? checkPublicKeyPin(pub, pinnedPub) : publicKeyFingerprint(pub);
    console.log(`sha256:${fingerprint}  ${pub}${pinnedPub !== undefined ? "  (고정값과 같음)" : ""}`);
    return 0;
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

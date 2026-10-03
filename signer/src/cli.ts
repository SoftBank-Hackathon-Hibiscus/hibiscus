// approve / sign / verify / audit 명령. 종료 코드 0 서명·확인 / 1 거절·확인 실패 / 2 오류
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createApproval } from "./approval.js";
import { CosignSigner, CosignVerifier, DryRunSigner, isKmsKey, MultiKeyVerifier, type BlobVerifier, type ImageVerifier } from "./cosign.js";
import { runAnchor } from "./anchor.js";
import { runRevoke } from "./revoke.js";
import { CraneLister } from "./registry.js";
import { runReconcile } from "./reconcile.js";
import { SignerError, writeJson } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { checkPublicKeyPins, looseKeyPermissions, publicKeyFingerprint, readPolicy } from "./keys.js";
import { DEFAULT_POLICY } from "./attestation.js";
import { runSign } from "./sign.js";
import { DEFAULT_PUBLIC_KEY, runAuditVerify, runVerify } from "./verify.js";

const USAGE = `사용법
  npx tsx src/cli.ts approve --plan <plan.json> --requester <id> --approver <id> [--out approval.json]
  npx tsx src/cli.ts sign --plan <plan.json> --requester <id> [--approval <approval.json>]
                          --image-repo <저장소> (--key <cosign.key> [--no-tlog] | --dry-run)
                          [--out sign_result.json] [--log decisions.jsonl] [--audit <감사 로그>] [--approval-ttl <분>]
                          [--self-verify] [--attest [--test-result <test_result.json>]] [--minimal-env]
                          [--pub <cosign.pub>] [--pubkey-sha256 <지문>] [--plan-schema <Plan.schema.json>]
  npx tsx src/cli.ts verify --result <sign_result.json> [--plan <plan.json>] [--approval <approval.json>] [--audit <감사 로그>] [--image-repo <저장소>]
                            [--attestation [--policy <deploy.rego>] [--policy-sha256 <지문>] [--test-result <test_result.json>]] [--max-age <분>] [--json]
                            [--latest] [--pub <cosign.pub>] [--pubkey-sha256 <지문>] [--no-tlog] [--plan-schema <Plan.schema.json>]
  npx tsx src/cli.ts audit --audit <감사 로그> [--anchors <고정값 파일>] [--images [--strict-images] [--image-repo <저장소>]
                           [--sweep [--sweep-max <N>]] [--digests-file <파일>]] [--json] [--pub <cosign.pub>] [--no-tlog]
  npx tsx src/cli.ts fingerprint [--pub <cosign.pub>] [--pubkey-sha256 <지문>] | --policy <정책.rego> [--policy-sha256 <지문>]
  npx tsx src/cli.ts anchor --audit <감사 로그> [--anchors <고정값 파일>] (--key <cosign.key>) [--no-tlog]
  npx tsx src/cli.ts reconcile --observed <observed.jsonl> --audit <감사 로그> [--anchors <고정값 파일>] [--json] [--pub <cosign.pub>] [--no-tlog]
  npx tsx src/cli.ts revoke --audit <감사 로그> --digest <sha256:…> [--run-id <id>] --reason <vulnerability|policy_changed|key_compromise|mistake>
                            --by <id> [--note <메모>] [--anchors <고정값 파일> --key <cosign.key>]

  --image-repo  태그 없는 이미지 저장소 (예: asia-northeast3-docker.pkg.dev/<프로젝트>/<저장소>/<이미지>). 없으면 IMAGE_REPO 환경변수
  --key         cosign 개인키 경로 또는 KMS 키 주소(gcpkms://...). 없으면 SIGNER_COSIGN_KEY 환경변수. 비밀번호는 COSIGN_PASSWORD 환경변수 (KMS 는 필요 없음)
  --no-tlog     Rekor 에 안 올리고 서명 (Rekor 장애 대비). 없으면 SIGNER_NO_TLOG=1 환경변수
                배포 쪽 verify 에도 --insecure-ignore-tlog=true 필요
  --dry-run     cosign 을 부르지 않고 signature_ref 를 dry-run:... 으로 채움 (연결 확인용, 실제 배포에 쓰지 말 것)
  --audit       서명 감사 로그(해시 체인) 경로. 없으면 SIGNER_AUDIT_LOG 환경변수, 둘 다 없으면 안 씀
  --attest      배포 증명서(in-toto attestation)도 이미지에 붙임. 없으면 SIGNER_ATTEST=1
  --test-result 시험 결과(test_result.json)를 증명서에 넣음 (sign). verify --attestation 에서는 이 시험 결과로 서명했는지 확인
  --minimal-env cosign 에 필요한 환경변수만 넘김 (backend 의 다른 비밀값이 cosign 으로 안 가게). 없으면 SIGNER_MINIMAL_ENV=1
  --self-verify 서명 직후 공개키(--pub)로 바로 다시 확인. 실패하면 sign_result 안 남김. 없으면 SIGNER_SELF_VERIFY=1
  --pubkey-sha256 공개키 지문 고정 (여러 번 가능). 확인에 쓰는 공개키가 이 목록에 없으면 멈춤. 없으면 SIGNER_PUBKEY_SHA256(쉼표로 여러 개)
  --approval-ttl 승인 유효시간(분). 승인한 지 이보다 오래되면 서명 안 함 (approval_expired). 없으면 SIGNER_APPROVAL_TTL_MIN 환경변수, 둘 다 없으면 시간은 안 봄

  verify        sign_result.json 의 targets·approver 등이 서명된 값 그대로인지 cosign verify 로 확인
  --plan        plan 내용과 plan 파일 해시까지 확인
  --approval    이 승인 기록(누가, 언제 승인)으로 서명했는지까지 확인
  --max-age     서명한 지 이 시간(분)이 지난 결과는 거부 (expired). 없으면 SIGNER_MAX_AGE_MIN
  --json        결과를 JSON 한 줄로 출력 (실행 오류도)
  --latest      --audit 와 같이: 이 결과 뒤에 같은 저장소·겹치는 배포 위치로 더 새로 서명한 결과가 있거나 같은 이미지가 block 됐으면 거부
                (superseded, 예전 결과 재사용·몰래 롤백). 없으면 SIGNER_VERIFY_LATEST=1

  reconcile     실제 배포 상태(관측 파일, contracts/Observed.schema.json)가 서명된 그대로인지 확인. 이미지마다 감사 로그 기록,
                기록과 정확히 같은 서명, 철회 여부, 서명한 배포 위치를 봄. 관측 파일은 운영자가 아닌 사람이 만들어야 의미 있음
  revoke        서명 철회 줄을 감사 로그에 추가. 그 서명은 verify --audit 에서 revoked, --run-id 없이 이미지 전체를 철회하면 다시 서명도 안 함
  --attestation 배포 증명서도 확인 (서명·내용이 sign_result 와 같은지 + Rego 정책). 정책 기본값은 policy/deploy.rego
  --policy-sha256 Rego 정책 파일 지문 고정 (여러 번 가능). 정책 파일이 이 목록에 없으면 멈춤. 없으면 SIGNER_POLICY_SHA256(쉼표로 여러 개)
  --pub         cosign 공개키 경로 또는 KMS 키 주소. 키 교체 중이면 여러 번 (아무 키로나 확인되면 통과).
                없으면 COSIGN_PUBLIC_KEY 환경변수(쉼표로 여러 개), 그것도 없으면 keys/cosign.pub
  --no-tlog     Rekor 없이 서명한 이미지 확인 (cosign verify --insecure-ignore-tlog=true)

  audit         감사 로그가 처음부터 끝까지 이어지는지 확인. 끊긴 첫 줄 번호를 알려줌
  --anchors     감사 로그 끝 고정값 파일. anchor 는 여기에 추가, audit 는 이 고정값과도 맞춰 봄 (끝 자르기·다시 쓰기). 없으면 SIGNER_AUDIT_ANCHORS
  --images      레지스트리 서명과 맞춰 봄: signed 줄마다 맞는 서명이 있는지, audit_head 가 붙은 서명이 전부 로그에 있는지
                (체인을 통째로 다시 계산하거나 signed 줄을 지우거나 거절로 바꾼 것도 잡음). 거절 줄 digest 는 --image-repo 저장소에서 찾음
  --strict-images --images 와 같이: audit_head 없는 서명(감사 로그 없이 한 서명)도 로그에 없는 서명으로 봄. 키 도용 감지
  --sweep       --images 와 같이: 저장소 태그를 crane 으로 전부 훑어서 로그에 한 번도 안 나온 이미지의 서명도 봄. 없으면 SIGNER_AUDIT_SWEEP=1
  --sweep-max   저장소당 태그 한도 (기본 1000). 넘으면 일부만 보고 통과시키지 않고 멈춤 (SWEEP_TRUNCATED)
  --digests-file 태그 없는 이미지 digest 목록 (한 줄에 sha256:<hex> 또는 <저장소>@sha256:<hex>)

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

const OPTIONS = {
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
  pub: { type: "string", multiple: true },
  audit: { type: "string" },
  images: { type: "boolean", default: false },
  "strict-images": { type: "boolean", default: false },
  "approval-ttl": { type: "string" },
  "pubkey-sha256": { type: "string", multiple: true },
  "self-verify": { type: "boolean", default: false },
  attest: { type: "boolean", default: false },
  attestation: { type: "boolean", default: false },
  policy: { type: "string" },
  "policy-sha256": { type: "string", multiple: true },
  "max-age": { type: "string" },
  "minimal-env": { type: "boolean", default: false },
  "test-result": { type: "string" },
  anchors: { type: "string" },
  digest: { type: "string" },
  "run-id": { type: "string" },
  reason: { type: "string" },
  by: { type: "string" },
  note: { type: "string" },
  latest: { type: "boolean", default: false },
  sweep: { type: "boolean", default: false },
  "digests-file": { type: "string" },
  "sweep-max": { type: "string" },
  observed: { type: "string" },
  json: { type: "boolean", default: false },
} as const;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  let values: ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS }>>["values"];
  try {
    ({ values } = parseArgs({ args: rest, options: OPTIONS }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const loose = parseArgs({ args: rest, options: OPTIONS, strict: false, allowPositionals: true }).values;
    // 모르는 옵션·값 빠짐·위치 인자로 끝나도 sign 이면 예전 sign_result 를 지움 (아래 required() 오류와 같게)
    if (command === "sign") rmSync(typeof loose.out === "string" && loose.out !== "" ? loose.out : "sign_result.json", { force: true });
    // --json 이면 인자 오류도 JSON 한 줄로
    if (loose.json === true && (command === "verify" || command === "audit" || command === "reconcile")) {
      console.log(JSON.stringify({ ok: false, code: 2, error: "ARG_INVALID", message }));
      return 2;
    }
    throw new SignerError("ARG_INVALID", `${message}\n\n${USAGE}`);
  }
  const planSchema = values["plan-schema"] ?? DEFAULT_PLAN_SCHEMA;
  const noTlog = values["no-tlog"] === true || process.env.SIGNER_NO_TLOG === "1";
  // cosign 에 필요한 환경변수만 넘김 (켤 때만, VM 에서 레지스트리 인증이 되는지 먼저 확인하고 켤 것)
  const minimalEnv = values["minimal-env"] === true || process.env.SIGNER_MINIMAL_ENV === "1";
  const cosignOptions = { noTlog, minimalEnv };
  // 빈 환경변수는 없는 것으로 봄 (backend 기본값이 '' 인 경우가 있음)
  // 빈 플래그(--audit "")도 없는 것으로 봄
  const auditPath = values.audit || process.env.SIGNER_AUDIT_LOG || undefined;
  const anchorsPath = values.anchors || process.env.SIGNER_AUDIT_ANCHORS || undefined;
  // 믿는 공개키. 키 교체 중이면 여러 개 (--pub 여러 번 또는 COSIGN_PUBLIC_KEY=a.pub,b.pub)
  const list = (values_: string[] | undefined, env: string | undefined): string[] =>
    values_?.filter(Boolean).length ? values_.filter(Boolean) : (env ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const pubs = list(values.pub, process.env.COSIGN_PUBLIC_KEY);
  if (pubs.length === 0) pubs.push(DEFAULT_PUBLIC_KEY);
  const pins = list(values["pubkey-sha256"], process.env.SIGNER_PUBKEY_SHA256);
  const pinnedPub = pins.length > 0 ? pins : undefined;
  // Rego 정책 지문 고정 (verify --attestation 에서만 씀)
  const policyPins = list(values["policy-sha256"], process.env.SIGNER_POLICY_SHA256);
  // 확인에 쓸 확인기. 지문을 고정했으면 고정 목록에 없는 공개키로는 확인하지 않음
  const trustedVerifier = (): ImageVerifier & BlobVerifier => {
    if (pinnedPub !== undefined) for (const p of pubs) checkPublicKeyPins(p, pinnedPub);
    const verifiers = pubs.map((p) => new CosignVerifier(p, "cosign", cosignOptions));
    return verifiers.length === 1 ? verifiers[0]! : new MultiKeyVerifier(verifiers);
  };
  const fingerprints = (): Array<{ path: string; sha256: string }> =>
    pubs.filter((p) => !isKmsKey(p)).map((p) => ({ path: p, sha256: `sha256:${publicKeyFingerprint(p)}` }));

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
    const keyPath = dryRun ? undefined : required(values.key ?? process.env.SIGNER_COSIGN_KEY, "key");
    // 개인키 파일을 다른 사용자도 읽을 수 있으면 경고. SIGNER_STRICT_KEY_PERMS=1 이면 서명 안 함
    const loose = keyPath !== undefined ? looseKeyPermissions(keyPath) : undefined;
    if (loose !== undefined) {
      const message = `개인키 파일 권한이 ${loose} 라서 다른 사용자도 읽을 수 있음 (chmod 600 권장): ${keyPath}`;
      if (process.env.SIGNER_STRICT_KEY_PERMS === "1") throw new SignerError("KEY_PERMISSIONS", message);
      console.error(`[signer] 경고: ${message}`);
    }
    const signer = keyPath === undefined ? new DryRunSigner() : new CosignSigner(keyPath, "cosign", cosignOptions);
    // 시험 실행은 실제 서명이 없어서 자기 확인을 안 함. 지문 확인은 서명 전에 끝냄
    const selfVerify = !dryRun && (values["self-verify"] === true || process.env.SIGNER_SELF_VERIFY === "1");
    const selfVerifier = selfVerify ? trustedVerifier() : undefined;
    const attest = !dryRun && (values.attest === true || process.env.SIGNER_ATTEST === "1");
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
      ...(attest ? { attest } : {}),
      ...(values["test-result"] !== undefined ? { testResultPath: values["test-result"] } : {}),
    });
    if (outcome.code === 0) {
      const r = outcome.result;
      console.log(`[signer] 서명함 run_id=${r.run_id} digest=${r.digest}`);
      console.log(`  targets  : ${r.targets.join(", ")}`);
      console.log(`  approver : ${r.approver}`);
      console.log(`  signature: ${r.signature_ref}${dryRun ? "  (시험 실행)" : noTlog ? "  (Rekor 없이)" : ""}`);
      console.log(`  저장     : ${out}`);
      if (auditPath !== undefined) console.log(`  감사 로그: ${auditPath}`);
      if (selfVerifier !== undefined) console.log(`  자기 확인: 통과 (${pubs.join(", ")})`);
      if (attest) console.log(`  배포 증명서: 붙임 (in-toto)`);
    } else {
      console.error(`[signer] 서명 안 함 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  if (command === "verify") {
    const json = values.json === true;
    const imageRepo = values["image-repo"] || process.env.IMAGE_REPO || undefined;
    const policyPath = values.policy || DEFAULT_POLICY;
    let maxAgeMs: number | undefined;
    let outcome: Awaited<ReturnType<typeof runVerify>>;
    let keys: ReturnType<typeof fingerprints>;
    let policySha256: string | undefined;
    let policyDir: string | undefined;
    const verifyAnchors = auditPath !== undefined ? anchorsPath : values.anchors || undefined;
    try {
      if (values["test-result"] !== undefined && values.attestation !== true) throw new SignerError("ARG_INVALID", "--test-result 는 --attestation 과 같이 써야 함 (시험 결과는 증명서에 들어 있음)");
      if (values.policy !== undefined && values.attestation !== true) throw new SignerError("ARG_INVALID", "--policy 는 --attestation 과 같이 써야 함 (정책은 배포 증명서에 적용, 없으면 정책 검사를 안 함)");
      if (values["policy-sha256"] !== undefined && values.attestation !== true) throw new SignerError("ARG_INVALID", "--policy-sha256 은 --attestation 과 같이 써야 함");
      // 정책은 확인한 바이트를 임시 파일로 써서 그 파일을 cosign 에 넘김 (확인한 뒤 원래 파일을 바꿔치기해도 소용없게)
      let checkedPolicy = policyPath;
      if (values.attestation === true) {
        const policy = readPolicy(policyPath, policyPins);
        policySha256 = policy.sha256;
        policyDir = mkdtempSync(join(tmpdir(), "signer-policy-"));
        checkedPolicy = join(policyDir, basename(policyPath).endsWith(".rego") ? basename(policyPath) : "policy.rego");
        writeFileSync(checkedPolicy, policy.bytes, { mode: 0o600 });
      }
      maxAgeMs = minutes(values["max-age"] || process.env.SIGNER_MAX_AGE_MIN, "max-age");
      outcome = await runVerify({
        resultPath: required(values.result, "result"),
        verifier: trustedVerifier(),
        ...(imageRepo !== undefined ? { imageRepo } : {}),
        ...(values.plan !== undefined ? { planPath: values.plan } : {}),
        ...(values.approval ? { approvalPath: values.approval } : {}),
        ...(values.attestation === true
          ? { attestation: { policyPath: checkedPolicy, ...(values["test-result"] !== undefined ? { testResultPath: values["test-result"] } : {}) } }
          : {}),
        ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
        ...(values.latest === true || process.env.SIGNER_VERIFY_LATEST === "1" ? { latest: true } : {}),
        planSchemaPath: planSchema,
        ...(auditPath !== undefined ? { auditPath } : {}),
        // 고정값은 감사 로그를 볼 때만. 플래그로 줬는데 --audit 가 없으면 runVerify 가 ARG_INVALID
        ...(verifyAnchors !== undefined ? { anchors: { path: verifyAnchors, verifier: trustedVerifier() } } : {}),
      });
      keys = fingerprints();
    } catch (e) {
      // --json 이면 실행 오류도 JSON 한 줄로 (콘솔·backend 가 그대로 읽게). 예상 못 한 오류도 INTERNAL 로
      if (json) {
        const error = e instanceof SignerError ? e.code : "INTERNAL";
        console.log(JSON.stringify({ ok: false, code: 2, error, message: e instanceof Error ? e.message : String(e) }));
        return 2;
      }
      throw e;
    } finally {
      if (policyDir !== undefined) rmSync(policyDir, { recursive: true, force: true });
    }
    if (json) {
      console.log(
        JSON.stringify(
          outcome.code === 0
            ? {
                ok: true,
                code: 0,
                run_id: outcome.result.run_id,
                digest: outcome.result.digest,
                image: outcome.imageRef,
                targets: outcome.result.targets,
                failover_allowed: outcome.result.failover_allowed,
                requester: outcome.result.requester,
                approver: outcome.result.approver,
                signed_at: outcome.result.signed_at,
                checked: {
                  annotations: Object.keys(outcome.annotations),
                  plan: values.plan !== undefined,
                  approval: Boolean(values.approval),
                  audit: auditPath !== undefined,
                  anchors: auditPath !== undefined && verifyAnchors !== undefined,
                  attestation: values.attestation === true ? { policy: policyPath, policy_sha256: `sha256:${policySha256}`, policy_pinned: policyPins.length > 0 } : false,
                  max_age_min: maxAgeMs !== undefined ? maxAgeMs / 60_000 : null,
                },
                pubkeys: keys,
                pubkey_pinned: pinnedPub !== undefined,
              }
            : { ok: false, code: 1, reason: outcome.reason, detail: outcome.detail },
        ),
      );
      return outcome.code;
    }
    if (outcome.code === 0) {
      const r = outcome.result;
      console.log(`[signer] 서명 확인함 run_id=${r.run_id} digest=${r.digest}`);
      console.log(`  targets  : ${r.targets.join(", ")}`);
      console.log(`  approver : ${r.approver}`);
      console.log(`  확인한 주석: ${Object.keys(outcome.annotations).join(", ")}`);
      if (values.attestation === true) {
        console.log(`  배포 증명서: 서명·내용 일치, 정책 통과 (${policyPath})`);
        console.log(`  정책 지문: sha256:${policySha256}${policyPins.length > 0 ? " (고정값에 있음)" : ""}`);
      }
      if (maxAgeMs !== undefined) console.log(`  유효기간: ${maxAgeMs / 60_000}분 안에 서명함`);
      if (auditPath !== undefined) console.log(`  감사 로그: signed 줄 일치${verifyAnchors !== undefined ? ", 끝 고정값 일치" : " (끝 고정값은 안 봄, --anchors 로 같이 확인 권장)"}`);
      for (const k of keys) console.log(`  공개키 지문: ${k.sha256}${pinnedPub !== undefined ? " (고정값에 있음)" : ""}  ${k.path}`);
    } else {
      console.error(`[signer] 서명 확인 실패 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  if (command === "anchor") {
    const log = required(auditPath, "audit");
    const out = anchorsPath ?? `${log}.anchors.jsonl`;
    const anchor = await runAnchor({ auditPath: log, anchorsPath: out, signer: new CosignSigner(required(values.key ?? process.env.SIGNER_COSIGN_KEY, "key"), "cosign", cosignOptions) });
    console.log(`[signer] 감사 로그 끝 고정: ${anchor.seq}줄, head=${anchor.head}${noTlog ? " (Rekor 없이)" : " (Rekor 기록)"}`);
    console.log(`  저장: ${out} (감사 로그와 다른 곳에도 복사해 둘 것)`);
    return 0;
  }

  if (command === "revoke") {
    const log = required(auditPath, "audit");
    // 끝 고정까지 할 거면 키부터 확인 (철회 줄만 쓰고 실행 오류로 끝나 재시도 때 줄이 또 쌓이지 않게)
    const anchorSigner = anchorsPath !== undefined ? new CosignSigner(required(values.key ?? process.env.SIGNER_COSIGN_KEY, "key"), "cosign", cosignOptions) : undefined;
    const r = await runRevoke({
      auditPath: log,
      digest: required(values.digest, "digest"),
      runId: values["run-id"] || undefined,
      reason: required(values.reason, "reason"),
      by: required(values.by, "by"),
      note: values.note || undefined,
    });
    const e = r.line.entry;
    if (e.kind === "revoke") {
      console.log(`[signer] 서명 철회${r.existing ? " (이미 철회돼 있음)" : ""}: 감사 로그 ${r.line.seq}번째 줄, ${e.run_id !== undefined ? `run_id=${e.run_id} ` : "이미지 전체 "}${e.digest} (${e.reason}, ${e.by})`);
    }
    if (r.signed === 0) console.error("[signer] 경고: 감사 로그에 이 이미지(실행)의 signed 줄이 아직 없음 (미리 철회함)");
    // 고정값 파일을 주면 바로 끝 고정 (철회 줄을 잘라내면 anchor_truncated)
    if (anchorSigner !== undefined && anchorsPath !== undefined) {
      try {
        const anchor = await runAnchor({ auditPath: log, anchorsPath, signer: anchorSigner });
        console.log(`  끝 고정: ${anchor.seq}줄 (${anchorsPath})`);
      } catch (err) {
        console.error(`[signer] 철회는 ${r.line.seq}번째 줄에 기록됨. 끝 고정만 실패해서 signer anchor 로 다시 고정할 것: ${err instanceof Error ? err.message : String(err)}`);
        return 2;
      }
    }
    return 0;
  }

  if (command === "audit") {
    const json = values.json === true;
    const sweep = values.sweep === true || process.env.SIGNER_AUDIT_SWEEP === "1";
    const jsonError = (e: unknown): number => {
      console.log(JSON.stringify({ ok: false, code: 2, error: e instanceof SignerError ? e.code : "INTERNAL", message: e instanceof Error ? e.message : String(e) }));
      return 2;
    };
    let outcome: Awaited<ReturnType<typeof runAuditVerify>>;
    try {
      if (values["strict-images"] === true && values.images !== true) throw new SignerError("ARG_INVALID", "--strict-images 는 --images 와 같이 써야 함 (레지스트리 서명을 볼 때만 의미 있음)");
      if ((values.sweep === true || values["digests-file"] !== undefined || values["sweep-max"] !== undefined) && values.images !== true) {
        throw new SignerError("ARG_INVALID", "--sweep·--digests-file·--sweep-max 는 --images 와 같이 써야 함");
      }
      if (values["sweep-max"] !== undefined && !sweep) throw new SignerError("ARG_INVALID", "--sweep-max 는 --sweep 과 같이 써야 함 (태그 훑기 한도)");
      const sweepMax = values["sweep-max"] !== undefined ? Number(values["sweep-max"]) : undefined;
      if (sweepMax !== undefined && !(Number.isInteger(sweepMax) && sweepMax > 0)) throw new SignerError("ARG_INVALID", `--sweep-max 는 양의 정수: ${values["sweep-max"]}`);
      const imageRepo = values["image-repo"] || process.env.IMAGE_REPO || undefined;
      outcome = await runAuditVerify({
        auditPath: required(auditPath, "audit"),
        ...(values.images === true ? { verifier: trustedVerifier(), strictImages: values["strict-images"] === true } : {}),
        ...(imageRepo !== undefined ? { imageRepo } : {}),
        ...(anchorsPath !== undefined ? { anchors: { path: anchorsPath, verifier: trustedVerifier() } } : {}),
        ...(values.images === true && (sweep || values["digests-file"] !== undefined)
          ? {
              sweep: {
                // --digests-file 만 주면 태그는 안 훑음 (태그가 한도를 넘는 저장소를 목록 파일로 나눠 볼 수 있게)
                ...(sweep ? { lister: new CraneLister("crane", cosignOptions) } : {}),
                ...(values["digests-file"] !== undefined ? { digestsFile: values["digests-file"] } : {}),
                ...(sweepMax !== undefined ? { max: sweepMax } : {}),
              },
            }
          : {}),
      });
    } catch (e) {
      if (json) return jsonError(e);
      throw e;
    }
    if (json) {
      console.log(JSON.stringify(outcome.code === 0 ? { ok: true, ...outcome } : { ok: false, ...outcome }));
      return outcome.code;
    }
    if (outcome.code === 0) {
      console.log(`[signer] 감사 로그 이상 없음: ${outcome.lines}줄, head=${outcome.head}${outcome.revoked > 0 ? `, 철회 ${outcome.revoked}건` : ""}`);
      if (outcome.anchors !== undefined) console.log(`  끝 고정값 ${outcome.anchors}개와 일치 (잘리거나 다시 쓴 흔적 없음)`);
      if (values.images === true) console.log(`  이미지 ${outcome.images}개 확인: signed 줄 ${outcome.signed}개 모두 서명과 일치, 로그에 없는 서명 없음`);
      if (outcome.swept !== undefined) console.log(`  레지스트리 훑기: 태그 ${outcome.swept.tags}개(서명 태그 ${outcome.swept.signature_tags}개), 목록 파일 ${outcome.swept.file}개, 로그에 없던 이미지 ${outcome.swept.added}개 더 확인`);
    } else if (outcome.findings !== undefined && outcome.findings.length > 0) {
      console.error(`[signer] 감사 로그 문제 ${outcome.findings.length}건 (이미지 ${outcome.images ?? 0}개 확인)`);
      for (const f of outcome.findings) console.error(`  ${f.line > 0 ? `${f.line}번째 줄 ` : ""}(${f.reason}): ${f.detail}`);
    } else {
      const where = outcome.line > 0 ? `${outcome.line}번째 줄` : "";
      console.error(`[signer] 감사 로그 ${where}${where ? " " : ""}문제 (${outcome.reason}): ${outcome.detail}`);
    }
    return outcome.code;
  }

  if (command === "reconcile") {
    const json = values.json === true;
    let outcome: Awaited<ReturnType<typeof runReconcile>>;
    try {
      outcome = await runReconcile({
        observedPath: required(values.observed, "observed"),
        auditPath: required(auditPath, "audit"),
        verifier: trustedVerifier(),
        ...(anchorsPath !== undefined ? { anchors: { path: anchorsPath, verifier: trustedVerifier() } } : {}),
      });
    } catch (e) {
      if (json) {
        console.log(JSON.stringify({ ok: false, code: 2, error: e instanceof SignerError ? e.code : "INTERNAL", message: e instanceof Error ? e.message : String(e) }));
        return 2;
      }
      throw e;
    }
    if (json) {
      console.log(JSON.stringify({ ok: outcome.code === 0, ...outcome }));
      return outcome.code;
    }
    if (!("failures" in outcome)) {
      console.error(`[signer] 감사 로그 ${outcome.line > 0 ? `${outcome.line}번째 줄 ` : ""}문제 (${outcome.reason}): ${outcome.detail}`);
      return outcome.code;
    }
    if (outcome.code === 0) console.log(`[signer] 실제 배포 ${outcome.checked}건 모두 서명된 그대로`);
    else {
      console.error(`[signer] 실제 배포 ${outcome.checked}건 중 ${outcome.failures.length}건이 서명과 다름`);
      for (const f of outcome.failures) console.error(`  ${f.line}번째 줄 (${f.reason}): ${f.target} ${f.image} — ${f.detail}`);
    }
    return outcome.code;
  }

  if (command === "fingerprint") {
    // --policy 면 Rego 정책 파일 지문 (--policy-sha256 고정값으로 쓸 값)
    if (values.policy) {
      const policy = readPolicy(values.policy, policyPins);
      console.log(`sha256:${policy.sha256}  ${values.policy}${policyPins.length > 0 ? "  (고정값에 있음)" : ""}`);
      return 0;
    }
    for (const p of pubs) {
      const fingerprint = pinnedPub !== undefined ? checkPublicKeyPins(p, pinnedPub) : publicKeyFingerprint(p);
      console.log(`sha256:${fingerprint}  ${p}${pinnedPub !== undefined ? "  (고정값에 있음)" : ""}`);
    }
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

// sign_result.json 이 signer 가 서명한 그대로인지(verify), 감사 로그가 끊기지 않았는지(audit) 확인
import { fileURLToPath } from "node:url";
import { decodeTargets, encodeImageRepo, logAnnotations, NO_APPROVAL, signAnnotations } from "./annotations.js";
import { loadApproval } from "./approval.js";
import { checkAnchors, type AnchorBreak } from "./anchor.js";
import { DEPLOY_PREDICATE_TYPE, findDeployStatement } from "./attestation.js";
import { cancelledHashes, checkAuditChain, findSignedLine, GENESIS, readAuditFile, revocationOf, type AuditBreak } from "./audit.js";
import { imageRefOf, type BlobVerifier, type ImageVerifier } from "./cosign.js";
import { readDigestsFile, sweepDigests, type RegistryLister } from "./registry.js";
import { canonicalize, parseWith, readJson, sha256Hex, SignerError } from "./io.js";
import { DEFAULT_PLAN_SCHEMA, loadPlan } from "./plan.js";
import { AUTO_APPROVER, SignResultSchema, type AuditLine, type SignResult } from "./schema.js";

export const DEFAULT_PUBLIC_KEY = fileURLToPath(new URL("../keys/cosign.pub", import.meta.url));

export type VerifyReason =
  | "dry_run"
  | "ref_invalid"
  | "repo_mismatch"
  | "plan_mismatch"
  | "approval_mismatch"
  | "audit_mismatch"
  | "signature_invalid"
  | "attestation_invalid"
  | "policy_denied"
  | "expired"
  | "revoked"
  | "superseded";

export interface VerifyOptions {
  resultPath: string;
  verifier: ImageVerifier;
  /** 있으면 서명된 저장소가 이 값이어야 함 */
  imageRepo?: string;
  /** 있으면 plan 내용과 plan 파일 해시까지 확인 */
  planPath?: string;
  planSchemaPath?: string;
  /** 있으면 감사 로그 체인과 이 실행의 signed 줄(anchor)까지 확인 */
  auditPath?: string;
  /** 있으면 이 승인 기록으로 서명했는지까지 확인 (사람 승인일 때) */
  approvalPath?: string;
  /** 있으면 배포 증명서(in-toto)도 확인. policyPath 를 주면 Rego 정책까지, testResultPath 를 주면 그 시험 결과로 서명했는지까지 */
  attestation?: { policyPath?: string; testResultPath?: string };
  /** 있으면 서명한 지 이 시간(ms)이 지난 결과는 거부. signed_at 도 서명 주석에 묶여 있어서 고쳐도 걸림 */
  maxAgeMs?: number;
  /**
   * 켜면 이 결과 뒤에 같은 저장소·겹치는 배포 위치로 더 새로 서명한 결과가 있거나, 같은 이미지가 block 됐으면 거부
   * (예전 정상 결과 재사용·몰래 롤백). auditPath 가 있어야 함
   */
  latest?: boolean;
  now?: () => Date;
}

export type VerifyOutcome =
  | { code: 0; result: SignResult; imageRef: string; annotations: Record<string, string> }
  | { code: 1; reason: VerifyReason; detail: string };

// plan 과 sign_result 에 같이 있는 필드
const PLAN_FIELDS = ["run_id", "digest", "plan_hash", "source_revision", "targets", "failover_allowed"] as const;

const fail = (reason: VerifyReason, detail: string): VerifyOutcome => ({ code: 1, reason, detail });

export async function runVerify(o: VerifyOptions): Promise<VerifyOutcome> {
  if (o.latest === true && o.auditPath === undefined) throw new SignerError("ARG_MISSING", "--latest 는 감사 로그(--audit)가 있어야 함 (더 새 서명을 감사 로그에서 찾음)");
  const result = parseWith(SignResultSchema, readJson(o.resultPath, "sign_result"), "sign_result");

  if (o.maxAgeMs !== undefined) {
    const signedAt = Date.parse(result.signed_at);
    const age = (o.now ?? (() => new Date()))().getTime() - signedAt;
    if (Number.isNaN(signedAt)) return fail("expired", `signed_at 을 시각으로 읽을 수 없음: ${result.signed_at}`);
    if (age < -60_000) return fail("expired", `signed_at 이 미래임: ${result.signed_at}`);
    if (age > o.maxAgeMs) return fail("expired", `서명한 지 ${Math.floor(age / 60_000)}분 지남 (유효 ${Math.round(o.maxAgeMs / 60_000)}분)`);
  }

  const ref = result.signature_ref;
  if (ref.startsWith("dry-run:")) return fail("dry_run", "dry-run 결과라 실제 서명이 없음");
  if (!ref.startsWith("cosign:")) return fail("ref_invalid", `signature_ref 가 cosign: 으로 시작하지 않음: ${ref}`);
  const imageRef = ref.slice("cosign:".length);
  const at = imageRef.lastIndexOf("@");
  const repo = at < 0 ? "" : imageRef.slice(0, at);
  try {
    if (imageRefOf(repo, result.digest) !== imageRef) return fail("ref_invalid", `signature_ref 의 digest 가 sign_result.digest 와 다름: ${ref}`);
  } catch {
    return fail("ref_invalid", `signature_ref 형식 오류 (cosign:<저장소>@<digest>): ${ref}`);
  }
  if (o.imageRepo !== undefined && o.imageRepo !== repo) return fail("repo_mismatch", `서명된 저장소(${repo})가 지정한 저장소(${o.imageRepo})와 다름`);

  let planSha256: string | undefined;
  if (o.planPath !== undefined) {
    const loaded = loadPlan(o.planPath, o.planSchemaPath ?? DEFAULT_PLAN_SCHEMA);
    const differs = PLAN_FIELDS.find((k) => canonicalize(loaded.plan[k]) !== canonicalize(result[k]));
    if (differs) return fail("plan_mismatch", `plan 과 sign_result 의 ${differs} 가 다름`);
    planSha256 = loaded.planSha256;
  }

  // 자동 승인 결과는 항상 "승인 기록 없음(none)"으로 서명돼 있어야 함. 사람 승인은 승인 기록을 주면 그 해시까지 확인
  let approvalSha256: string | undefined = result.approver === AUTO_APPROVER ? NO_APPROVAL : undefined;
  if (o.approvalPath !== undefined) {
    if (result.approver === AUTO_APPROVER) return fail("approval_mismatch", "자동 승인(auto) 결과인데 승인 기록을 줌");
    const approval = loadApproval(o.approvalPath);
    const differs = (["run_id", "digest", "plan_hash", "requester", "approver"] as const).find((k) => approval[k] !== result[k]);
    if (differs) return fail("approval_mismatch", `승인 기록과 sign_result 의 ${differs} 가 다름`);
    approvalSha256 = sha256Hex(canonicalize(approval));
  }

  let auditHead: string | undefined;
  let recorded: Record<string, string> | undefined;
  if (o.auditPath !== undefined) {
    const check = checkAuditChain(readAuditFile(o.auditPath));
    if (!check.ok) return fail("audit_mismatch", `감사 로그 ${check.line}번째 줄 (${check.reason}): ${check.detail}`);
    const line = findSignedLine(check.lines, result);
    if (!line) return fail("audit_mismatch", "감사 로그에 이 서명 결과(signed 줄)가 없음");
    if (cancelledHashes(check.lines).has(line.hash)) return fail("audit_mismatch", `서명 뒤 단계(자기 확인·증명서)가 실패해서 취소된 서명 (${line.seq}번째 줄)`);
    const revocation = revocationOf(check.lines, line);
    if (revocation !== undefined && revocation.entry.kind === "revoke") {
      const r = revocation.entry;
      return fail("revoked", `감사 로그 ${revocation.seq}번째 줄에서 철회됨 (${r.reason}, ${r.by}${r.note ? `: ${r.note}` : ""})`);
    }
    if (o.latest === true) {
      const newer = newerThan(check.lines, line, repo, result);
      if (newer !== undefined) return fail("superseded", newer);
    }
    auditHead = line.anchor;
    recorded = line.annotations;
  }

  let annotations = signAnnotations(result, { planSha256, auditHead, approvalSha256, imageRepo: repo });
  if (recorded !== undefined) {
    // 서명 당시 기록한 주석과 sign_result 가 같아야 하고, 레지스트리에는 기록한 그 서명(주석 전체)이 있어야 함.
    // 키를 가진 사람이 targets 만 바꾼 쌍둥이 서명을 붙이고 sign_result 를 고쳐도 걸림
    const differs = Object.keys(annotations).find((k) => recorded?.[k] !== annotations[k]);
    if (differs) return fail("audit_mismatch", `sign_result 의 ${differs} 가 서명 당시 감사 로그 기록과 다름`);
    annotations = recorded;
  }
  try {
    await o.verifier.verify(imageRef, annotations);
  } catch (e) {
    if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") {
      // 저장소만 다르고 나머지는 같은 서명이면, 다른 저장소의 서명을 복사해 온 것
      const from = await movedFrom(o.verifier, imageRef, annotations);
      if (from !== undefined) return fail("repo_mismatch", `다른 저장소에서 옮겨 온 서명 (서명한 저장소 ${from}, 확인한 저장소 ${repo})`);
      return fail("signature_invalid", e.message);
    }
    throw e;
  }

  // 배포 증명서: 서명된 Statement 가 이 sign_result 와 같고, 정책(Rego)도 통과하는지
  if (o.attestation !== undefined) {
    if (!o.verifier.attestations) throw new SignerError("ARG_INVALID", "이 확인기는 배포 증명서를 확인할 수 없음");
    let statements: unknown[];
    try {
      statements = await o.verifier.attestations(imageRef, DEPLOY_PREDICATE_TYPE, o.attestation.policyPath);
    } catch (e) {
      if (e instanceof SignerError && e.code === "POLICY_DENIED") return fail("policy_denied", e.message);
      if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") return fail("attestation_invalid", e.message);
      throw e;
    }
    const testSha = o.attestation.testResultPath !== undefined ? sha256Hex(canonicalize(readJson(o.attestation.testResultPath, "test_result"))) : undefined;
    const found = findDeployStatement(statements, result, testSha);
    if (!found.ok) return fail("attestation_invalid", found.detail);
  }
  return { code: 0, result, imageRef, annotations };
}

/**
 * 이 signed 줄 뒤에 더 새로 서명한 결과(같은 저장소, 배포 위치가 겹침, 취소·철회 안 됨)나 같은 이미지의 block 결정이 있으면 그 설명.
 * 주석 기록이 없는 예전 줄은 배포 위치가 겹치는 것으로 봄
 */
function newerThan(lines: readonly AuditLine[], line: AuditLine, repo: string, result: SignResult): string | undefined {
  const cancelled = cancelledHashes(lines);
  for (const l of lines) {
    if (l.seq <= line.seq || l.entry.kind !== "sign") continue;
    const e = l.entry;
    if (e.result === "refused" && e.reason === "policy_block" && e.digest === result.digest) return `${l.seq}번째 줄(run_id=${e.run_id})에서 같은 이미지가 block 됨`;
    if (e.result !== "signed" || cancelled.has(l.hash) || revocationOf(lines, l) !== undefined) continue;
    const ref = e.signature_ref ?? "";
    if (!ref.startsWith("cosign:") || ref.slice("cosign:".length, ref.lastIndexOf("@")) !== repo) continue;
    const targets = l.annotations?.targets !== undefined ? decodeTargets(l.annotations.targets) : undefined;
    if (targets !== undefined && !targets.some((t) => result.targets.includes(t))) continue;
    return `${l.seq}번째 줄(run_id=${e.run_id}, ${e.digest.slice(0, 19)}…)이 더 나중에 서명됨`;
  }
  return undefined;
}

/** image_repo 만 다르고 다른 주석은 다 같은 서명이 있으면 그 서명의 저장소 */
async function movedFrom(verifier: ImageVerifier, imageRef: string, annotations: Record<string, string>): Promise<string | undefined> {
  let sigs: Array<Record<string, string>>;
  try {
    sigs = await verifier.signatures(imageRef);
  } catch {
    return undefined; // 원래 이유(signature_invalid)로 알림
  }
  const moved = sigs.find(
    (sig) => sig.image_repo !== undefined && sig.image_repo !== annotations.image_repo && Object.entries(annotations).every(([k, v]) => k === "image_repo" || sig[k] === v),
  );
  if (moved?.image_repo === undefined) return undefined;
  try {
    return decodeURIComponent(moved.image_repo);
  } catch {
    return moved.image_repo;
  }
}

export interface AuditVerifyOptions {
  auditPath: string;
  /** 있으면 레지스트리의 이미지 서명과 감사 로그를 맞춰 봄 */
  verifier?: ImageVerifier;
  /** 서명 줄이 없는 digest(거절 줄)도 이 저장소에서 서명을 찾음. 서명 줄을 거절로 바꿔치기한 것을 잡으려면 필요 */
  imageRepo?: string;
  /**
   * 켜면 audit_head 가 없는 서명(감사 로그 없이 한 서명)도 로그에 없는 서명으로 봄.
   * 키를 훔쳐 signer 밖에서 cosign 으로 직접 서명한 것을 잡음. 감사 로그를 켜기 전 서명이 섞인 이미지는 걸리니 opt-in
   */
  strictImages?: boolean;
  /** 있으면 감사 로그 끝 고정값(anchors 파일)과도 맞춰 봄. 끝을 잘라냈거나 다시 쓴 것을 잡음 */
  anchors?: { path: string; verifier: BlobVerifier };
  /**
   * 있으면 저장소의 태그를 전부 훑어 로그에 한 번도 안 나온 이미지의 서명도 봄 (훔친 키, 복사한 로그로 한 서명).
   * digestsFile 은 태그 없는 이미지용 목록, max 는 저장소당 태그 한도
   */
  sweep?: { lister: RegistryLister; digestsFile?: string; max?: number };
}

export type AuditImageReason = "ref_invalid" | "signature_invalid" | "unlogged_signature" | "twin_signature" | "foreign_signature";

/**
 * 레지스트리 서명이 이 signed 줄의 서명인지. 주석 전체를 기록한 줄은 정확히 같아야 하고(쌍둥이 서명 거부),
 * 예전 줄은 줄 내용으로 만들 수 있는 주석만 비교
 */
export function sigMatchesLine(sig: Record<string, string>, line: AuditLine): boolean {
  if (line.anchor === undefined || line.entry.kind !== "sign") return false;
  if (line.annotations !== undefined) return canonicalize(sig) === canonicalize(line.annotations);
  return Object.entries(logAnnotations(line.entry, line.anchor)).every(([k, v]) => sig[k] === v);
}

/** 기록과 서명 주석 차이 (detail 용) */
function annotationDiff(expected: Record<string, string>, sig: Record<string, string>): string {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(sig)])].sort();
  return keys
    .flatMap((k) => (expected[k] === sig[k] ? [] : expected[k] === undefined ? [`+${k}=${sig[k]}`] : sig[k] === undefined ? [`-${k}`] : [`${k} ${expected[k]} → ${sig[k]}`]))
    .join(", ");
}

export interface AuditFinding {
  line: number;
  reason: AuditImageReason;
  image: string;
  run_id?: string;
  detail: string;
}

/** 훑기로 본 것 */
export interface SweepCount {
  tags: number;
  signature_tags: number;
  file: number;
  /** 감사 로그에 없던 이미지 중 새로 확인한 수 */
  added: number;
}

export type AuditVerifyOutcome =
  | { code: 0; lines: number; head: string; signed: number; images: number; revoked: number; anchors?: number; swept?: SweepCount }
  | { code: 1; line: number; reason: AuditBreak | AuditImageReason | AnchorBreak; detail: string; findings?: AuditFinding[]; images?: number; swept?: SweepCount };

/**
 * 1) 체인이 이어지는지 2) (verifier 가 있으면) signed 줄마다 그 내용·anchor 와 맞는 이미지 서명이 있는지
 * 3) 반대로 레지스트리에 있는 audit_head 서명이 전부 감사 로그의 signed 줄과 맞는지 (signed 줄을 지우거나 거절로 바꾼 것)
 */
export async function runAuditVerify(o: AuditVerifyOptions): Promise<AuditVerifyOutcome> {
  const check = checkAuditChain(readAuditFile(o.auditPath));
  if (!check.ok) return { code: 1, line: check.line, reason: check.reason, detail: check.detail };
  const { lines, head } = check;
  let anchors: number | undefined;
  if (o.anchors) {
    const anchored = await checkAnchors(o.anchors.path, check, o.anchors.verifier);
    if (!anchored.ok) return { code: 1, line: anchored.line, reason: anchored.reason, detail: anchored.detail };
    anchors = anchored.anchors;
  }
  const withAnchors = anchors !== undefined ? { anchors } : {};
  const revoked = lines.filter((l) => l.entry.kind === "revoke").length;
  if (!o.verifier) return { code: 0, lines: lines.length, head, signed: 0, images: 0, revoked, ...withAnchors };

  // signed 줄의 서명 위치가 그 줄 digest 의 이미지인지 (옵션처럼 생긴 값, 다른 이미지 차단)
  const signedAt = new Map<string, AuditLine[]>();
  const repos = new Set<string>(o.imageRepo !== undefined ? [o.imageRepo] : []);
  for (const line of lines) {
    const entry = line.entry;
    if (entry.kind !== "sign") continue;
    const ref = entry.signature_ref;
    if (entry.result !== "signed" || ref === null || ref.startsWith("dry-run:")) continue;
    const imageRef = ref.startsWith("cosign:") ? ref.slice("cosign:".length) : "";
    const repo = imageRef.slice(0, Math.max(0, imageRef.lastIndexOf("@")));
    let expected: string | undefined;
    try {
      expected = imageRefOf(repo, entry.digest);
    } catch {
      expected = undefined;
    }
    if (expected === undefined || expected !== imageRef) {
      return { code: 1, line: line.seq, reason: "ref_invalid", detail: `signature_ref 가 이 줄 digest 의 이미지가 아님: ${ref}` };
    }
    repos.add(repo);
    signedAt.set(imageRef, [...(signedAt.get(imageRef) ?? []), line]);
  }
  if (repos.size === 0 && lines.length > 0) {
    throw new SignerError("ARG_MISSING", "감사 로그에 서명 줄이 없어서 이미지 저장소를 모름. --image-repo 를 주세요");
  }

  // 확인할 이미지: signed 줄 이미지 + 모든 줄 digest × 알고 있는 저장소 (+ 훑기면 레지스트리의 이미지 전부)
  const refs = new Set(signedAt.keys());
  for (const line of lines) if (line.entry.kind === "sign") for (const repo of repos) refs.add(imageRefOf(repo, line.entry.digest));
  const fromLog = new Set(refs);
  let swept: SweepCount | undefined;
  if (o.sweep !== undefined) {
    swept = { tags: 0, signature_tags: 0, file: 0, added: 0 };
    for (const repo of [...repos].sort()) {
      const found = await sweepDigests(o.sweep.lister, repo, o.sweep.max);
      swept.tags += found.tags;
      swept.signature_tags += found.signatureTags;
      for (const d of found.digests) refs.add(imageRefOf(repo, d));
    }
    if (o.sweep.digestsFile !== undefined) {
      for (const { repo, digest } of readDigestsFile(o.sweep.digestsFile)) {
        swept.file++;
        for (const r of repo !== undefined ? [repo] : repos) refs.add(imageRefOf(r, digest));
      }
    }
    swept.added = refs.size - fromLog.size;
  }
  const lineOfHash = new Map<string, number>([[GENESIS, 0], ...lines.map((l) => [l.hash, l.seq] as const)]);
  const matches = sigMatchesLine;

  // 첫 문제에서 멈추지 않고 전부 모음 (계속 남는 문제 하나가 뒤 이미지 검사를 가리지 않게)
  const findings: AuditFinding[] = [];
  const found = (f: AuditFinding) => findings.push(f);
  let images = 0;
  for (const imageRef of [...refs].sort()) {
    let sigs: Array<Record<string, string>>;
    try {
      sigs = await o.verifier.signatures(imageRef);
    } catch (e) {
      if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") {
        // 훑어서 더한 이미지에 믿지 않는 키로만 한 서명은 배포에 못 써서 넘김
        if (fromLog.has(imageRef)) found({ line: signedAt.get(imageRef)?.[0]?.seq ?? 0, reason: "signature_invalid", image: imageRef, detail: e.message });
        images++;
        continue;
      }
      throw e;
    }
    const logged = signedAt.get(imageRef) ?? [];
    for (const line of logged) {
      if (!sigs.some((sig) => matches(sig, line))) found({ line: line.seq, reason: "signature_invalid", image: imageRef, detail: `이 줄 내용·anchor 와 맞는 이미지 서명이 없음: ${imageRef}` });
    }
    const queriedRepo = encodeImageRepo(imageRef.slice(0, imageRef.lastIndexOf("@")));
    for (const sig of sigs) {
      const runId = sig.run_id ?? "?";
      // 다른 저장소에서 서명한 것을 이미지와 같이 복사해 온 서명
      if (sig.image_repo !== undefined && sig.image_repo !== queriedRepo) {
        found({ line: 0, reason: "foreign_signature", image: imageRef, run_id: runId, detail: `다른 저장소(image_repo=${sig.image_repo})에서 옮겨 온 서명 (run_id=${runId}): ${imageRef}` });
        continue;
      }
      const anchor = sig.audit_head;
      if (anchor === undefined) {
        if (o.strictImages) found({ line: 0, reason: "unlogged_signature", image: imageRef, run_id: runId, detail: `감사 로그 없이 한 서명 (audit_head 없음, run_id=${runId}): ${imageRef}` });
        continue; // strict 가 아니면 감사 로그를 안 켜고 한 서명으로 봄
      }
      if (logged.some((line) => matches(sig, line))) continue;
      // 같은 실행·같은 anchor 의 기록이 있는데 주석이 다르면, 정상 서명을 복사해서 일부만 바꾼 쌍둥이 서명
      const twin = logged.find((line) => line.anchor === anchor && line.entry.kind === "sign" && line.entry.run_id === sig.run_id);
      if (twin !== undefined && twin.anchor !== undefined && twin.entry.kind === "sign") {
        const expected = twin.annotations ?? logAnnotations(twin.entry, twin.anchor);
        found({ line: twin.seq, reason: "twin_signature", image: imageRef, run_id: runId, detail: `기록된 서명과 주석만 다른 서명 (${annotationDiff(expected, sig) || "주석 같음"}): ${imageRef}` });
        continue;
      }
      const at = lineOfHash.get(anchor);
      // audit_head 가 이 로그의 줄이면 그 뒤에서 갈라진 서명 (signed 줄을 지웠거나, 복사한 로그로 서명)
      const where = at === undefined ? "이 로그에 없는 audit_head" : `이 로그 ${at}번째 줄 뒤에서 갈라짐 (signed 줄을 지웠거나 복사한 로그로 서명)`;
      found({ line: at === undefined ? 0 : at + 1, reason: "unlogged_signature", image: imageRef, run_id: runId, detail: `감사 로그에 없는 서명 (run_id=${runId}, audit_head=${anchor.slice(0, 12)}…, ${where}): ${imageRef}` });
    }
    images++;
  }
  const signed = [...signedAt.values()].reduce((n, ls) => n + ls.length, 0);
  const withSwept = swept !== undefined ? { swept } : {};
  const first = findings[0];
  if (first !== undefined) return { code: 1, line: first.line, reason: first.reason, detail: first.detail, findings, images, ...withSwept };
  return { code: 0, lines: lines.length, head, signed, images, revoked, ...withAnchors, ...withSwept };
}

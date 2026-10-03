// 실제 배포 상태 대조. signer 의 다른 검사는 레지스트리와 감사 로그만 맞춰 봐서, 배포 쪽이 sign_result 를 고쳐 승인 안 된 곳에
// 띄워도 모름 (서명은 멀쩡함). 감사자가 실제로 어디에 무엇이 떠 있는지 적은 관측 파일을 받아, 그 배포가 서명된 그대로인지 확인
import { readFileSync } from "node:fs";
import { checkAnchors, type AnchorBreak } from "./anchor.js";
import { decodeTargets } from "./annotations.js";
import { cancelledHashes, checkAuditChain, readAuditFile, revocationOf, type AuditBreak } from "./audit.js";
import { imageRefOf, type BlobVerifier, type ImageVerifier } from "./cosign.js";
import { SignerError } from "./io.js";
import { ObservedSchema, type AuditLine, type Observed } from "./schema.js";
import { sigMatchesLine } from "./verify.js";

export type ReconcileReason = "deploy_unlogged" | "deploy_unsigned" | "deploy_revoked" | "target_not_signed";

export interface ReconcileFailure {
  /** 관측 파일 줄 번호 */
  line: number;
  target: string;
  image: string;
  reason: ReconcileReason;
  detail: string;
}

export interface ReconcileOptions {
  observedPath: string;
  auditPath: string;
  verifier: ImageVerifier;
  anchors?: { path: string; verifier: BlobVerifier };
}

export type ReconcileOutcome =
  | { code: 0 | 1; checked: number; failures: ReconcileFailure[] }
  | { code: 1; reason: AuditBreak | AnchorBreak; line: number; detail: string };

/** 관측 파일 (jsonl). 형식이 틀린 줄이 있으면 줄 번호와 같이 실행 오류 */
export function readObserved(path: string): Array<{ line: number; observed: Observed }> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SignerError("OBSERVED_INVALID", `관측 파일을 읽지 못함: ${path}`);
  }
  const out: Array<{ line: number; observed: Observed }> = [];
  for (const [i, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    const bad = (why: string) => new SignerError("OBSERVED_INVALID", `${path} ${i + 1}번째 줄 ${why}`);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw bad("JSON 이 아님");
    }
    const parsed = ObservedSchema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw bad(`형식 오류 ${first?.path.join(".") || "(최상위)"}: ${first?.message ?? "알 수 없음"}`);
    }
    const at = parsed.data.image.lastIndexOf("@");
    try {
      imageRefOf(parsed.data.image.slice(0, at), parsed.data.image.slice(at + 1));
    } catch {
      throw bad(`image 형식 오류: ${parsed.data.image}`);
    }
    out.push({ line: i + 1, observed: parsed.data });
  }
  if (out.length === 0) throw new SignerError("OBSERVED_INVALID", `관측 파일이 비어 있음: ${path}`);
  return out;
}

/**
 * 관측마다: 감사 로그에 그 이미지의 signed 줄이 있는지 → 레지스트리에 그 줄과 정확히 같은 서명이 있는지
 * → 철회되지 않았는지 → 서명한 배포 위치(targets)에 관측한 위치가 있는지
 */
export async function runReconcile(o: ReconcileOptions): Promise<ReconcileOutcome> {
  const observed = readObserved(o.observedPath);
  const check = checkAuditChain(readAuditFile(o.auditPath));
  if (!check.ok) return { code: 1, reason: check.reason, line: check.line, detail: check.detail };
  if (o.anchors) {
    const anchored = await checkAnchors(o.anchors.path, check, o.anchors.verifier);
    if (!anchored.ok) return { code: 1, reason: anchored.reason, line: anchored.line, detail: anchored.detail };
  }
  const { lines } = check;
  const cancelled = cancelledHashes(lines);
  const sigCache = new Map<string, Promise<Array<Record<string, string>>>>();
  const signaturesOf = (image: string) => {
    let pending = sigCache.get(image);
    if (!pending) {
      pending = o.verifier.signatures(image).catch((e: unknown) => {
        // 믿는 키로 확인되는 서명이 없음 (지웠거나 다른 키로만 서명)
        if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") return [];
        throw e;
      });
      sigCache.set(image, pending);
    }
    return pending;
  };

  const failures: ReconcileFailure[] = [];
  for (const { line, observed: ob } of observed) {
    const fail = (reason: ReconcileReason, detail: string) => failures.push({ line, target: ob.target, image: ob.image, reason, detail });
    const logged = lines.filter(
      (l) => l.entry.kind === "sign" && l.entry.result === "signed" && l.entry.signature_ref === `cosign:${ob.image}` && !cancelled.has(l.hash),
    );
    if (logged.length === 0) {
      fail("deploy_unlogged", "감사 로그에 이 이미지를 서명한 기록이 없음 (signer 밖에서 서명했거나 서명 없이 배포)");
      continue;
    }
    const sigs = await signaturesOf(ob.image);
    const signed = logged.filter((l) => sigs.some((sig) => sigMatchesLine(sig, l)));
    if (signed.length === 0) {
      fail("deploy_unsigned", "기록과 정확히 같은 서명이 레지스트리에 없음 (서명을 지웠거나 쌍둥이·signer 밖 서명만 있음)");
      continue;
    }
    const live = signed.filter((l) => revocationOf(lines, l) === undefined);
    if (live.length === 0) {
      const r = revocationOf(lines, signed[0]!);
      fail("deploy_revoked", `감사 로그 ${r?.seq ?? "?"}번째 줄에서 철회한 서명으로 떠 있음`);
      continue;
    }
    if (!live.some((l) => targetsOf(l)?.includes(ob.target))) {
      const signedTargets = live.map((l) => `${targetsOf(l)?.join("+") ?? "모름(예전 형식 줄)"} (run ${l.entry.kind === "sign" ? l.entry.run_id : "?"})`).join(", ");
      fail("target_not_signed", `서명한 배포 위치 ${signedTargets} / 관측 ${ob.target}`);
    }
  }
  return { code: failures.length === 0 ? 0 : 1, checked: observed.length, failures };
}

/** 서명 당시 기록한 targets. 주석 기록이 없는 예전 줄이면 모름 */
function targetsOf(line: AuditLine): string[] | undefined {
  return line.annotations?.targets !== undefined ? decodeTargets(line.annotations.targets) : undefined;
}

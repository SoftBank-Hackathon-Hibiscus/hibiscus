// 감사 로그 끝 고정(anchor). 지금 체인 끝(seq, hash)에 서명해서 따로 남겨 두면, 나중에 로그 끝을 잘라내거나 다시 써도 드러남.
// Rekor 를 켜면 서명이 공개 투명성 로그에도 남아서 "그 시각에 로그가 거기까지 있었다"를 제3자가 증명
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { checkAuditChain, GENESIS, type AuditCheck } from "./audit.js";
import type { BlobSigner, BlobVerifier } from "./cosign.js";
import { canonicalize, SignerError } from "./io.js";

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const AuditAnchorSchema = z
  .strictObject({
    kind: z.literal("audit_anchor"),
    seq: z.int().min(0).describe("고정한 줄 번호 (빈 로그면 0)"),
    head: Hex64.describe("그 줄의 hash (빈 로그면 0 이 64개)"),
    time: z.string(),
    bundle: z.looseObject({ mediaType: z.string().startsWith("application/vnd.dev.sigstore.bundle") }).describe("서명한 내용에 대한 sigstore bundle (cosign sign-blob --bundle)"),
  })
  .describe("감사 로그 끝 고정 한 줄. anchors 파일(jsonl)에 쌓임");
export type AuditAnchor = z.infer<typeof AuditAnchorSchema>;

/** 서명하는 내용. 필드 순서와 상관없이 같은 값이 되게 키 정렬 JSON */
export function anchorStatement(a: { seq: number; head: string; time: string }): string {
  return canonicalize({ type: "hibiscus-audit-anchor/v1", seq: a.seq, head: a.head, time: a.time });
}

export interface AnchorOptions {
  auditPath: string;
  anchorsPath: string;
  signer: BlobSigner;
  now?: () => Date;
}

/** 지금 체인 끝에 서명해서 anchors 파일에 한 줄 추가. 체인이 깨져 있으면 고정하지 않음 */
export async function runAnchor(o: AnchorOptions): Promise<AuditAnchor> {
  let text = "";
  try {
    text = readFileSync(o.auditPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SignerError("AUDIT_INVALID", `감사 로그 파일을 읽지 못함: ${o.auditPath}`);
  }
  const check = checkAuditChain(text);
  if (!check.ok) throw new SignerError("AUDIT_INVALID", `감사 로그 ${check.line}번째 줄 (${check.reason}): ${check.detail}. 고쳐진 기록은 고정하지 않음`);
  const last = check.lines.at(-1);
  const body = { seq: last?.seq ?? 0, head: last?.hash ?? GENESIS, time: (o.now ?? (() => new Date()))().toISOString() };
  const bundle = await o.signer.signBlob(anchorStatement(body));
  const parsed = AuditAnchorSchema.safeParse({ kind: "audit_anchor", ...body, bundle });
  if (!parsed.success) throw new SignerError("SIGN_FAILED", "cosign sign-blob 이 sigstore bundle 을 만들지 않음");
  const anchor = parsed.data;
  mkdirSync(dirname(resolve(o.anchorsPath)), { recursive: true });
  appendFileSync(o.anchorsPath, JSON.stringify(anchor) + "\n", "utf8");
  return anchor;
}

export type AnchorBreak = "anchor_invalid" | "anchor_signature_invalid" | "anchor_truncated" | "anchor_mismatch";

export type AnchorCheck = { ok: true; anchors: number } | { ok: false; line: number; reason: AnchorBreak; detail: string };

/**
 * anchors 파일의 고정값마다: 서명이 믿는 키의 것인지, 지금 감사 로그의 그 줄 hash 가 고정값과 같은지.
 * 줄이 모자라면 끝이 잘린 것(anchor_truncated), hash 가 다르면 다시 쓴 것(anchor_mismatch)
 */
export async function checkAnchors(anchorsPath: string, chain: Extract<AuditCheck, { ok: true }>, verifier: BlobVerifier): Promise<AnchorCheck> {
  let text: string;
  try {
    text = readFileSync(anchorsPath, "utf8");
  } catch {
    throw new SignerError("ANCHORS_MISSING", `감사 로그 끝 고정값 파일을 읽지 못함: ${anchorsPath}`);
  }
  const raw = text.split("\n").filter((l) => l.trim() !== "");
  // anchor 명령은 항상 한 줄 이상 남김. 비어 있으면 누가 고정값을 지운 것
  if (raw.length === 0) return { ok: false, line: 0, reason: "anchor_invalid", detail: `고정값 파일이 비어 있음: ${anchorsPath}` };
  for (const [i, line] of raw.entries()) {
    let anchor: AuditAnchor;
    try {
      anchor = AuditAnchorSchema.parse(JSON.parse(line));
    } catch {
      return { ok: false, line: 0, reason: "anchor_invalid", detail: `anchors 파일 ${i + 1}번째 줄 형식 오류` };
    }
    try {
      await verifier.verifyBlob(anchorStatement(anchor), anchor.bundle);
    } catch (e) {
      if (e instanceof SignerError && e.code === "SIGNATURE_INVALID") {
        return { ok: false, line: anchor.seq, reason: "anchor_signature_invalid", detail: `anchors 파일 ${i + 1}번째 고정값의 서명이 믿는 키와 안 맞음: ${e.message}` };
      }
      throw e;
    }
    if (anchor.seq === 0) {
      if (anchor.head !== GENESIS) return { ok: false, line: 0, reason: "anchor_mismatch", detail: "빈 로그 고정값인데 head 가 처음 값이 아님" };
      continue;
    }
    const at = chain.lines[anchor.seq - 1];
    if (!at) {
      return { ok: false, line: anchor.seq, reason: "anchor_truncated", detail: `${anchor.time} 에 ${anchor.seq}줄까지 고정했는데 지금 로그는 ${chain.lines.length}줄 (끝이 잘림)` };
    }
    if (at.hash !== anchor.head) {
      return { ok: false, line: anchor.seq, reason: "anchor_mismatch", detail: `${anchor.time} 에 고정한 ${anchor.seq}번째 줄 hash 와 지금 hash 가 다름 (다시 씀)` };
    }
  }
  return { ok: true, anchors: raw.length };
}

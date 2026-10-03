// needs_approval 승인 기록. run_id·digest·plan_hash·plan 해시가 지금 plan 과 다 맞아야 쓸 수 있음.
// 승인 기록은 그냥 JSON 파일이라 파일을 쓸 수 있으면 누구 이름으로든 만들 수 있음 → 켜면 승인자가 자기 SSH 키로 서명한 것만 받음
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseWith, SignerError } from "./io.js";
import type { LoadedPlan } from "./plan.js";
import { ApprovalSchema, samePerson, type Approval } from "./schema.js";

/** ssh 서명 namespace. 같은 키로 한 git 커밋 서명 등을 승인 서명으로 쓰지 못하게 */
export const APPROVAL_NAMESPACE = "hibiscus-approval";

export function createApproval(loaded: LoadedPlan, requester: string, approver: string, now: Date): Approval {
  const { plan, planSha256 } = loaded;
  if (plan.decision !== "needs_approval") {
    throw new SignerError("APPROVAL_NOT_NEEDED", `decision 이 ${plan.decision} 라 승인 기록을 만들지 않음 (needs_approval 일 때만)`);
  }
  if (samePerson(approver, requester)) throw new SignerError("SELF_APPROVAL", "요청자 본인은 승인할 수 없음 (대소문자만 다른 아이디도 같은 사람)");
  return parseWith(
    ApprovalSchema,
    {
      run_id: plan.run_id,
      digest: plan.digest,
      plan_hash: plan.plan_hash,
      plan_sha256: planSha256,
      requester,
      approver,
      approved_at: now.toISOString(),
    },
    "approval",
  );
}

/** 승인 기록과 파일 바이트. 서명 확인과 내용 읽기를 같은 바이트로 해서, 확인한 뒤 파일을 바꿔치기해도 소용없게 */
export function readApproval(path: string): { approval: Approval; bytes: Buffer } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new SignerError("READ_FAILED", `approval 파일을 읽지 못함: ${path}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SignerError("JSON_INVALID", `approval 파일이 JSON 이 아님: ${path}`);
  }
  return { approval: parseWith(ApprovalSchema, data, "approval"), bytes };
}

export function loadApproval(path: string): Approval {
  return readApproval(path).approval;
}

/** ssh-keygen 실행. input 을 stdin 으로 넘김 */
function sshKeygen(bin: string, args: string[], input: Buffer): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "ENOENT" ? new SignerError("SSH_KEYGEN_MISSING", `ssh-keygen 이 없음 (승인 서명에 필요, OpenSSH 8.1 이상): ${bin}`) : e);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {
      // 프로세스가 먼저 끝나면 무시 (종료 코드로 판단)
    });
    child.stdin.end(input);
  });
}

/**
 * 승인 기록 파일에 승인자 SSH 키로 서명해서 <파일>.sig 로 저장 (ssh-keygen -Y sign, namespace hibiscus-approval).
 * 키는 개인키 파일 또는 ssh-agent 에 올린 키의 공개키 파일
 */
export async function signApprovalFile(approvalPath: string, sshKeyPath: string, bin = "ssh-keygen"): Promise<string> {
  const bytes = readFileSync(approvalPath);
  const r = await sshKeygen(bin, ["-Y", "sign", "-f", sshKeyPath, "-n", APPROVAL_NAMESPACE], bytes);
  if (r.code !== 0 || !r.stdout.includes("BEGIN SSH SIGNATURE")) {
    throw new SignerError("APPROVAL_SIGN_FAILED", `승인 기록에 서명하지 못함: ${r.stderr.trim().split("\n").pop() ?? ""}`);
  }
  const sigPath = `${approvalPath}.sig`;
  writeFileSync(sigPath, r.stdout, "utf8");
  return sigPath;
}

export type ApprovalSignatureCheck = { ok: true; key: string } | { ok: false; detail: string };

/**
 * 승인 기록 바이트가 승인자(approver)의 서명인지. 승인자 명부(ssh allowed_signers)에 그 id 로 적힌 키여야 함.
 * key 는 서명한 키 지문 (SHA256:…)
 */
export async function verifyApprovalSignature(bytes: Buffer, sigPath: string, approver: string, allowedSignersPath: string, bin = "ssh-keygen"): Promise<ApprovalSignatureCheck> {
  if (!existsSync(allowedSignersPath)) throw new SignerError("APPROVERS_MISSING", `승인자 명부 파일이 없음: ${allowedSignersPath}`);
  if (!existsSync(sigPath)) return { ok: false, detail: `승인자 서명 파일이 없음: ${sigPath}` };
  const r = await sshKeygen(bin, ["-Y", "verify", "-f", allowedSignersPath, "-I", approver, "-n", APPROVAL_NAMESPACE, "-s", sigPath], bytes);
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    const why = out.split("\n").map((l) => l.trim()).filter((l) => l !== "" && l !== "Could not verify signature.").pop() ?? "";
    return { ok: false, detail: `승인자(${approver}) 서명이 아님 또는 승인자 명부에 없음${why ? `: ${why}` : ""}` };
  }
  const key = /with \S+ key (SHA256:[A-Za-z0-9+/=]+)/.exec(out)?.[1];
  if (key === undefined) throw new SignerError("APPROVAL_VERIFY_OUTPUT_INVALID", `ssh-keygen -Y verify 출력에서 키 지문을 못 찾음: ${out.trim().slice(0, 200)}`);
  return { ok: true, key };
}

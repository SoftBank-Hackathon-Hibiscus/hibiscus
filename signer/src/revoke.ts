// 서명 철회. 서명은 한 번 붙으면 계속 유효해서, 나중에 취약점이 나오거나 정책이 바뀐 이미지를 예전 sign_result 로 다시 배포할 수 있음.
// 감사 로그에 철회 줄을 남기면 verify --audit 가 그 서명을 거부하고, 이미지 전체 철회면 다시 서명하지도 않음
import { appendAudit, readAuditState, type AuditOptions } from "./audit.js";
import { SignerError } from "./io.js";
import { RevokeSchema, type AuditLine } from "./schema.js";

export interface RevokeOptions {
  auditPath: string;
  digest: string;
  runId?: string | undefined;
  reason: string;
  by: string;
  note?: string | undefined;
  now?: () => Date;
  audit?: AuditOptions;
}

/**
 * 철회 줄 한 줄 추가. 그 digest(실행)의 signed 줄이 아직 없어도 미리 철회할 수 있음 (signed 는 그 수).
 * 같은 digest·run_id 철회가 이미 있으면 새로 안 쓰고 그 줄을 돌려줌 (재시도해도 줄이 쌓이지 않게)
 */
export async function runRevoke(o: RevokeOptions): Promise<{ line: AuditLine; signed: number; existing: boolean }> {
  const parsed = RevokeSchema.safeParse({
    kind: "revoke",
    time: (o.now ?? (() => new Date()))().toISOString(),
    digest: o.digest,
    ...(o.runId !== undefined ? { run_id: o.runId } : {}),
    reason: o.reason,
    by: o.by,
    ...(o.note !== undefined ? { note: o.note } : {}),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new SignerError("ARG_INVALID", `철회 기록 형식 오류 ${first?.path.join(".") || "(최상위)"}: ${first?.message ?? "알 수 없음"}`);
  }
  const { lines } = await readAuditState(o.auditPath, o.audit);
  const signed = lines.filter(
    (l) => l.entry.kind === "sign" && l.entry.result === "signed" && l.entry.digest === o.digest && (o.runId === undefined || l.entry.run_id === o.runId),
  ).length;
  const already = lines.find((l) => l.entry.kind === "revoke" && l.entry.digest === o.digest && l.entry.run_id === o.runId);
  if (already !== undefined) return { line: already, signed, existing: true };
  const line = await appendAudit(o.auditPath, parsed.data, undefined, o.audit);
  return { line, signed, existing: false };
}

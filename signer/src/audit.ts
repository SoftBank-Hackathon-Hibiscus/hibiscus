// 서명 감사 로그(해시 체인). 줄마다 앞 줄 hash 를 물고, signed 줄은 서명 직전 체인 끝(anchor)을 이미지 서명 주석 audit_head 로도 남김
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { logAnnotations } from "./annotations.js";
import { canonicalize, sha256Hex, SignerError } from "./io.js";
import { AuditLineSchema, type AuditEntry, type AuditLine, type SignResult } from "./schema.js";

/** 첫 줄의 prev_hash, 빈 감사 로그의 체인 끝 */
export const GENESIS = "0".repeat(64);

export interface AuditOptions {
  /** 잠금을 기다리는 최대 시간. 기본 5초 */
  lockTimeoutMs?: number;
  /** 이보다 오래된 잠금 파일은 죽은 프로세스가 남긴 것으로 보고 지움. 기본 30초 */
  staleMs?: number;
}

export type AuditBreak = "line_invalid" | "seq_gap" | "prev_mismatch" | "hash_mismatch" | "anchor_invalid" | "annotations_invalid" | "cancel_invalid";

export type AuditCheck =
  | { ok: true; lines: AuditLine[]; head: string }
  | { ok: false; line: number; reason: AuditBreak; detail: string };

export function auditHash(line: Omit<AuditLine, "hash">): string {
  // 없는 필드는 canonicalize 가 키를 빼서, 이 필드들이 없던 예전 줄 hash 는 그대로
  return sha256Hex(canonicalize({ seq: line.seq, prev_hash: line.prev_hash, entry: line.entry, anchor: line.anchor, annotations: line.annotations, cancels: line.cancels }));
}

export interface AuditExtra {
  /** signed 줄: 이미지 서명에 실제로 붙인 주석 전체 */
  annotations?: Record<string, string>;
  /** 서명 뒤 단계가 실패한 refused 줄: 취소하는 signed 줄 hash */
  cancels?: string;
}

/** 서명 직전 체인 끝 hash. 파일이 없거나 비었으면 GENESIS */
export async function readAuditHead(path: string, o: AuditOptions = {}): Promise<string> {
  return (await readAuditState(path, o)).head;
}

/** 체인 끝 hash 와 줄 전체 (체인을 처음부터 확인함). 파일이 없으면 빈 로그 */
export async function readAuditState(path: string, o: AuditOptions = {}): Promise<{ head: string; lines: AuditLine[] }> {
  return withLock(path, o, () => {
    const lines = allLines(path);
    return { head: lines.at(-1)?.hash ?? GENESIS, lines };
  });
}

/** 한 줄 추가. 마지막 줄 읽기와 추가를 잠금 안에서 한 번에 함 */
export async function appendAudit(path: string, entry: AuditEntry, anchor: string | undefined, o: AuditOptions = {}, extra: AuditExtra = {}): Promise<AuditLine> {
  return withLock(path, o, () => {
    const last = lastLine(path);
    const body = {
      seq: (last?.seq ?? 0) + 1,
      prev_hash: last?.hash ?? GENESIS,
      entry,
      ...(anchor !== undefined ? { anchor } : {}),
      ...(extra.annotations !== undefined ? { annotations: extra.annotations } : {}),
      ...(extra.cancels !== undefined ? { cancels: extra.cancels } : {}),
    };
    const line = AuditLineSchema.parse({ ...body, hash: auditHash(body) });
    appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
    return line;
  });
}

export function readAuditFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new SignerError("AUDIT_INVALID", `감사 로그 파일을 읽지 못함: ${path}`);
  }
}

/** 처음부터 끝까지 이어지는지 확인. 처음 끊긴 줄 번호(1부터)와 이유를 돌려줌 */
export function checkAuditChain(text: string): AuditCheck {
  if (text === "") return { ok: true, lines: [], head: GENESIS };
  const raw = text.split("\n");
  const complete = raw[raw.length - 1] === "";
  if (complete) raw.pop();

  const lines: AuditLine[] = [];
  const seen = new Set([GENESIS]);
  const signedByHash = new Map<string, AuditLine>();
  const cancelled = new Set<string>();
  // 주석 기록을 시작한 뒤의 signed 줄은 전부 기록이 있어야 함 (마지막 줄 기록만 지워 예전 형식 비교로 낮추지 못하게)
  let recording = false;
  let prev = GENESIS;
  for (const [i, text] of raw.entries()) {
    const n = i + 1;
    const broken = (reason: AuditBreak, detail: string): AuditCheck => ({ ok: false, line: n, reason, detail });
    if (!complete && n === raw.length) return broken("line_invalid", "파일이 줄바꿈 없이 끝남 (쓰다가 끊겼거나 잘림)");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return broken("line_invalid", "JSON 이 아님");
    }
    const parsed = AuditLineSchema.safeParse(data);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return broken("line_invalid", `형식 오류 ${first?.path.join(".") || "(최상위)"}: ${first?.message ?? "알 수 없음"}`);
    }
    const line = parsed.data;
    if (line.seq !== n) return broken("seq_gap", `seq 가 ${line.seq} 임 (${n} 이어야 함). 줄이 빠졌거나 순서가 바뀜`);
    if (line.prev_hash !== prev) return broken("prev_mismatch", "prev_hash 가 앞 줄 hash 와 다름");
    if (auditHash(line) !== line.hash) return broken("hash_mismatch", "내용과 hash 가 안 맞음 (줄이 고쳐짐)");
    const entry = line.entry;
    if (entry.kind === "sign" && entry.result === "signed") {
      if (line.anchor === undefined) return broken("anchor_invalid", "signed 줄에 anchor 가 없음");
      if (!seen.has(line.anchor)) return broken("anchor_invalid", "anchor 가 앞 줄 hash 가 아님 (체인을 다시 계산한 흔적)");
      // 기록한 주석은 이 줄 내용·anchor 와 같아야 함 (주석만 따로 고쳐 쌍둥이 서명에 맞추지 못하게)
      if (line.annotations === undefined && recording) return broken("annotations_invalid", "앞 signed 줄부터 서명 주석을 기록했는데 이 줄에는 없음 (지운 흔적)");
      if (line.annotations !== undefined) {
        recording = true;
        let expected: Record<string, string>;
        try {
          expected = logAnnotations(entry, line.anchor);
        } catch {
          return broken("annotations_invalid", "기록한 주석을 이 줄 내용으로 만들 수 없음");
        }
        const differs = Object.keys(expected).find((k) => line.annotations?.[k] !== expected[k]);
        if (differs) return broken("annotations_invalid", `기록한 주석 ${differs} 가 이 줄 내용·anchor 와 다름`);
      }
      if (line.cancels !== undefined) return broken("cancel_invalid", "signed 줄에 cancels 가 있음");
      signedByHash.set(line.hash, line);
    } else {
      if (line.anchor !== undefined) return broken("anchor_invalid", "서명 안 한 줄(거절·오류)에 anchor 가 있음");
      if (line.annotations !== undefined) return broken("annotations_invalid", "서명 안 한 줄(거절·오류)에 서명 주석이 있음");
      if (line.cancels !== undefined) {
        const target = signedByHash.get(line.cancels);
        if (entry.kind !== "sign" || entry.reason !== "sign_failed") return broken("cancel_invalid", "cancels 는 sign_failed 거절 줄에만");
        if (target === undefined || target.entry.kind !== "sign") return broken("cancel_invalid", "cancels 가 앞의 signed 줄 hash 가 아님");
        if (target.entry.run_id !== entry.run_id || target.entry.digest !== entry.digest) return broken("cancel_invalid", "취소하는 signed 줄과 run_id·digest 가 다름");
        if (cancelled.has(line.cancels)) return broken("cancel_invalid", "이미 취소한 signed 줄을 다시 취소함");
        cancelled.add(line.cancels);
      }
    }
    seen.add(line.hash);
    prev = line.hash;
    lines.push(line);
  }
  return { ok: true, lines, head: prev };
}

/** 서명 뒤 단계(자기 확인·증명서)가 실패해서 취소된 signed 줄 hash */
export function cancelledHashes(lines: readonly AuditLine[]): Set<string> {
  return new Set(lines.flatMap((l) => (l.cancels !== undefined ? [l.cancels] : [])));
}

/** 이 signed 줄을 철회한 줄 (같은 digest 이고 run_id 가 없거나 같음). 위치와 상관없이 철회는 철회 */
export function revocationOf(lines: readonly AuditLine[], signed: AuditLine): AuditLine | undefined {
  if (signed.entry.kind !== "sign") return undefined;
  const { digest, run_id } = signed.entry;
  return lines.find((l) => l.entry.kind === "revoke" && l.entry.digest === digest && (l.entry.run_id === undefined || l.entry.run_id === run_id));
}

/** 이 digest 의 서명 전부를 철회한 줄 (새로 서명하지 않음) */
export function digestRevocation(lines: readonly AuditLine[], digest: string): AuditLine | undefined {
  return lines.find((l) => l.entry.kind === "revoke" && l.entry.digest === digest && l.entry.run_id === undefined);
}

/** sign_result 에 해당하는 signed 줄. 같은 게 여러 개면 가장 뒤 */
export function findSignedLine(lines: readonly AuditLine[], r: SignResult): AuditLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const e = line.entry;
    if (
      e.kind === "sign" &&
      e.result === "signed" &&
      e.run_id === r.run_id &&
      e.digest === r.digest &&
      e.source_revision === r.source_revision &&
      e.plan_hash === r.plan_hash &&
      e.requester === r.requester &&
      e.approver === r.approver &&
      e.signature_ref === r.signature_ref &&
      e.time === r.signed_at
    ) {
      return line;
    }
  }
  return undefined;
}

// 마지막 줄. 체인 전체를 처음부터 확인해서 중간이라도 깨져 있으면 이어 쓰지 않음 (고친 기록 위에 새 서명을 쌓지 않게)
function lastLine(path: string): AuditLine | undefined {
  return allLines(path).at(-1);
}

function allLines(path: string): AuditLine[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new SignerError("AUDIT_INVALID", `감사 로그 파일을 읽지 못함: ${path}`);
  }
  const check = checkAuditChain(text);
  if (!check.ok) {
    throw new SignerError("AUDIT_INVALID", `감사 로그 ${check.line}번째 줄 (${check.reason}): ${check.detail}. 고쳐진 기록 위에는 이어 쓰지 않음: ${path}`);
  }
  return check.lines;
}

async function withLock<T>(path: string, o: AuditOptions, fn: () => T): Promise<T> {
  const lock = `${resolve(path)}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + (o.lockTimeoutMs ?? 5_000);
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = lockAge(lock);
      // 그 사이 풀렸으면 바로 다시, 오래된 잠금이면 지우고 다시
      if (age === undefined) continue;
      if (age > (o.staleMs ?? 30_000)) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new SignerError("AUDIT_LOCKED", `감사 로그 잠금을 못 잡음 (다른 서명이 쓰는 중이거나 잠금 파일이 남음): ${lock}`);
      await sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function lockAge(lock: string): number | undefined {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return undefined;
  }
}

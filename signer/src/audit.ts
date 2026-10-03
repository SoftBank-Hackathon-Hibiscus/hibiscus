// 서명 감사 로그(해시 체인). 줄마다 앞 줄 hash 를 물고, signed 줄은 서명 직전 체인 끝(anchor)을 이미지 서명 주석 audit_head 로도 남김
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { canonicalize, sha256Hex, SignerError } from "./io.js";
import { AuditLineSchema, type AuditLine, type SignLog, type SignResult } from "./schema.js";

/** 첫 줄의 prev_hash, 빈 감사 로그의 체인 끝 */
export const GENESIS = "0".repeat(64);

export interface AuditOptions {
  /** 잠금을 기다리는 최대 시간. 기본 5초 */
  lockTimeoutMs?: number;
  /** 이보다 오래된 잠금 파일은 죽은 프로세스가 남긴 것으로 보고 지움. 기본 30초 */
  staleMs?: number;
}

export type AuditBreak = "line_invalid" | "seq_gap" | "prev_mismatch" | "hash_mismatch" | "anchor_invalid";

export type AuditCheck =
  | { ok: true; lines: AuditLine[]; head: string }
  | { ok: false; line: number; reason: AuditBreak; detail: string };

export function auditHash(line: Omit<AuditLine, "hash">): string {
  // anchor 가 없으면 canonicalize 가 키를 뺌
  return sha256Hex(canonicalize({ seq: line.seq, prev_hash: line.prev_hash, entry: line.entry, anchor: line.anchor }));
}

/** 서명 직전 체인 끝 hash. 파일이 없거나 비었으면 GENESIS */
export async function readAuditHead(path: string, o: AuditOptions = {}): Promise<string> {
  return withLock(path, o, () => lastLine(path)?.hash ?? GENESIS);
}

/** 한 줄 추가. 마지막 줄 읽기와 추가를 잠금 안에서 한 번에 함 */
export async function appendAudit(path: string, entry: SignLog, anchor: string | undefined, o: AuditOptions = {}): Promise<AuditLine> {
  return withLock(path, o, () => {
    const last = lastLine(path);
    const body = { seq: (last?.seq ?? 0) + 1, prev_hash: last?.hash ?? GENESIS, entry, ...(anchor !== undefined ? { anchor } : {}) };
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
    if (line.entry.result === "signed") {
      if (line.anchor === undefined) return broken("anchor_invalid", "signed 줄에 anchor 가 없음");
      if (!seen.has(line.anchor)) return broken("anchor_invalid", "anchor 가 앞 줄 hash 가 아님 (체인을 다시 계산한 흔적)");
    } else if (line.anchor !== undefined) {
      return broken("anchor_invalid", "refused 줄에 anchor 가 있음");
    }
    seen.add(line.hash);
    prev = line.hash;
    lines.push(line);
  }
  return { ok: true, lines, head: prev };
}

/** sign_result 에 해당하는 signed 줄. 같은 게 여러 개면 가장 뒤 */
export function findSignedLine(lines: readonly AuditLine[], r: SignResult): AuditLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    const e = line.entry;
    if (
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
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SignerError("AUDIT_INVALID", `감사 로그 파일을 읽지 못함: ${path}`);
  }
  const check = checkAuditChain(text);
  if (!check.ok) {
    throw new SignerError("AUDIT_INVALID", `감사 로그 ${check.line}번째 줄 (${check.reason}): ${check.detail}. 고쳐진 기록 위에는 이어 쓰지 않음: ${path}`);
  }
  return check.lines.at(-1);
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

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageSigner, ImageVerifier } from "../src/cosign.js";
import { SignerError } from "../src/io.js";

export const FIXTURES = fileURLToPath(new URL("../fixtures/plans/", import.meta.url));
export const plan = (name: "allow" | "allow-onprem" | "needs-approval" | "block") => join(FIXTURES, `${name}.plan.json`);
export const REPO = "asia-northeast3-docker.pkg.dev/hib-test/apps/guestbook";
export const NOW = new Date("2026-10-01T03:00:00.000Z");

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), "signer-test-"));
}

export function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readLog(path: string): any[] {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

/** plan 을 복사하면서 일부 필드를 바꿈 (승인 뒤 plan 이 바뀐 상황 등) */
export function copyPlan(src: string, dir: string, patch: Record<string, unknown> = {}): string {
  const out = join(dir, "plan.json");
  writeFileSync(out, JSON.stringify({ ...readJsonFile(src), ...patch }, null, 2));
  return out;
}

/**
 * 받은 인자를 기록하는 가짜 서명기. 서명을 이미지별로 쌓아 두는 가짜 레지스트리 역할도 함
 * verify 는 cosign 처럼 "주석이 전부 맞는 서명이 하나라도 있으면" 통과
 */
export class RecordingSigner implements ImageSigner, ImageVerifier {
  calls: Array<{ imageRef: string; annotations: Record<string, string> }> = [];
  verifyCalls: Array<{ imageRef: string; annotations: Record<string, string> }> = [];
  constructor(private readonly fail = false) {}
  async sign(imageRef: string, annotations: Record<string, string>): Promise<string> {
    this.calls.push({ imageRef, annotations });
    if (this.fail) throw new Error("registry unreachable");
    return `cosign:${imageRef}`;
  }
  async verify(imageRef: string, annotations: Record<string, string>): Promise<void> {
    this.verifyCalls.push({ imageRef, annotations });
    const ok = this.calls.some((c) => c.imageRef === imageRef && Object.entries(annotations).every(([k, v]) => c.annotations[k] === v));
    if (!ok) throw new SignerError("SIGNATURE_INVALID", "cosign verify 실패: no matching signatures");
  }
}

/**
 * 받은 인자를 파일에 적고 끝나는 가짜 cosign.
 * expectArgs 를 주면 인자가 그것과 똑같을 때만 0, 아니면 1 (서명 주석이 안 맞는 상황)
 */
export function fakeCosign(dir: string, o: { code?: number; expectArgs?: string[] } = {}): { bin: string; argsFile: string } {
  const argsFile = join(dir, "args.txt");
  const bin = join(dir, "cosign");
  let check = `exit ${o.code ?? 0}`;
  if (o.expectArgs) {
    const expected = join(dir, "expected.txt");
    writeFileSync(expected, o.expectArgs.join("\n") + "\n");
    check = `cmp -s "${argsFile}" "${expected}" && exit 0\necho "Error: no matching signatures" >&2\nexit 1`;
  }
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho "boom: registry denied" >&2\n${check}\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

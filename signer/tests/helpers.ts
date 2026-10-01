import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageSigner } from "../src/cosign.js";

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

/** 받은 인자를 기록하는 가짜 서명기 */
export class RecordingSigner implements ImageSigner {
  calls: Array<{ imageRef: string; annotations: Record<string, string> }> = [];
  constructor(private readonly fail = false) {}
  async sign(imageRef: string, annotations: Record<string, string>): Promise<string> {
    this.calls.push({ imageRef, annotations });
    if (this.fail) throw new Error("registry unreachable");
    return `cosign:${imageRef}`;
  }
}

/**
 * source_revision 확정.
 *   - 앱 로컬 소스가 git 저장소 안이면 HEAD 를 실제 커밋으로 쓴다
 *   - 요청 값이 있는데 HEAD 와 다르면 실행을 거부한다
 *   - 작업 트리에 커밋 안 된 변경이 있으면 verified=false
 *   - git 저장소가 아니거나 HEAD 를 못 구하면 요청 값을 쓰되 verified=false
 */
import type { CommandRunner } from "./command-runner.js";

export interface RevisionResolution {
  source_revision: string;
  verified: boolean;
  head?: string;
  notes: string[];
}

export class RevisionMismatchError extends Error {
  constructor(
    readonly requested: string,
    readonly head: string,
  ) {
    super(`요청한 source_revision(${requested})이 앱 소스의 HEAD(${head})와 다릅니다. 소스를 맞추거나 요청 값을 확인하세요`);
  }
}

export class RevisionUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`source_revision 을 정할 수 없습니다. 앱 소스가 git 저장소가 아니면 요청에 source_revision 을 넣어야 합니다 (${detail})`);
  }
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export async function resolveSourceRevision(runner: CommandRunner, srcPath: string, requested?: string): Promise<RevisionResolution> {
  const notes: string[] = [];
  let head: string | undefined;
  try {
    const r = await runner.run({ command: "git", args: ["rev-parse", "HEAD"], cwd: srcPath, timeoutMs: 15_000 });
    const out = r.stdout.trim();
    if (r.code === 0 && FULL_SHA.test(out)) head = out;
    else notes.push(`git rev-parse HEAD 실패 (종료 코드 ${r.code}): ${r.stderr.trim() || out}`);
  } catch (e) {
    notes.push(`git 실행 불가: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (head === undefined) {
    if (requested === undefined) throw new RevisionUnavailableError(notes.join("; ") || "HEAD 없음");
    notes.push("HEAD 를 구하지 못해 요청 값을 그대로 씀 (검증 안 됨)");
    return { source_revision: requested, verified: false, notes };
  }

  if (requested !== undefined && !(head === requested || head.startsWith(requested))) {
    throw new RevisionMismatchError(requested, head);
  }

  let verified = true;
  try {
    const s = await runner.run({ command: "git", args: ["status", "--porcelain", "--", "."], cwd: srcPath, timeoutMs: 15_000 });
    if (s.code !== 0) {
      verified = false;
      notes.push(`git status 실패 (종료 코드 ${s.code}): ${s.stderr.trim()}`);
    } else if (s.stdout.trim().length > 0) {
      verified = false;
      notes.push("앱 소스 폴더에 커밋 안 된 변경이 있음");
    }
  } catch (e) {
    verified = false;
    notes.push(`git status 실행 불가: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { source_revision: head, verified, head, notes };
}

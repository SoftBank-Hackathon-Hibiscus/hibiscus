import { describe, expect, it } from "vitest";
import { npmCommand, parseLastJsonLine, quoteForCmd } from "../src/command-runner.js";
import { BACKEND_ROOT, ConfigError, loadConfig } from "../src/config.js";
import { resolveSourceRevision, RevisionMismatchError, RevisionUnavailableError } from "../src/git.js";
import type { DeploymentRun } from "../src/models.js";
import { RunPaths } from "../src/paths.js";
import { realDeployBlockedReason } from "../src/stages/deploy.js";
import { realSignBlockedReason } from "../src/stages/sign.js";
import { placeholderDigest } from "../src/stages/test-stub.js";
import { FakeCommandRunner, HEAD, gitHandler } from "./helpers.js";

const baseRun: DeploymentRun = {
  run_id: "r-1",
  app_id: "a",
  trigger: "manual",
  source_revision: HEAD,
  source_revision_verified: true,
  digest: "sha256:" + "a".repeat(64),
  digest_source: "registry",
  status: "running",
  current_stage: "deploy",
  requester: "ryu",
  work_dir: "runs/r-1",
  execution_mode: "skeleton",
  deployment_performed: false,
  created_at: "t",
  updated_at: "t",
};

describe("command runner 도우미", () => {
  it("Windows 에서는 npm.cmd", () => {
    expect(npmCommand("win32")).toBe("npm.cmd");
    expect(npmCommand("linux")).toBe("npm");
  });

  it("공백이 있는 인자만 큰따옴표로 감싼다", () => {
    expect(quoteForCmd("--out-dir")).toBe("--out-dir");
    expect(quoteForCmd("C:\\Users\\Ryu J\\x")).toBe('"C:\\Users\\Ryu J\\x"');
    expect(quoteForCmd("")).toBe('""');
  });

  it("npm 의 echo 줄을 건너뛰고 마지막 JSON 줄을 읽는다", () => {
    const out = "> policy-engine@0.1.0 stage\n> tsx src/stage.ts\n\n{\"decision\":\"allow\"}\n";
    expect(parseLastJsonLine(out)).toEqual({ decision: "allow" });
    expect(parseLastJsonLine("no json")).toBeUndefined();
  });
});

describe("설정", () => {
  it("기본값: dry, off, backend/.work", () => {
    const c = loadConfig({}, BACKEND_ROOT);
    expect(c.signerMode).toBe("dry");
    expect(c.deployMode).toBe("off");
    expect(c.workDir.replace(/\\/g, "/")).toMatch(/backend\/\.work$/);
    expect(c.policyDir.replace(/\\/g, "/")).toMatch(/\/policy$/);
  });

  it("모르는 모드 값은 거부", () => {
    expect(() => loadConfig({ SIGNER_MODE: "yes" }, BACKEND_ROOT)).toThrow(ConfigError);
    expect(() => loadConfig({ DEPLOY_MODE: "maybe" }, BACKEND_ROOT)).toThrow(ConfigError);
  });
});

describe("실행 폴더", () => {
  it("run 별 폴더와 run 별 decisions.jsonl, 상대 경로는 / 구분자", () => {
    const p = new RunPaths("/work", "r-1");
    expect(p.relative(p.decisionsLog)).toBe("runs/r-1/decisions.jsonl");
    expect(p.relative(p.policy)).toBe("runs/r-1/policy");
  });
});

describe("자리표시자 digest", () => {
  it("형식이 맞고 run_id 로 결정된다", () => {
    expect(placeholderDigest("r-1")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(placeholderDigest("r-1")).toBe(placeholderDigest("r-1"));
    expect(placeholderDigest("r-1")).not.toBe(placeholderDigest("r-2"));
  });
});

describe("real 서명·배포 금지 규칙", () => {
  it("registry digest 이고 verified 면 real 서명 허용", () => {
    expect(realSignBlockedReason(baseRun)).toBeUndefined();
    expect(realSignBlockedReason({ ...baseRun, digest_source: "placeholder" })).toContain("digest_source=placeholder");
    expect(realSignBlockedReason({ ...baseRun, source_revision_verified: false })).toContain("source_revision_verified=false");
  });

  it("dry-run 서명, 검증 안 된 소스, 자리표시자 digest 는 real 배포 금지", () => {
    const ref = `cosign:example.com/app@${baseRun.digest}`;
    expect(realDeployBlockedReason(baseRun, ref)).toBeUndefined();
    expect(realDeployBlockedReason(baseRun, `dry-run:example.com/app@${baseRun.digest}`)).toContain("dry-run");
    expect(realDeployBlockedReason({ ...baseRun, source_revision_verified: false }, ref)).toContain("source_revision_verified=false");
    expect(realDeployBlockedReason({ ...baseRun, digest_source: "placeholder" }, ref)).toContain("digest_source=placeholder");
    expect(realDeployBlockedReason(baseRun, undefined)).toContain("sign_result");
  });
});

describe("source_revision 확정 규칙", () => {
  it("요청 없음 → HEAD 사용, verified=true", async () => {
    const r = await resolveSourceRevision(new FakeCommandRunner([gitHandler()]), "/src");
    expect(r).toMatchObject({ source_revision: HEAD, verified: true, head: HEAD });
  });

  it("요청 ≠ HEAD → 거부", async () => {
    await expect(resolveSourceRevision(new FakeCommandRunner([gitHandler()]), "/src", "deadbeef")).rejects.toBeInstanceOf(RevisionMismatchError);
  });

  it("커밋 안 된 변경 → verified=false", async () => {
    const r = await resolveSourceRevision(new FakeCommandRunner([gitHandler({ dirty: true })]), "/src", HEAD);
    expect(r.verified).toBe(false);
    expect(r.source_revision).toBe(HEAD);
  });

  it("git 저장소 아님 → 요청 값 사용 verified=false, 요청도 없으면 오류", async () => {
    const runner = new FakeCommandRunner([gitHandler({ head: undefined })]);
    const r = await resolveSourceRevision(runner, "/src", "abc1234");
    expect(r).toMatchObject({ source_revision: "abc1234", verified: false });
    await expect(resolveSourceRevision(runner, "/src")).rejects.toBeInstanceOf(RevisionUnavailableError);
  });

  it("git 자체를 실행할 수 없어도 요청 값으로 진행", async () => {
    const runner = new FakeCommandRunner([
      () => {
        throw new Error("spawn git ENOENT");
      },
    ]);
    const r = await resolveSourceRevision(runner, "/src", "abc1234");
    expect(r.verified).toBe(false);
    expect(r.notes[0]).toContain("ENOENT");
  });
});

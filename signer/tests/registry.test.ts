import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SignerError } from "../src/io.js";
import { CraneLister, readDigestsFile, sweepDigests, type RegistryLister } from "../src/registry.js";
import { runSign } from "../src/sign.js";
import { runAuditVerify } from "../src/verify.js";
import { copyPlan, NOW, plan, RecordingSigner, REPO, tmp } from "./helpers.js";

const hex = (c: string) => c.repeat(64);

/** 태그 목록과 태그별 digest 를 돌려주는 가짜 crane. 받은 인자는 args.txt 에 */
function fakeCrane(dir: string, o: { tags?: string[]; digests?: Record<string, string>; fail?: string } = {}): string {
  const bin = join(dir, "crane");
  const cases = Object.entries(o.digests ?? {})
    .map(([ref, d]) => `  "${ref}") echo "${d}" ;;`)
    .join("\n");
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$@" >> "${dir}/args.txt"
echo "DB_PASSWORD=\${DB_PASSWORD:-<unset>}" >> "${dir}/env.txt"
${o.fail !== undefined ? `echo 'Error: ${o.fail}' >&2; exit 1` : ""}
if [ "$1" = "ls" ]; then
${(o.tags ?? []).map((t) => `  echo "${t}"`).join("\n") || "  :"}
  exit 0
fi
case "$3" in
${cases}
  *) echo "Error: MANIFEST_UNKNOWN" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("CraneLister·sweepDigests", () => {
  it.each([
    [`sha256-${hex("a")}`, `sha256:${hex("a")}`],
    [`sha256-${hex("b")}.sig`, `sha256:${hex("b")}`],
    [`sha256-${hex("c")}.att`, `sha256:${hex("c")}`],
    [`sha256-${hex("d")}.sbom`, `sha256:${hex("d")}`],
  ])("서명 태그 %s 는 crane digest 없이 서명 대상 %s 로 읽음", async (tag, digest) => {
    const dir = tmp();
    const lister = new CraneLister(fakeCrane(dir, { tags: [tag] }));
    expect(await sweepDigests(lister, REPO)).toEqual({ digests: [digest], tags: 1, signatureTags: 1 });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n")).toEqual(["ls", "--", REPO]);
  });

  it("일반 태그(v1, 짧은 sha256-abc)는 crane digest -- <저장소>:<태그> 로 풂", async () => {
    const dir = tmp();
    const lister = new CraneLister(fakeCrane(dir, { tags: ["v1", "sha256-abc"], digests: { [`${REPO}:v1`]: `sha256:${hex("e")}`, [`${REPO}:sha256-abc`]: `sha256:${hex("f")}` } }));
    expect(await sweepDigests(lister, REPO)).toEqual({ digests: [`sha256:${hex("e")}`, `sha256:${hex("f")}`], tags: 2, signatureTags: 0 });
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain(`digest\n--\n${REPO}:v1`);
  });

  it("태그가 한도보다 많으면 일부만 보고 통과시키지 않고 SWEEP_TRUNCATED", async () => {
    const lister = new CraneLister(fakeCrane(tmp(), { tags: ["a", "b", "c"] }));
    await expect(sweepDigests(lister, REPO, 2)).rejects.toMatchObject({ code: "SWEEP_TRUNCATED" });
  });

  it("저장소가 없으면 빈 목록, 접속 실패는 REGISTRY_UNAVAILABLE, crane 이 없으면 CRANE_MISSING", async () => {
    expect(await new CraneLister(fakeCrane(tmp(), { fail: "reading tags: NAME_UNKNOWN: Unknown name" })).tags(REPO)).toEqual([]);
    await expect(new CraneLister(fakeCrane(tmp(), { fail: "dial tcp [::1]:5099: connect: connection refused" })).tags(REPO)).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" });
    await expect(new CraneLister(join(tmp(), "none")).tags(REPO)).rejects.toMatchObject({ code: "CRANE_MISSING" });
  });

  it("minimalEnv 면 crane 에도 걸러진 환경변수만 감", async () => {
    const dir = tmp();
    process.env.DB_PASSWORD = "hunter2";
    try {
      await new CraneLister(fakeCrane(dir), { minimalEnv: true }).tags(REPO);
    } finally {
      delete process.env.DB_PASSWORD;
    }
    expect(readFileSync(join(dir, "env.txt"), "utf8").trim()).toBe("DB_PASSWORD=<unset>");
  });
});

describe("readDigestsFile", () => {
  it("주석·빈 줄은 무시, <저장소>@ 가 있으면 저장소도", () => {
    const f = join(tmp(), "digests.txt");
    writeFileSync(f, `# gcloud 결과\n\nsha256:${hex("a")}\n${REPO}@sha256:${hex("b")}  # 태그 없음\n`);
    expect(readDigestsFile(f)).toEqual([{ digest: `sha256:${hex("a")}` }, { repo: REPO, digest: `sha256:${hex("b")}` }]);
  });

  it.each([["sha256:abc"], [`v1@sha256:${hex("a")}x`], [`@sha256:${hex("a")}`]])("틀린 줄은 줄 번호와 같이 DIGESTS_FILE_INVALID (%s)", (line) => {
    const f = join(tmp(), "digests.txt");
    writeFileSync(f, `sha256:${hex("a")}\n${line}\n`);
    expect(() => readDigestsFile(f)).toThrow(expect.objectContaining({ code: "DIGESTS_FILE_INVALID", message: expect.stringMatching(/2번째 줄/) }));
  });
});

/** RecordingSigner 의 서명을 cosign v3 처럼 sha256-<digest> 태그로 보여 주는 가짜 레지스트리 */
class FakeLister implements RegistryLister {
  constructor(private readonly signer: RecordingSigner, private readonly fail = false) {}
  async tags(repo: string): Promise<string[]> {
    if (this.fail) throw new SignerError("REGISTRY_UNAVAILABLE", "dial tcp");
    return [...new Set(this.signer.calls.filter((c) => c.imageRef.startsWith(`${repo}@`)).map((c) => `sha256-${c.imageRef.split("@sha256:")[1]}`))];
  }
  async digest(): Promise<string> {
    throw new Error("unused");
  }
}

describe("audit --images --sweep", () => {
  /** 진짜 로그로 b1 서명, 복사한 로그로 b2 서명 (운영자가 SIGNER_AUDIT_LOG 를 사본으로 바꿈) */
  async function forked() {
    const dir = tmp();
    const signer = new RecordingSigner();
    const auditPath = join(dir, "sign_audit.jsonl");
    const sign = async (runId: string, c: string, log: string) => {
      const d = join(dir, runId);
      mkdirSync(d, { recursive: true });
      const p = copyPlan(plan("allow-onprem"), d, { run_id: runId, digest: `sha256:${hex(c)}` });
      expect((await runSign({ planPath: p, requester: "alice", imageRepo: REPO, signer, outPath: join(d, "r.json"), logPath: join(d, "d.jsonl"), auditPath: log, now: () => NOW })).code).toBe(0);
    };
    await sign("r-1", "1", auditPath);
    const fork = join(dir, "fork.jsonl");
    copyFileSync(auditPath, fork);
    await sign("r-2", "2", fork);
    return { signer, auditPath };
  }

  it("복사한 로그로 한 서명은 로그에 없는 digest 라 훑기 없이는 안 보이고, 훑으면 갈라진 줄과 같이 unlogged_signature", async () => {
    const { signer, auditPath } = await forked();
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true })).toMatchObject({ code: 0 });
    expect(await runAuditVerify({ auditPath, verifier: signer, sweep: { lister: new FakeLister(signer) } })).toMatchObject({
      code: 1,
      line: 2,
      reason: "unlogged_signature",
      detail: expect.stringMatching(/1번째 줄 뒤에서 갈라짐/),
      swept: { signature_tags: 2, added: 1 },
    });
  });

  it("감사 로그 없이 한 새 이미지 서명은 훑기 + --strict-images 일 때만, 두 건이면 findings 2개 (첫 건이 code·reason)", async () => {
    const { signer, auditPath } = await forked();
    await signer.sign(`${REPO}@sha256:${hex("3")}`, { run_id: "r-998" });
    const sweep = { lister: new FakeLister(signer) };
    const loose = await runAuditVerify({ auditPath, verifier: signer, sweep });
    expect(loose).toMatchObject({ code: 1, findings: [{ reason: "unlogged_signature", run_id: "r-2" }] });
    const strict = await runAuditVerify({ auditPath, verifier: signer, strictImages: true, sweep });
    expect(strict).toMatchObject({ code: 1, reason: "unlogged_signature" });
    expect(strict.code === 1 && strict.findings?.map((f) => f.run_id)).toEqual(["r-2", "r-998"]);
  });

  it("서명이 다 로그에 있으면 훑어도 통과, 훑은 수가 남음", async () => {
    const dir = tmp();
    const signer = new RecordingSigner();
    const auditPath = join(dir, "sign_audit.jsonl");
    await runSign({ planPath: plan("allow-onprem"), requester: "alice", imageRepo: REPO, signer, outPath: join(dir, "r.json"), logPath: join(dir, "d.jsonl"), auditPath, now: () => NOW });
    expect(await runAuditVerify({ auditPath, verifier: signer, strictImages: true, sweep: { lister: new FakeLister(signer) } })).toMatchObject({
      code: 0,
      swept: { tags: 1, signature_tags: 1, file: 0, added: 0 },
    });
  });

  it("레지스트리 조회가 실패하면 빈 목록으로 통과시키지 않고 실행 오류", async () => {
    const { signer, auditPath } = await forked();
    await expect(runAuditVerify({ auditPath, verifier: signer, sweep: { lister: new FakeLister(signer, true) } })).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" });
  });

  it("태그 없는 이미지는 digest 목록 파일로", async () => {
    const { signer, auditPath } = await forked();
    const list = join(tmp(), "digests.txt");
    writeFileSync(list, `sha256:${hex("2")}\n`);
    const noTags: RegistryLister = { tags: async () => [], digest: async () => "" };
    expect(await runAuditVerify({ auditPath, verifier: signer, sweep: { lister: noTags, digestsFile: list } })).toMatchObject({ code: 1, reason: "unlogged_signature", swept: { file: 1, added: 1 } });
  });
});

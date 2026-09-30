/**
 * 코드 리뷰에서 나온 안전성 항목: 엄격한 digest / run_id, 롤백 대상 검증, 결정 기록 rule_ids 공통 함수,
 * 실행기의 --since 오류와 facts.migration 교차 검증, symlink 건너뛰기.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { decide, matchedRuleIds } from "../src/engine.js";
import { loadMigrationFiles } from "../src/migration/loader.js";
import { loadSources } from "../src/pii/extractor.js";
import { assertKnownTargets, decideRollback } from "../src/rollback/engine.js";
import { DecisionLogSchema, DigestSchema, PiiReportSchema, PolicySchema, RollbackRequestSchema, TestResultSchema } from "../src/schema.js";
import { StageError, runStage } from "../src/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const POLICY = join(ROOT, "policy.yaml");
const policy = PolicySchema.parse(parseYaml(readFileSync(POLICY, "utf8")));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const baseTest = TestResultSchema.parse(readJson("fixtures/01-allow/test_result.json"));
const D64 = `sha256:${"a".repeat(64)}`;

const tempDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-engine-safety-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("digest / run_id 엄격 검증", () => {
  it("digest 는 sha256: + 소문자 hex 64자만", () => {
    expect(DigestSchema.safeParse(D64).success).toBe(true);
    for (const bad of ["sha256:abc", `sha256:${"A".repeat(64)}`, `sha256:${"a".repeat(63)}`, `sha256:${"a".repeat(65)}`, `md5:${"a".repeat(64)}`, "a".repeat(64)]) {
      expect(DigestSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(TestResultSchema.safeParse({ ...baseTest, digest: "sha256:abc" }).success).toBe(false);
  });

  it("run_id 는 영문·숫자·._- 만, 1~64자", () => {
    for (const ok of ["r-001", "run_2026.09.30", "a", "x".repeat(64)]) {
      expect(TestResultSchema.safeParse({ ...baseTest, run_id: ok }).success, ok).toBe(true);
    }
    for (const bad of ["", "x".repeat(65), "r 001", "r/001", "실행-1", "r:1"]) {
      expect(TestResultSchema.safeParse({ ...baseTest, run_id: bad }).success, bad).toBe(false);
      expect(PiiReportSchema.safeParse({ run_id: bad, pii: [] }).success, bad).toBe(false);
    }
  });

  it("결정 기록의 digest·plan_hash 도 같은 스키마를 쓴다", () => {
    const plan = decide(baseTest, PiiReportSchema.parse({ run_id: baseTest.run_id, pii: [] }), policy);
    const entry = { kind: "deploy", time: "t", run_id: plan.run_id, digest: plan.digest, decision: plan.decision, targets: plan.targets, rule_ids: [], plan_hash: plan.plan_hash };
    expect(DecisionLogSchema.safeParse(entry).success).toBe(true);
    expect(DecisionLogSchema.safeParse({ ...entry, digest: "sha256:abc" }).success).toBe(false);
    expect(DecisionLogSchema.safeParse({ ...entry, plan_hash: "abc" }).success).toBe(false);
    expect(DecisionLogSchema.safeParse({ kind: "rollback", time: "t", run_id: "r", digest: D64, serve_digest: "sha256:0", decision: "rollback", targets: [], failover_allowed: false, rule_ids: [], plan_hash: plan.plan_hash }).success).toBe(false);
  });
});

describe("결정 기록 rule_ids 공통 함수", () => {
  it("matched 와 matched_after_block 을 구분 없이 id 만, not_matched 는 제외", () => {
    expect(
      matchedRuleIds([
        { id: "R1", result: "matched", reason: "a" },
        { id: "R2", result: "not_matched" },
        { id: "R5", result: "matched_after_block", reason: "b" },
        { id: "default", result: "matched", reason: "c" },
      ]),
    ).toEqual(["R1", "R5", "default"]);
  });

  it("정책 CLI 와 실행기의 기록이 같은 rule_ids 를 남긴다 (차단 후 규칙 포함)", async () => {
    const out = tmp();
    const r = spawnSync(
      process.execPath,
      [TSX, join(ROOT, "src", "cli.ts"), "--test", join(ROOT, "fixtures", "02-block-test-failed", "test_result.json"), "--pii", join(ROOT, "fixtures", "02-block-test-failed", "pii.json"), "--policy", POLICY, "--out", join(out, "p.json"), "--log", join(out, "cli.jsonl")],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const cliEntry = JSON.parse(readFileSync(join(out, "cli.jsonl"), "utf8").trim());
    expect(cliEntry.rule_ids).toEqual(["R1", "R5"]); // R5 는 matched_after_block

    const staged = await runStage({ src: join(ROOT, "samples", "no-pii"), testPath: join(ROOT, "fixtures", "02-block-test-failed", "test_result.json"), policyPath: POLICY, outDir: out, logPath: join(out, "stage.jsonl") });
    const stageEntry = JSON.parse(readFileSync(join(out, "stage.jsonl"), "utf8").trim());
    expect(stageEntry.rule_ids).toEqual(matchedRuleIds(staged.plan.rules));
    expect(stageEntry.rule_ids).toEqual(["R1", "R5"]);
  });
});

describe("롤백 요청의 targets 는 known_targets 안에 있어야 한다", () => {
  const req = RollbackRequestSchema.parse(readJson("fixtures/rollback/05-default.json"));

  it("모르는 대상이 있으면 에러 (어느 쪽인지 표시)", () => {
    const badStable = { ...req, stable: { ...req.stable, targets: ["onprem", "aws"] } };
    expect(() => assertKnownTargets(badStable, policy)).toThrow("알 수 없는 배포 대상: aws (rollback_request.stable.targets)");
    expect(() => decideRollback(badStable, policy)).toThrow("aws");
    const badCandidate = { ...req, candidate: { ...req.candidate, targets: ["edge"] } };
    expect(() => decideRollback(badCandidate, policy)).toThrow("rollback_request.candidate.targets");
    expect(() => decideRollback(req, policy)).not.toThrow();
  });

  it("롤백 CLI 는 형식 오류로 종료 코드 1", () => {
    const out = tmp();
    const bad = join(out, "req.json");
    writeFileSync(bad, JSON.stringify({ ...req, stable: { ...req.stable, targets: ["cloudrun"] } }));
    const r = spawnSync(process.execPath, [TSX, join(ROOT, "src", "rollback", "cli.ts"), "--request", bad, "--policy", POLICY, "--out", join(out, "rb.json"), "--log", join(out, "d.jsonl")], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cloudrun");
    expect(r.stderr).toContain("rollback_request");
  });
});

describe("실행기: --since 와 facts.migration 교차 검증", () => {
  it("--since 이름을 못 찾으면 [단계: migration] 실행 오류", async () => {
    const out = tmp();
    await expect(
      runStage({ src: join(ROOT, "samples", "migration-prisma"), testPath: join(ROOT, "fixtures", "01-allow", "test_result.json"), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl"), since: "20240115000000_typo" }),
    ).rejects.toMatchObject({ stage: "migration" });
    const r = spawnSync(
      process.execPath,
      [TSX, join(ROOT, "src", "stage.ts"), "--src", join(ROOT, "samples", "migration-prisma"), "--test", join(ROOT, "fixtures", "01-allow", "test_result.json"), "--policy", POLICY, "--out-dir", out, "--log", join(out, "d.jsonl"), "--since", "20240115000000_typo"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[단계: migration]");
    expect(r.stderr).toContain("20240115000000_typo");
  });

  it("테스트 파트의 facts.migration.destructive 가 실행기 계산과 다르면 두 값을 보여주며 멈춘다", async () => {
    const out = tmp();
    const testPath = join(out, "test_result.json");
    const given = { destructive: false, backward_compatible: true, findings: [] };
    writeFileSync(testPath, JSON.stringify({ ...baseTest, facts: { db: "postgres", migration: given } }));
    const err = await runStage({ src: join(ROOT, "samples", "migration-destructive"), testPath, policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).stage).toBe("migration");
    expect((err as StageError).message).toContain("destructive=false");
    expect((err as StageError).message).toContain("계산한 값은 true");
    expect((err as StageError).message).toContain("drop_column");
  });

  it("값이 같으면 테스트 파트 값을 그대로 쓴다 (findings 가 달라도 destructive 만 비교)", async () => {
    const out = tmp();
    const testPath = join(out, "test_result.json");
    const given = { destructive: true, backward_compatible: false, findings: [{ kind: "drop_table", statement: "DROP TABLE x", evidence: "given:1" }] };
    writeFileSync(testPath, JSON.stringify({ ...baseTest, facts: { db: "postgres", migration: given } }));
    const result = await runStage({ src: join(ROOT, "samples", "migration-destructive"), testPath, policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl") });
    expect(result.migrationComputed).toBe(false);
    expect(result.migration).toEqual(given);
    expect(result.summary.decision).toBe("block");
  });
});

describe("symlink 는 따라가지 않는다", () => {
  /** Windows 에서는 정션으로 만든다 (권한 없이 됨). 그래도 못 만들면 건너뛴다 */
  function makeLinkedApp(): { app: string; linkable: boolean } {
    const root = tmp();
    const app = join(root, "app");
    const outside = join(root, "outside");
    mkdirSync(join(app, "migrations"), { recursive: true });
    mkdirSync(join(outside, "migrations"), { recursive: true });
    writeFileSync(join(app, "schema.sql"), "CREATE TABLE t (id INTEGER PRIMARY KEY);\n");
    writeFileSync(join(app, "migrations", "0001_ok.sql"), "ALTER TABLE t ADD COLUMN note TEXT;\n");
    writeFileSync(join(outside, "secret.sql"), "CREATE TABLE users (phone TEXT);\n");
    writeFileSync(join(outside, "migrations", "0002_bad.sql"), "DROP TABLE t;\n");
    try {
      symlinkSync(outside, join(app, "linked"), "junction");
      symlinkSync(join(outside, "migrations"), join(app, "migrations", "linked"), "junction");
      return { app, linkable: true };
    } catch {
      return { app, linkable: false };
    }
  }

  it("소스 탐색과 마이그레이션 탐색 모두 건너뛰고 경로를 알린다", () => {
    const { app, linkable } = makeLinkedApp();
    if (!linkable) return; // 이 환경에서는 링크를 만들 수 없음
    const skipped: string[] = [];
    const files = loadSources(app, (p) => skipped.push(p));
    expect(files.map((f) => f.path)).toEqual(["migrations/0001_ok.sql", "schema.sql"]);
    expect(skipped).toEqual(["linked", "migrations/linked"]);

    const mskipped: string[] = [];
    const migrations = loadMigrationFiles(app, (p) => mskipped.push(p));
    expect(migrations.map((m) => m.name)).toEqual(["0001_ok"]);
    expect(mskipped).toEqual(["migrations/linked"]);
  });

  it("실행기는 건너뛴 경로를 notes 에, CLI 는 경고로 출력한다", async () => {
    const { app, linkable } = makeLinkedApp();
    if (!linkable) return;
    const out = tmp();
    const result = await runStage({ src: app, testPath: join(ROOT, "fixtures", "01-allow", "test_result.json"), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl") });
    expect(result.notes.filter((n) => n.includes("symlink"))).toEqual(["symlink 를 건너뜀: migrations/linked", "symlink 를 건너뜀: linked", "symlink 를 건너뜀: migrations/linked"]);
    expect(result.migration.destructive).toBe(false);
    const r = spawnSync(process.execPath, [TSX, join(ROOT, "src", "pii", "cli.ts"), "--src", app, "--run-id", "r-1", "--out", join(out, "pii.json")], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("경고: symlink 를 건너뜀: linked");
  });
});

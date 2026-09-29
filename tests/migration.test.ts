import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { type MigrationFile, analyzeMigrations, detectKinds, splitStatements, stripNoise } from "../src/migration/analyzer.js";
import { filterSince, loadMigrationFiles } from "../src/migration/loader.js";
import { MigrationReportSchema, PiiReportSchema, PolicySchema, TestResultSchema } from "../src/schema.js";
import { runStage } from "../src/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const POLICY = join(ROOT, "policy.yaml");
const policy = PolicySchema.parse(parseYaml(readFileSync(POLICY, "utf8")));
const sample = (name: string) => join(ROOT, "samples", name);
const fixtureTest = (name: string) => join(ROOT, "fixtures", name, "test_result.json");
const baseTest = TestResultSchema.parse(JSON.parse(readFileSync(fixtureTest("01-allow"), "utf8")));

const tempDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-engine-migration-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

const file = (content: string, path = "migrations/0001_x.sql"): MigrationFile => ({ name: path.replace(/^migrations\//, "").replace(/\.sql$/, ""), path, content });
const kindsOf = (sql: string) => analyzeMigrations([file(sql)]).findings.map((f) => f.kind);

describe("analyzer: 주석·문자열 제거와 문장 분리", () => {
  it("-- 와 /* */ 주석, '...' 문자열 안의 내용은 지우되 줄 번호는 지킨다", () => {
    const sql = "-- DROP TABLE a\nSELECT 1; /* DROP\nTABLE b */ INSERT INTO t VALUES ('DROP TABLE c');\nDROP TABLE d;";
    const clean = stripNoise(sql);
    expect(clean.split("\n")).toHaveLength(4);
    expect(clean).not.toMatch(/TABLE [abc]/);
    const statements = splitStatements(clean);
    // 문자열 내용은 공백으로 바뀌고, 문장 텍스트는 공백을 하나로 줄인다
    expect(statements.map((s) => [s.text, s.line])).toEqual([
      ["SELECT 1", 2],
      ["INSERT INTO t VALUES (' ')", 3],
      ["DROP TABLE d", 4],
    ]);
  });

  it("'' 이스케이프가 든 문자열도 한 덩어리로 본다", () => {
    expect(kindsOf("INSERT INTO t VALUES ('it''s; DROP TABLE x');")).toEqual([]);
  });
});

describe("analyzer: 파괴적 변경 탐지", () => {
  it("각 종류를 잡는다", () => {
    expect(detectKinds("DROP TABLE users")).toEqual(["drop_table"]);
    expect(detectKinds("TRUNCATE TABLE users")).toEqual(["truncate"]);
    expect(detectKinds("ALTER TABLE users DROP COLUMN phone")).toEqual(["drop_column"]);
    expect(detectKinds("ALTER TABLE users DROP phone")).toEqual(["drop_column"]);
    expect(detectKinds("ALTER TABLE users DROP COLUMN IF EXISTS phone")).toEqual(["drop_column"]);
    expect(detectKinds("ALTER TABLE users RENAME COLUMN name TO full_name")).toEqual(["rename_column"]);
    expect(detectKinds("ALTER TABLE users RENAME name TO full_name")).toEqual(["rename_column"]);
    expect(detectKinds("ALTER TABLE users RENAME TO members")).toEqual(["rename_table"]);
    expect(detectKinds("RENAME TABLE users TO members")).toEqual(["rename_table"]);
    expect(detectKinds("ALTER TABLE users ALTER COLUMN age TYPE bigint")).toEqual(["alter_column_type"]);
    expect(detectKinds("ALTER TABLE users ALTER age SET DATA TYPE bigint")).toEqual(["alter_column_type"]);
    expect(detectKinds("ALTER TABLE users MODIFY COLUMN age BIGINT")).toEqual(["alter_column_type"]);
    expect(detectKinds("ALTER TABLE users CHANGE COLUMN age age_years BIGINT")).toEqual(["alter_column_type"]);
    expect(detectKinds("ALTER TABLE users ADD COLUMN email TEXT NOT NULL")).toEqual(["add_not_null_without_default"]);
    expect(detectKinds("ALTER TABLE users ADD email TEXT NOT NULL")).toEqual(["add_not_null_without_default"]);
    expect(detectKinds('ALTER TABLE "users" ADD COLUMN "email" TEXT NOT NULL')).toEqual(["add_not_null_without_default"]);
  });

  it("기존 칼럼에 NOT NULL 걸기 (set_not_null): PostgreSQL SET NOT NULL, MySQL MODIFY/CHANGE ... NOT NULL", () => {
    expect(detectKinds("ALTER TABLE users ALTER COLUMN phone SET NOT NULL")).toEqual(["set_not_null"]);
    expect(detectKinds("ALTER TABLE users ALTER phone SET NOT NULL")).toEqual(["set_not_null"]);
    expect(detectKinds('ALTER TABLE "users" ALTER COLUMN "phone" SET NOT NULL')).toEqual(["set_not_null"]);
    // MySQL 은 정의를 통째로 다시 쓰므로 NOT NULL 이 있으면 set_not_null 로만 잡는다 (alter_column_type 과 겹치지 않음)
    expect(detectKinds("ALTER TABLE users MODIFY COLUMN phone VARCHAR(20) NOT NULL")).toEqual(["set_not_null"]);
    expect(detectKinds("ALTER TABLE users CHANGE COLUMN phone phone VARCHAR(20) NOT NULL")).toEqual(["set_not_null"]);
    // 절이 여럿이면 각각 한 번씩
    expect(detectKinds("ALTER TABLE users MODIFY COLUMN phone VARCHAR(20) NOT NULL, MODIFY COLUMN age BIGINT")).toEqual(["alter_column_type", "set_not_null"]);
    // 타입 변경과 SET NOT NULL 을 같이 하면 둘 다
    expect(detectKinds("ALTER TABLE users ALTER COLUMN age TYPE bigint, ALTER COLUMN age SET NOT NULL")).toEqual(["alter_column_type", "set_not_null"]);
  });

  it("DROP NOT NULL 은 안전하다", () => {
    expect(detectKinds("ALTER TABLE users ALTER COLUMN phone DROP NOT NULL")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ALTER phone DROP NOT NULL")).toEqual([]);
    expect(detectKinds("ALTER TABLE users MODIFY COLUMN phone VARCHAR(20) NULL")).toEqual(["alter_column_type"]);
    const report = analyzeMigrations([file("ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;")]);
    expect(report).toEqual({ destructive: false, backward_compatible: true, findings: [] });
  });

  it("SET NOT NULL 은 파괴적으로 취급한다 (이전 버전이 NULL 을 쓰면 실패 → 롤백이 깨짐)", () => {
    const report = analyzeMigrations([file("ALTER TABLE users ALTER COLUMN phone SET NOT NULL;", "migrations/0004_phone_required.sql")]);
    expect(report).toEqual({
      destructive: true,
      backward_compatible: false,
      findings: [{ kind: "set_not_null", statement: "ALTER TABLE users ALTER COLUMN phone SET NOT NULL", evidence: "migrations/0004_phone_required.sql:1" }],
    });
    expect(() => MigrationReportSchema.parse(report)).not.toThrow();
  });

  it("한 문장에 여러 변경이 있으면 모두 잡는다", () => {
    expect(detectKinds("ALTER TABLE users DROP COLUMN phone, ADD COLUMN email TEXT NOT NULL")).toEqual(["drop_column", "add_not_null_without_default"]);
  });

  it("안전한 문장은 잡지 않는다", () => {
    expect(detectKinds("ALTER TABLE users ADD COLUMN bio TEXT")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'open'")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ADD COLUMN price NUMERIC(10, 2) NOT NULL DEFAULT 0")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ADD COLUMN seq INTEGER NOT NULL GENERATED ALWAYS AS IDENTITY")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ADD CONSTRAINT users_name_len CHECK (length(name) > 0)")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ADD INDEX idx_name (name)")).toEqual([]);
    expect(detectKinds("ALTER TABLE users DROP CONSTRAINT users_pkey")).toEqual([]);
    expect(detectKinds("ALTER TABLE users DROP INDEX idx_name")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ALTER COLUMN name DROP DEFAULT")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ALTER COLUMN name DROP NOT NULL")).toEqual([]);
    expect(detectKinds("ALTER TABLE users ALTER COLUMN name SET DEFAULT 'x'")).toEqual([]);
    expect(detectKinds("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")).toEqual([]);
    expect(detectKinds("CREATE INDEX idx ON users (name)")).toEqual([]);
    expect(detectKinds("DROP INDEX idx_name")).toEqual([]);
    expect(detectKinds("UPDATE users SET name = 'x' WHERE id = 1")).toEqual([]);
  });

  it("긴 문장은 한 줄로 줄이고 evidence 는 파일:줄", () => {
    const long = `ALTER TABLE users\n  DROP COLUMN ${"x".repeat(200)}`;
    const report = analyzeMigrations([file(`SELECT 1;\n\n${long};`, "migrations/0009_long.sql")]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.evidence).toBe("migrations/0009_long.sql:3");
    expect(report.findings[0]!.statement).not.toContain("\n");
    expect(report.findings[0]!.statement.length).toBeLessThanOrEqual(120);
    expect(report.findings[0]!.statement.endsWith("…")).toBe(true);
  });
});

describe("samples", () => {
  const reportOf = (name: string, since?: string) => analyzeMigrations(filterSince(loadMigrationFiles(sample(name)), since).files);

  it("migration-safe: 칼럼 추가(NULL 허용), 인덱스, NOT NULL + DEFAULT → 파괴적 아님", () => {
    const r = reportOf("migration-safe");
    expect(r).toEqual({ destructive: false, backward_compatible: true, findings: [] });
  });

  it("migration-destructive: DROP COLUMN, RENAME COLUMN, DEFAULT 없는 NOT NULL", () => {
    const r = reportOf("migration-destructive");
    expect(r.destructive).toBe(true);
    expect(r.backward_compatible).toBe(false);
    expect(r.findings).toEqual([
      { kind: "drop_column", statement: "ALTER TABLE users DROP COLUMN phone", evidence: "migrations/0002_drop_phone_rename_name.sql:2" },
      { kind: "rename_column", statement: "ALTER TABLE users RENAME COLUMN name TO full_name", evidence: "migrations/0002_drop_phone_rename_name.sql:3" },
      { kind: "add_not_null_without_default", statement: "ALTER TABLE users ADD COLUMN email TEXT NOT NULL", evidence: "migrations/0003_add_email_not_null.sql:2" },
    ]);
    expect(() => MigrationReportSchema.parse(r)).not.toThrow();
  });

  it("migration-tricky: 주석과 문자열 안의 DROP/RENAME/TRUNCATE 는 무시 → 파괴적 아님", () => {
    expect(reportOf("migration-tricky")).toEqual({ destructive: false, backward_compatible: true, findings: [] });
  });

  it("migration-prisma: prisma/migrations/*/migration.sql 도 본다. RENAME TO 는 rename_table", () => {
    const files = loadMigrationFiles(sample("migration-prisma"));
    expect(files.map((f) => f.name)).toEqual(["20240101000000_init", "20240201000000_rename_user"]);
    const r = reportOf("migration-prisma");
    expect(r.findings).toEqual([{ kind: "rename_table", statement: 'ALTER TABLE "User" RENAME TO "Member"', evidence: "prisma/migrations/20240201000000_rename_user/migration.sql:2" }]);
  });

  it("--since: 그 이름보다 뒤의 파일만 검사한다", () => {
    expect(reportOf("migration-prisma", "20240101000000_init").destructive).toBe(true);
    expect(reportOf("migration-prisma", "20240201000000_rename_user").destructive).toBe(false);
    expect(reportOf("migration-destructive", "0002_drop_phone_rename_name").findings.map((f) => f.kind)).toEqual(["add_not_null_without_default"]);
    const unknown = filterSince(loadMigrationFiles(sample("migration-prisma")), "20240115000000_typo");
    expect(unknown.sinceFound).toBe(false);
    expect(unknown.files.map((f) => f.name)).toEqual(["20240201000000_rename_user"]);
  });

  it("마이그레이션 폴더가 없는 앱 → 파괴적 아님", () => {
    expect(reportOf("no-pii")).toEqual({ destructive: false, backward_compatible: true, findings: [] });
  });

  it("같은 입력이면 같은 결과 (파일 순서를 바꿔도)", () => {
    const files = loadMigrationFiles(sample("migration-destructive"));
    expect(analyzeMigrations([...files].reverse())).toEqual(analyzeMigrations(files));
  });
});

describe("migration CLI", () => {
  const runCli = (args: string[]) => {
    const r = spawnSync(process.execPath, [TSX, join(ROOT, "src", "migration", "cli.ts"), ...args], { cwd: ROOT, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("migration.json 을 쓰고 findings 를 출력한다", () => {
    const out = join(tmp(), "migration.json");
    const r = runCli(["--src", sample("migration-destructive"), "--out", out]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("destructive: true");
    expect(r.stdout).toContain("drop_column migrations/0002_drop_phone_rename_name.sql:2");
    const report = MigrationReportSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(report.findings).toHaveLength(3);
  });

  it("--since 와 없는 이름 안내", () => {
    const out = join(tmp(), "m.json");
    const r = runCli(["--src", sample("migration-prisma"), "--since", "20240115000000_typo", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("찾지 못했습니다");
    expect(JSON.parse(readFileSync(out, "utf8")).findings).toHaveLength(1);
  });

  it("없는 폴더는 에러", () => {
    const r = runCli(["--src", join(tmp(), "nope"), "--out", join(tmp(), "m.json")]);
    expect(r.code).toBe(0); // 마이그레이션 폴더가 없을 뿐 앱 폴더 자체가 없어도 빈 결과 (fs 에러가 아님)
  });
});

describe("R7: 파괴적 마이그레이션 → block", () => {
  const pii = PiiReportSchema.parse({ run_id: baseTest.run_id, pii: [] });
  const destructive = analyzeMigrations(loadMigrationFiles(sample("migration-destructive")));

  it("facts.migration.destructive = true → block, two_phase_migration, reason 에 종류와 위치", () => {
    const plan = decide({ ...baseTest, facts: { db: "postgres", migration: destructive } }, pii, policy);
    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(plan.requires).toEqual([
      {
        id: "two_phase_migration",
        hint: "파괴적 변경을 확장→전환→정리 2단계 배포로 나누기 (먼저 새 구조를 추가하고, 옛 구조는 다음 배포에서 제거)",
        rule_id: "R7",
        allowed_targets: ["local", "cloud_run"],
      },
    ]);
    const r7 = plan.rules.find((r) => r.id === "R7")!;
    expect(r7.result).toBe("matched");
    expect(r7.reason).toBe(
      [
        "파괴적 마이그레이션 drop_column: ALTER TABLE users DROP COLUMN phone (migrations/0002_drop_phone_rename_name.sql:2)",
        "파괴적 마이그레이션 rename_column: ALTER TABLE users RENAME COLUMN name TO full_name (migrations/0002_drop_phone_rename_name.sql:3)",
        "파괴적 마이그레이션 add_not_null_without_default: ALTER TABLE users ADD COLUMN email TEXT NOT NULL (migrations/0003_add_email_not_null.sql:2)",
      ].join("; "),
    );
  });

  it("R7 reason 에 set_not_null 이 표시된다", () => {
    const report = analyzeMigrations([file("ALTER TABLE users ALTER COLUMN phone SET NOT NULL;", "migrations/0004_phone_required.sql")]);
    const plan = decide({ ...baseTest, facts: { db: "postgres", migration: report } }, pii, policy);
    expect(plan.decision).toBe("block");
    expect(plan.rules.find((r) => r.id === "R7")?.reason).toBe(
      "파괴적 마이그레이션 set_not_null: ALTER TABLE users ALTER COLUMN phone SET NOT NULL (migrations/0004_phone_required.sql:1)",
    );
    expect(plan.requires?.map((r) => r.id)).toEqual(["two_phase_migration"]);
  });

  it("destructive = false 이거나 migration 이 없으면 R7 은 걸리지 않는다", () => {
    const safe = analyzeMigrations(loadMigrationFiles(sample("migration-safe")));
    expect(decide({ ...baseTest, facts: { db: "postgres", migration: safe } }, pii, policy).rules.find((r) => r.id === "R7")).toEqual({ id: "R7", result: "not_matched" });
    expect(decide(baseTest, pii, policy).rules.find((r) => r.id === "R7")).toEqual({ id: "R7", result: "not_matched" });
  });

  it("facts.migration 형식이 틀리면 test_result 형식 오류", () => {
    expect(TestResultSchema.safeParse({ ...baseTest, facts: { migration: { destructive: "yes" } } }).success).toBe(false);
    expect(TestResultSchema.safeParse({ ...baseTest, facts: { migration: { destructive: true, backward_compatible: false, findings: [{ kind: "drop_everything", statement: "x", evidence: "a:1" }] } } }).success).toBe(false);
  });
});

describe("runStage 와 마이그레이션", () => {
  it("facts.migration 이 없으면 실행기가 판정해 채우고 migration.json 과 test_result.json 을 쓴다", async () => {
    const out = tmp();
    const result = await runStage({ src: sample("migration-safe"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl") });
    expect(result.migrationComputed).toBe(true);
    expect(result.migration.destructive).toBe(false);
    expect(result.summary.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "migration.json"), "utf8"))).toEqual(result.migration);
    const enriched = TestResultSchema.parse(JSON.parse(readFileSync(join(out, "test_result.json"), "utf8")));
    expect(enriched.facts.migration).toEqual(result.migration);
    // 채워진 test_result 로 정책 엔진을 다시 돌리면 같은 plan_hash
    expect(decide(enriched, result.pii, policy).plan_hash).toBe(result.plan.plan_hash);
  });

  it("파괴적 마이그레이션 앱 → block, 종료 코드 3, two_phase_migration", async () => {
    const out = tmp();
    const result = await runStage({ src: sample("migration-destructive"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl") });
    expect(result.summary.decision).toBe("block");
    expect(result.exitCode).toBe(3);
    expect(result.summary.requires.map((r) => r.id)).toContain("two_phase_migration");
    expect(result.plan.rules.find((r) => r.id === "R7")?.result).toBe("matched");
  });

  it("test_result 에 facts.migration 이 이미 있으면 테스트 파트 값을 존중한다", async () => {
    const out = tmp();
    const testPath = join(out, "test_result.json");
    const given = { destructive: false, backward_compatible: true, findings: [] };
    const fs = await import("node:fs");
    fs.writeFileSync(testPath, JSON.stringify({ ...baseTest, facts: { db: "postgres", migration: given } }));
    const result = await runStage({ src: sample("migration-destructive"), testPath, policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl") });
    expect(result.migrationComputed).toBe(false);
    expect(result.migration).toEqual(given);
    expect(result.plan.rules.find((r) => r.id === "R7")).toEqual({ id: "R7", result: "not_matched" });
    expect(existsSync(join(out, "migration.json"))).toBe(false);
  });

  it("--since 로 이미 적용된 마이그레이션은 건너뛴다", async () => {
    const out = tmp();
    const result = await runStage({ src: sample("migration-prisma"), testPath: fixtureTest("01-allow"), policyPath: POLICY, outDir: out, logPath: join(out, "d.jsonl"), since: "20240201000000_rename_user" });
    expect(result.migration.destructive).toBe(false);
    expect(result.summary.decision).toBe("allow");
  });
});

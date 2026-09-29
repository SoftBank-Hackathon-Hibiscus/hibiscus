import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { explainPlan, explainRollbackPlan, shortDigest, shortHash } from "../src/explainer.js";
import { analyzeMigrations } from "../src/migration/analyzer.js";
import { loadMigrationFiles } from "../src/migration/loader.js";
import { HeuristicClassifier } from "../src/pii/classifier.js";
import { extract, loadSources } from "../src/pii/extractor.js";
import { decideRollback } from "../src/rollback/engine.js";
import { type Plan, PiiReportSchema, PolicySchema, type RollbackPlan, RollbackRequestSchema, TestResultSchema } from "../src/schema.js";
import { runStage } from "../src/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const POLICY = join(ROOT, "policy.yaml");
const policy = PolicySchema.parse(parseYaml(readFileSync(POLICY, "utf8")));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const tempDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-engine-explain-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 결정서 모으기: fixtures 4 + samples (pii 5, migration 4) + rollback fixtures 6
// ---------------------------------------------------------------------------

const DEPLOY_FIXTURES = readdirSync(join(ROOT, "fixtures")).filter((d) => d !== "rollback");
const fixturePlan = (name: string): Plan =>
  decide(TestResultSchema.parse(readJson(`fixtures/${name}/test_result.json`)), PiiReportSchema.parse(readJson(`fixtures/${name}/pii.json`)), policy);

const baseTest = TestResultSchema.parse(readJson("fixtures/01-allow/test_result.json"));
async function samplePlan(name: string): Promise<Plan> {
  const dir = join(ROOT, "samples", name);
  const pii = PiiReportSchema.parse({ run_id: baseTest.run_id, pii: await new HeuristicClassifier().classify(extract(loadSources(dir))) });
  const migration = analyzeMigrations(loadMigrationFiles(dir));
  return decide({ ...baseTest, facts: { ...baseTest.facts, migration } }, pii, policy);
}
const SAMPLES = readdirSync(join(ROOT, "samples"));

const ROLLBACK_FIXTURES = readdirSync(join(ROOT, "fixtures", "rollback")).map((f) => f.replace(/\.json$/, ""));
const rollbackPlan = (name: string): RollbackPlan => decideRollback(RollbackRequestSchema.parse(readJson(`fixtures/rollback/${name}.json`)), policy);

describe("모든 결정서에 대해 설명이 만들어진다", () => {
  it("fixtures 4개 + samples 9개 (ko, ja)", async () => {
    const plans = [...DEPLOY_FIXTURES.map(fixturePlan), ...(await Promise.all(SAMPLES.map(samplePlan)))];
    expect(plans.length).toBeGreaterThanOrEqual(13);
    for (const plan of plans) {
      for (const lang of ["ko", "ja"] as const) {
        const md = explainPlan(plan, { lang });
        expect(md.length, `${plan.run_id} ${lang}`).toBeGreaterThan(100);
        expect(md.startsWith(lang === "ko" ? "# 배포 결정:" : "# デプロイ判定:")).toBe(true);
        expect(md).toContain(shortHash(plan.plan_hash));
        expect(md).toContain(shortDigest(plan.digest));
        expect(md).toContain(lang === "ko" ? "## 이유" : "## 理由");
        expect(md).toContain(lang === "ko" ? "## 해결 조건" : "## 解決条件");
        expect(md).not.toMatch(/undefined|\[object Object\]/);
      }
    }
  });

  it("롤백 fixtures 6개 (ko, ja)", () => {
    for (const name of ROLLBACK_FIXTURES) {
      const plan = rollbackPlan(name);
      for (const lang of ["ko", "ja"] as const) {
        const md = explainRollbackPlan(plan, { lang });
        expect(md.startsWith(lang === "ko" ? "# 롤백 결정:" : "# ロールバック判定:"), `${name} ${lang}`).toBe(true);
        expect(md).toContain(shortHash(plan.plan_hash));
        expect(md).not.toMatch(/undefined|\[object Object\]/);
      }
    }
  });
});

describe("결정 종류별 결론 문장 (ko)", () => {
  it("allow: 어디에 배포되는지, failover 를 쉬운 말로", () => {
    const md = explainPlan(fixturePlan("01-allow"));
    expect(md).toContain("**배포 허용.** 이 이미지를 온프레(사내) 및 Cloud Run에 배포합니다.");
    expect(md).toContain("온프레가 멈추면 Cloud Run으로 트래픽을 넘깁니다.");
    expect(md).toContain("기본 정책을 적용했습니다: 개인정보 없음, 테스트 통과: 하이브리드 배포 허용");
    expect(md).toContain("- 해결할 것이 없습니다.");
  });

  it("allow + 개인정보: 온프레만, failover 안 함", () => {
    const md = explainPlan(fixturePlan("03-pii-confident"));
    expect(md).toContain("**배포 허용.** 이 이미지를 온프레(사내)에 배포합니다.");
    expect(md).toContain("온프레가 멈춰도 Cloud Run으로 넘기지 않습니다. Cloud Run에는 배포하지 않기 때문입니다.");
    expect(md).toContain("- 개인정보(contact, phone) 발견: src/routes/signup.js:24 (규칙 R4)");
  });

  it("needs_approval: 승인되면 어디에", () => {
    const md = explainPlan(fixturePlan("04-pii-unconfident"));
    expect(md).toContain("**사람 승인 필요.** 승인되면 온프레(사내)에 배포합니다.");
    expect(md).toContain("- **해당 칼럼이 개인정보인지 사람이 확인** — 충족 위치: 온프레(사내) 안에서만 (규칙 R3, `human_review_pii`)");
  });

  it("block: 배포하지 않음, 해결 조건과 위치, 차단 후 규칙은 따로", () => {
    const md = explainPlan(fixturePlan("02-block-test-failed"));
    expect(md).toContain("**배포 차단.** 이 이미지는 배포하지 않습니다.");
    expect(md).toContain("배포하지 않으므로 장애 시 전환도 없습니다.");
    expect(md).toContain("- 테스트 실패 (17/20 일치) (규칙 R1)");
    // fixture 02 는 sqlite 라 R5 가 차단 뒤에 걸린다
    expect(md).toContain("### 차단이 정해진 뒤에 걸린 규칙");
    expect(md).toContain("결정은 바꾸지 않았고, 배포 위치와 해결 조건에만 반영됐습니다.");
    expect(md).toContain("- SQLite 사용 (sqlite): 관리형 DB로 전환하기 전까지 클라우드 배포 제외 (규칙 R5)");
    expect(md).toContain("- **재생 불일치 요청을 고친 뒤 다시 테스트** — 충족 위치: 온프레(사내) 안에서만 (규칙 R1, `fix_tests`)");
    expect(md).toContain("- **SQLite를 PostgreSQL로 전환 (allowed_targets 안의 환경에서)** — 충족 위치: 온프레(사내) 안에서만 (규칙 R5, `managed_db`)");
  });

  it("차단 후 규칙이 없으면 그 절이 없다", () => {
    const md = explainPlan(fixturePlan("03-pii-confident"));
    expect(md).not.toContain("차단이 정해진 뒤");
  });

  it("규칙 id 는 괄호로만 나온다 (본문은 문장)", () => {
    const md = explainPlan(fixturePlan("04-pii-unconfident"));
    for (const line of md.split("\n").filter((l) => l.startsWith("- "))) {
      expect(line).not.toMatch(/^- R\d/);
    }
  });
});

describe("롤백 결론 문장 (ko)", () => {
  it("keep_stable / rollback / manual_recovery", () => {
    const keep = explainRollbackPlan(rollbackPlan("01-before-cutover"));
    expect(keep).toContain("**정상 버전 유지.** 되돌릴 것이 없습니다. 정상 버전(sha256:000000000000)이 계속 온프레(사내) 및 Cloud Run에서 트래픽을 받습니다.");

    const rb = explainRollbackPlan(rollbackPlan("03-pii-onprem"));
    expect(rb).toContain("**롤백.** 정상 버전(sha256:000000000000)으로 되돌립니다. 되돌리는 위치: 온프레(사내).");
    expect(rb).toContain("온프레가 멈춰도 Cloud Run으로 넘기지 않습니다. Cloud Run에는 배포하지 않기 때문입니다.");

    const manual = explainRollbackPlan(rollbackPlan("06-pii-and-db-incompatible"));
    expect(manual).toContain("**수동 복구 필요.** 자동으로 되돌릴 수 없습니다.");
    expect(manual).toContain("수동 복구 전까지 장애 시 전환은 없습니다.");
    expect(manual).toContain("### 수동 복구가 정해진 뒤에 걸린 규칙");
    expect(manual).toContain("- **DB 스키마를 이전 버전과 호환되게 복구한 뒤 롤백** — 충족 위치: 온프레(사내) 안에서만 (규칙 RB2, `manual_db_recovery`)");
    expect(manual).toContain("트래픽을 받을 버전 `미정`");
  });
});

describe("일본어 출력", () => {
  it("대상 이름과 결론이 일본어로 나오고 한국어 결론은 없다", () => {
    const md = explainPlan(fixturePlan("03-pii-confident"), { lang: "ja" });
    expect(md).toContain("# デプロイ判定: todo (実行 r-003)");
    expect(md).toContain("**デプロイ許可。** このイメージを オンプレ(社内) にデプロイします。");
    expect(md).toContain("オンプレが停止しても Cloud Run には切り替えません。");
    expect(md).toContain("(ルール R4)");
    expect(md).not.toContain("배포 허용");
    expect(md).not.toContain("온프레");

    const rb = explainRollbackPlan(rollbackPlan("06-pii-and-db-incompatible"), { lang: "ja" });
    expect(rb).toContain("**手動復旧が必要。**");
    expect(rb).toContain("### 手動復旧が決まった後に該当したルール");
  });

  it("allow 에서 두 대상은 「と」로 잇는다", () => {
    expect(explainPlan(fixturePlan("01-allow"), { lang: "ja" })).toContain("オンプレ(社内) と Cloud Run にデプロイします");
  });
});

describe("결정성", () => {
  it("같은 입력이면 같은 출력", () => {
    const plan = fixturePlan("02-block-test-failed");
    expect(explainPlan(plan)).toBe(explainPlan(structuredClone(plan)));
    expect(explainPlan(plan, { lang: "ja" })).toBe(explainPlan(plan, { lang: "ja" }));
    const rb = rollbackPlan("06-pii-and-db-incompatible");
    expect(explainRollbackPlan(rb)).toBe(explainRollbackPlan(structuredClone(rb)));
  });

  it("설명은 결정서를 바꾸지 않는다", () => {
    const plan = fixturePlan("02-block-test-failed");
    const before = JSON.stringify(plan);
    explainPlan(plan);
    explainPlan(plan, { lang: "ja" });
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("지문은 앞 12자", () => {
    expect(shortHash("0123456789abcdef0123")).toBe("0123456789ab");
    expect(shortDigest("sha256:0123456789abcdef0123")).toBe("sha256:0123456789ab");
  });
});

describe("explain CLI 와 실행기 --explain", () => {
  const runCli = (script: string, args: string[]) => {
    const r = spawnSync(process.execPath, [TSX, join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it("--plan 으로 stdout, --out 으로 파일, --rollback, --lang ja", () => {
    const dir = tmp();
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(fixturePlan("03-pii-confident")));
    const out = runCli("src/explain.ts", ["--plan", planPath]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe(explainPlan(fixturePlan("03-pii-confident")));

    const file = join(dir, "explain.md");
    const saved = runCli("src/explain.ts", ["--plan", planPath, "--lang", "ja", "--out", file]);
    expect(saved.code, saved.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(explainPlan(fixturePlan("03-pii-confident"), { lang: "ja" }));

    const rbPath = join(dir, "rb.json");
    writeFileSync(rbPath, JSON.stringify(rollbackPlan("04-no-writes")));
    const rb = runCli("src/explain.ts", ["--plan", rbPath, "--rollback"]);
    expect(rb.code, rb.stderr).toBe(0);
    expect(rb.stdout).toContain("**롤백.**");
  });

  it("형식이 안 맞거나 lang 이 틀리면 종료 코드 1", () => {
    const dir = tmp();
    const rbPath = join(dir, "rb.json");
    writeFileSync(rbPath, JSON.stringify(rollbackPlan("04-no-writes")));
    const wrong = runCli("src/explain.ts", ["--plan", rbPath]); // 롤백 결정서를 plan 으로 읽으면 형식 오류
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("plan 형식 오류");
    const badLang = runCli("src/explain.ts", ["--plan", rbPath, "--rollback", "--lang", "en"]);
    expect(badLang.code).toBe(1);
    expect(badLang.stderr).toContain("--lang");
  });

  it("runStage 에 explain: true 면 out-dir 에 explain.ko.md 와 explain.ja.md 를 쓴다", async () => {
    const out = tmp();
    const result = await runStage({
      src: join(ROOT, "samples", "signup-contact"),
      testPath: join(ROOT, "fixtures", "01-allow", "test_result.json"),
      policyPath: POLICY,
      outDir: out,
      logPath: join(out, "d.jsonl"),
      explain: true,
    });
    expect(Object.keys(result.explainPaths).sort()).toEqual(["ja", "ko"]);
    expect(readFileSync(join(out, "explain.ko.md"), "utf8")).toBe(explainPlan(result.plan));
    expect(readFileSync(join(out, "explain.ja.md"), "utf8")).toBe(explainPlan(result.plan, { lang: "ja" }));

    const without = await runStage({ src: join(ROOT, "samples", "no-pii"), testPath: join(ROOT, "fixtures", "01-allow", "test_result.json"), policyPath: POLICY, outDir: tmp(), logPath: join(out, "d.jsonl") });
    expect(without.explainPaths).toEqual({});
    expect(existsSync(join(out, "nope"))).toBe(false);
  });
});

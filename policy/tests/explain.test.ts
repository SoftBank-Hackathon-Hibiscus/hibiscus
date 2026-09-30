import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../src/engine.js";
import { explainPlan, explainRollbackPlan, shortDigest, shortHash, shortenDigests } from "../src/explainer.js";
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
// 한글 자모·호환 자모·완성형 음절만 (U+3131~U+D79D 처럼 넓게 잡으면 가나·한자까지 걸린다)
const HANGUL = /[ᄀ-ᇿㄱ-ㆎ가-힣]/;

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

async function allPlans(): Promise<Plan[]> {
  return [...DEPLOY_FIXTURES.map(fixturePlan), ...(await Promise.all(SAMPLES.map(samplePlan)))];
}

describe("모든 결정서에 대해 설명이 만들어진다", () => {
  it("fixtures 4개 + samples 9개 (ko, ja)", async () => {
    const plans = await allPlans();
    expect(plans.length).toBeGreaterThanOrEqual(13);
    for (const plan of plans) {
      for (const lang of ["ko", "ja"] as const) {
        const md = explainPlan(plan, { lang });
        expect(md.length, `${plan.run_id} ${lang}`).toBeGreaterThan(100);
        expect(md.startsWith(lang === "ko" ? "# 배포 결정:" : "# デプロイ判定：")).toBe(true);
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
        expect(md.startsWith(lang === "ko" ? "# 롤백 결정:" : "# ロールバック判定："), `${name} ${lang}`).toBe(true);
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
    expect(md).toContain("- **해당 칼럼이 개인정보인지 사람이 확인** — 이 위반을 해소하면 나머지 제약상 가능한 배포 위치: 온프레(사내) (규칙 R3, `human_review_pii`)");
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
    expect(md).toContain("- **재생 불일치 요청을 고친 뒤 다시 테스트** — 이 위반을 해소하면 나머지 제약상 가능한 배포 위치: 온프레(사내) (규칙 R1, `fix_tests`)");
    expect(md).toContain("- **SQLite를 PostgreSQL로 전환** — 이 위반을 해소하면 나머지 제약상 가능한 배포 위치: 온프레(사내) 및 Cloud Run (규칙 R5, `managed_db`)");
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
    expect(keep).toContain("- 컷오버 전 실패: 정상 버전 유지, 롤백 불필요 (규칙 RB1)");

    const rb = explainRollbackPlan(rollbackPlan("03-pii-onprem"));
    expect(rb).toContain("**롤백.** 정상 버전(sha256:000000000000)으로 되돌립니다. 되돌리는 위치: 온프레(사내).");
    expect(rb).toContain("온프레가 멈춰도 Cloud Run으로 넘기지 않습니다. Cloud Run에는 배포하지 않기 때문입니다.");
    expect(rb).toContain("- 온프레에 개인정보가 쓰임: Cloud Run으로 되돌리지 않고 온프레 안에서만 정상 버전으로 복구 (규칙 RB3)");

    const manual = explainRollbackPlan(rollbackPlan("06-pii-and-db-incompatible"));
    expect(manual).toContain("**수동 복구 필요.** 자동으로 되돌릴 수 없습니다.");
    expect(manual).toContain("수동 복구 전까지 장애 시 전환은 없습니다.");
    expect(manual).toContain("### 수동 복구가 정해진 뒤에 걸린 규칙");
    expect(manual).toContain("- **DB 스키마를 이전 버전과 호환되게 복구한 뒤 롤백** — 이 위반을 해소하면 나머지 제약상 가능한 배포 위치: 온프레(사내) (규칙 RB2, `manual_db_recovery`)");
    expect(manual).toContain("트래픽을 받을 버전 `미정`");
  });
});

describe("내부 용어·digest 가 설명에 새지 않는다", () => {
  it("설명 본문에 sha256 64자, allowed_targets, cloud_run 문자열이 없다 (모든 결정서, 두 언어)", async () => {
    const deploy = await allPlans();
    const rollback = ROLLBACK_FIXTURES.map(rollbackPlan);
    const docs = [
      ...deploy.flatMap((p) => [explainPlan(p), explainPlan(p, { lang: "ja" })]),
      ...rollback.flatMap((p) => [explainRollbackPlan(p), explainRollbackPlan(p, { lang: "ja" })]),
    ];
    expect(docs.length).toBeGreaterThan(30);
    for (const md of docs) {
      expect(md).not.toMatch(/sha256:[0-9a-f]{64}/i);
      expect(md).not.toContain("allowed_targets");
      expect(md).not.toContain("cloud_run");
    }
  });

  it("기본 규칙의 reason 과 hint 에 sha256 64자, allowed_targets, cloud_run 이 없다", () => {
    const texts: string[] = [];
    for (const rule of [...policy.rules, ...policy.rollback!.rules]) {
      texts.push(rule.reason.ko, rule.reason.ja ?? "");
      for (const r of rule.then.requires ?? []) texts.push(r.hint?.ko ?? "", r.hint?.ja ?? "");
    }
    texts.push(policy.default.reason.ko, policy.rollback!.default.reason.ko);
    for (const t of texts) {
      expect(t).not.toMatch(/sha256|allowed_targets|cloud_run|\{request\.stable\.digest\}/);
    }
  });

  it("reason 이나 hint 에 digest 가 통째로 들어 있어도 앞 12자로 줄인다 (안전장치)", () => {
    const long = `sha256:${"a".repeat(64)}`;
    expect(shortenDigests(`복구 대상 ${long} 입니다`)).toBe("복구 대상 sha256:aaaaaaaaaaaa 입니다");
    expect(shortenDigests("sha256:abc")).toBe("sha256:abc"); // 짧은 건 그대로

    const base = fixturePlan("03-pii-confident");
    const plan: Plan = {
      ...base,
      rules: [...base.rules, { id: "X", result: "matched", reason: `옛 버전 ${long}`, reason_i18n: { ja: `旧バージョン${long}` } }],
      requires: [{ id: "x", hint: `이미지 ${long} 로`, hint_i18n: { ja: `イメージ${long}へ` }, rule_id: "X", allowed_targets: ["local"] }],
    };
    for (const lang of ["ko", "ja"] as const) {
      const md = explainPlan(plan, { lang });
      expect(md).not.toMatch(/sha256:[0-9a-f]{64}/);
      expect(md).toContain("sha256:aaaaaaaaaaaa");
    }
  });
});

describe("일본어 출력", () => {
  it("기본 규칙 기준으로 ja 출력에 한글이 섞이지 않는다 (모든 결정서)", async () => {
    for (const plan of await allPlans()) {
      const md = explainPlan(plan, { lang: "ja" });
      expect(md, `${plan.run_id}: ${md}`).not.toMatch(HANGUL);
    }
    for (const name of ROLLBACK_FIXTURES) {
      const md = explainRollbackPlan(rollbackPlan(name), { lang: "ja" });
      expect(md, `${name}: ${md}`).not.toMatch(HANGUL);
    }
  });

  it("대상 이름·결론·해결 조건이 지정한 표현으로 나온다", () => {
    const allow = explainPlan(fixturePlan("03-pii-confident"), { lang: "ja" });
    expect(allow).toContain("# デプロイ判定：todo（実行r-003）");
    expect(allow).toContain("**デプロイ可。**このイメージをオンプレ（社内）にデプロイします。");
    expect(allow).toContain("オンプレが停止してもCloud Runには切り替えません。Cloud Runにはデプロイしないためです。");
    expect(allow).toContain("- 個人情報（contact、phone）を検出：src/routes/signup.js:24（ルールR4）");
    expect(allow).toContain("- 対応が必要な事項はありません。");
    expect(allow).toContain("判定ハッシュ`");
    expect(allow).not.toContain("デプロイ許可");
    expect(allow).not.toContain("フィンガープリント");

    const block = explainPlan(fixturePlan("02-block-test-failed"), { lang: "ja" });
    expect(block).toContain("**デプロイ不可。**");
    expect(block).toContain("### デプロイ不可が決まった後に該当したルール");
    expect(block).toContain("- **SQLiteをPostgreSQLへ移行** — この違反を解消した場合に残りの制約上可能なデプロイ先：オンプレ（社内）とCloud Run（ルールR5、`managed_db`）");
    expect(block).not.toContain("遮断");
    expect(block).not.toContain("満たす場所");
    expect(block).not.toContain("の中でのみ");

    const both = explainPlan(fixturePlan("01-allow"), { lang: "ja" });
    expect(both).toContain("このイメージをオンプレ（社内）とCloud Runにデプロイします。");
    expect(both).toContain("既定ポリシーを適用しました：個人情報なし、テスト合格：ハイブリッドデプロイを許可");

    const rb = explainRollbackPlan(rollbackPlan("06-pii-and-db-incompatible"), { lang: "ja" });
    expect(rb).toContain("**手動復旧が必要。**");
    expect(rb).toContain("### 手動復旧が決まった後に該当したルール");
    expect(rb).toContain("トラフィックを受けるバージョン`未定`");
    const keep = explainRollbackPlan(rollbackPlan("01-before-cutover"), { lang: "ja" });
    expect(keep).toContain("**正常稼働中のバージョンを維持。**");
    expect(keep).not.toContain("安定版");
  });

  it("일본어 문장에는 반각 괄호가 없고 단어 사이 공백이 없다 (기본 규칙 기준)", async () => {
    for (const plan of await allPlans()) {
      const md = explainPlan(plan, { lang: "ja" });
      for (const line of md.split("\n")) {
        if (line.startsWith("#") || line.startsWith("---") || line === "") continue;
        // 일본어 글자 바로 옆의 반각 괄호와, 일본어 글자 사이의 공백을 금지
        expect(line, line).not.toMatch(/[぀-ヿ一-鿿][()]|[()][぀-ヿ一-鿿]/);
        expect(line, line).not.toMatch(/[぀-ヿ一-鿿] [぀-ヿ一-鿿]/);
      }
    }
  });

  it("문자열만 적은 규칙은 ja 에서도 ko 문구로 나온다 (대체 동작)", () => {
    const custom = PolicySchema.parse({
      ...policy,
      rules: [{ id: "S1", if: { path: "test.passed", eq: true }, then: { targets: ["local"], requires: [{ id: "x_fix", hint: "한국어 힌트만 있음" }] }, reason: "한국어 근거만 있음" }],
    });
    const plan = decide(baseTest, PiiReportSchema.parse({ run_id: baseTest.run_id, pii: [] }), custom);
    const md = explainPlan(plan, { lang: "ja" });
    expect(md).toContain("- 한국어 근거만 있음（ルールS1）");
    expect(md).toContain("- **한국어 힌트만 있음** — この違反を解消した場合に残りの制約上可能なデプロイ先：オンプレ（社内）とCloud Run（ルールS1、`x_fix`）");
    // 틀은 일본어 그대로
    expect(md).toContain("**デプロイ可。**");
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

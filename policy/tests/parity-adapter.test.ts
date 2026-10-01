/**
 * parity 인계 묶음 → test_result 변환기와, 조건별 사실을 읽는 규칙(R1 / R1b / R1c)의 결과.
 * 입력은 fixtures/parity/ 의 방명록 실측(PR #10)이고, 가상 입력은 그 묶음의 replay / mismatches 만 바꿔 만든다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import {
  ParityAdapterError,
  type ParityDiagnostics,
  ParityDiagnosticsSchema,
  type ParityHandoff,
  ParityHandoffSchema,
  adaptParityHandoff,
  summarizeConditions,
} from "../src/adapters/parity.js";
import { decide } from "../src/engine.js";
import { explainPlan } from "../src/explainer.js";
import { type Plan, PiiReportSchema, PlanSchema, PolicySchema, type TestResult, TestResultSchema } from "../src/schema.js";
import { StageError, runStage } from "../src/stage-runner.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const POLICY = join(ROOT, "policy.yaml");
const policy = PolicySchema.parse(parseYaml(readFileSync(POLICY, "utf8")));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const HANDOFF_PATH = join(ROOT, "fixtures", "parity", "meeting_handoff.json");
const DIAGNOSTICS_PATH = join(ROOT, "fixtures", "parity", "meeting_result.diagnostics.json");
const sample = (name: string) => join(ROOT, "samples", name);

const handoff = (): ParityHandoff => ParityHandoffSchema.parse(readJson("fixtures/parity/meeting_handoff.json"));
const diagnostics = (): ParityDiagnostics => ParityDiagnosticsSchema.parse(readJson("fixtures/parity/meeting_result.diagnostics.json"));
const piiFor = (test: TestResult) => PiiReportSchema.parse({ run_id: test.run_id, pii: [] });
const planOf = (test: TestResult): Plan => decide(test, piiFor(test), policy);
const requiresOf = (plan: Plan) => plan.requires?.map((r) => r.id) ?? [];
const resultOf = (plan: Plan, id: string) => plan.rules.find((r) => r.id === id)?.result;

type Replay = ParityHandoff["result"]["replay"][number];
type Mismatch = ParityHandoff["result"]["mismatches"][number];

/** 방명록 묶음의 result 에서 replay 와 mismatches 만 바꾼 가상 입력 */
function variant(replay: Replay[], mismatches: Mismatch[], extra: Partial<ParityHandoff["result"]> = {}): ParityHandoff {
  const h = handoff();
  const passed = replay.every((e) => e.matched === e.total && e.error === undefined) && mismatches.length === 0;
  return { ...h, result: { ...h.result, passed, replay, mismatches, ...extra } };
}
const guestbookMismatch = (condition: string, index: number): Mismatch => {
  const m = handoff().result.mismatches.find((x) => x.condition === condition && x.index === index);
  if (!m) throw new Error(`fixture 에 ${condition} #${index} 불일치가 없음`);
  return m;
};
const ALL_PASS: Replay[] = [
  { condition: "none", total: 20, matched: 20 },
  { condition: "restart", total: 20, matched: 20 },
  { condition: "replace", total: 20, matched: 20 },
];
const withReplace = (matched: number, mismatches: Mismatch[], extra?: Partial<ParityHandoff["result"]>) =>
  variant([ALL_PASS[0]!, ALL_PASS[1]!, { condition: "replace", total: 20, matched }], mismatches, extra);

const tempDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-engine-parity-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
function runCli(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [TSX, join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// 변환: 관찰된 사실만 옮긴다
// ---------------------------------------------------------------------------
describe("parity 변환기: 사실만 옮긴다", () => {
  it("방명록 묶음 → run_id/app/digest/source_revision 은 metadata, passed 는 원본, match 는 none 조건", () => {
    const { test, warnings } = adaptParityHandoff(handoff(), diagnostics());
    expect(warnings).toEqual([]);
    expect(test.run_id).toBe("meeting-20260930-173237-f746f560b3");
    expect(test.app).toBe("guestbook");
    expect(test.digest).toBe(`sha256:${"0123456789abcdef".repeat(4)}`);
    expect(test.source_revision).toBe("b0a2c50db6c4012adc7e731d2d7fd728d8f35676");
    expect(test.passed).toBe(false); // parity 원본 종합값 그대로
    expect(test.match).toEqual({ total: 20, matched: 20 }); // none 조건
    expect(test.failures).toHaveLength(13); // 원본 mismatches 그대로
    expect(TestResultSchema.safeParse(test).success).toBe(true);
  });

  it("facts: db=sqlite, writes_local_file 은 local_upload/local_file 만, conditions 와 storage 는 원본 그대로", () => {
    const { test } = adaptParityHandoff(handoff());
    expect(test.facts.db).toBe("sqlite");
    expect(test.facts.writes_local_file).toEqual(["/app/uploads"]); // sqlite 경로(/app/data/data.db)는 제외
    expect(test.facts.storage).toEqual([
      { kind: "sqlite", path: "/app/data/data.db", storage: "container_layer" },
      { kind: "local_upload", path: "/app/uploads", storage: "container_layer" },
    ]);
    expect(test.facts.conditions?.map((c) => [c.name, c.total, c.matched, c.failed, c.mismatches.length])).toEqual([
      ["none", 20, 20, false, 0],
      ["restart", 20, 14, true, 6],
      ["replace", 20, 13, true, 7],
    ]);
    expect(summarizeConditions(test.facts.conditions!)).toBe("none 20/20, restart 14/20, replace 13/20");
  });

  it("mismatch 의 related_* 는 원본 facts 에서 찾은 조회값이고, 없으면 키 자체를 생략한다 (null 금지)", () => {
    const { test } = adaptParityHandoff(handoff());
    const replace = test.facts.conditions!.find((c) => c.name === "replace")!;
    expect(replace.mismatches.find((m) => m.index === 16)).toEqual({
      index: 16,
      request: "GET /uploads",
      related_fact: "/app/uploads",
      related_storage: "container_layer",
      related_kind: "local_upload",
    });
    expect(replace.mismatches.find((m) => m.index === 13)).toMatchObject({ related_fact: "/app/data/data.db", related_kind: "sqlite" });
    // GET /me 는 related_fact 가 null 이었다 → 세 키 모두 없음
    expect(replace.mismatches.find((m) => m.index === 11)).toEqual({ index: 11, request: "GET /me" });
    expect(JSON.stringify(test.facts)).not.toContain("null");
  });

  it("sqlite 사실이 없으면 db 를 생략한다 (none 으로 쓰지 않는다). facts 가 비면 writes_local_file 도 생략", () => {
    const h = handoff();
    const noSqlite = { ...h, result: { ...h.result, facts: h.result.facts.filter((f) => f.kind !== "sqlite") } };
    const a = adaptParityHandoff(noSqlite).test;
    expect("db" in a.facts).toBe(false);
    expect(a.facts.writes_local_file).toEqual(["/app/uploads"]);
    // related_fact 는 남지만 가리키는 사실이 없으므로 storage/kind 는 생략
    const posts = a.facts.conditions!.find((c) => c.name === "restart")!.mismatches.find((m) => m.index === 13);
    expect(posts).toEqual({ index: 13, request: "GET /posts", related_fact: "/app/data/data.db" });

    const b = adaptParityHandoff({ ...h, result: { ...h.result, facts: [] } }).test;
    expect("db" in b.facts).toBe(false);
    expect("writes_local_file" in b.facts).toBe(false);
    expect(b.facts.storage).toEqual([]);
  });

  it("같은 입력이면 같은 출력 (결정적)", () => {
    expect(adaptParityHandoff(handoff(), diagnostics())).toEqual(adaptParityHandoff(handoff(), diagnostics()));
  });
});

// ---------------------------------------------------------------------------
// 정책 결과: 판단은 규칙이 한다
// ---------------------------------------------------------------------------
describe("조건별 사실로 판단하는 규칙 (R1 / R1b / R1c)", () => {
  it("방명록 그대로 → block, requires 는 fix_restart_failure + managed_db + object_storage (fix_tests 없음)", () => {
    const plan = planOf(adaptParityHandoff(handoff(), diagnostics()).test);
    expect(plan.decision).toBe("block");
    expect(plan.targets).toEqual([]);
    expect(requiresOf(plan)).toEqual(["fix_restart_failure", "managed_db", "object_storage"]);
    expect(resultOf(plan, "R1")).toBe("not_matched"); // none 은 20/20. passed=false 는 conditions 가 있으면 보지 않는다
    expect(resultOf(plan, "R1b")).toBe("matched");
    expect(resultOf(plan, "R1c")).toBe("not_matched"); // restart 가 실패했으므로 "replace 에서만" 이 아니다
    expect(resultOf(plan, "R5")).toBe("matched_after_block");
    expect(resultOf(plan, "R6")).toBe("matched_after_block");
    expect(plan.rules.find((r) => r.id === "R1b")?.reason).toBe("재시작 후 불일치 (14/20 일치)");
    expect(plan.rules.find((r) => r.id === "R1b")?.reason_i18n?.ja).toBe("再起動後に不一致（14/20一致）");
    expect(plan.requires?.[0]).toMatchObject({
      id: "fix_restart_failure",
      hint: "재시작 후 상태·초기화 동작을 수정 (예: 시작할 때 데이터 삭제, 메모리에만 두는 세션)",
      hint_i18n: { ja: "再起動後の状態・初期化動作を修正（例：起動時のデータ削除、メモリのみのセッション）" },
      rule_id: "R1b",
      allowed_targets: ["onprem"],
    });
    expect(() => PlanSchema.parse(plan)).not.toThrow();
  });

  it("replace 에서 16번(업로드 유실)만 실패 → allow, targets [onprem], managed_db + object_storage", () => {
    const { test } = adaptParityHandoff(withReplace(19, [guestbookMismatch("replace", 16)]));
    expect(test.passed).toBe(false); // 원본 종합값은 그대로 false
    const plan = planOf(test);
    expect(plan.decision).toBe("allow"); // 그래도 차단하지 않는다: 판단은 조건별 사실로
    expect(plan.targets).toEqual(["onprem"]);
    expect(plan.failover_allowed).toBe(false);
    expect(requiresOf(plan)).toEqual(["managed_db", "object_storage"]);
    expect(["R1", "R1b", "R1c"].map((id) => resultOf(plan, id))).toEqual(["not_matched", "not_matched", "not_matched"]);
  });

  it("none 실패 → block, fix_tests (R1 의 reason 은 none 수치)", () => {
    const noneFail: Replay[] = [{ condition: "none", total: 20, matched: 18 }, ALL_PASS[1]!, ALL_PASS[2]!];
    const mismatches = [guestbookMismatch("restart", 11), guestbookMismatch("restart", 13)].map((m) => ({ ...m, condition: "none" }));
    const { test } = adaptParityHandoff(variant(noneFail, mismatches));
    expect(test.match).toEqual({ total: 20, matched: 18 });
    const plan = planOf(test);
    expect(plan.decision).toBe("block");
    expect(requiresOf(plan)).toEqual(["fix_tests", "managed_db", "object_storage"]);
    expect(resultOf(plan, "R1")).toBe("matched");
    expect(plan.rules.find((r) => r.id === "R1")?.reason).toBe("테스트 실패 (18/20 일치)");
    expect(resultOf(plan, "R1b")).toBe("not_matched");
  });

  it("replace 에서만 실패 + related_fact 없음 (GET /me) → block, investigate_replace_failure", () => {
    const { test } = adaptParityHandoff(withReplace(19, [guestbookMismatch("replace", 11)]));
    const plan = planOf(test);
    expect(plan.decision).toBe("block");
    expect(requiresOf(plan)).toEqual(["investigate_replace_failure", "managed_db", "object_storage"]);
    expect(resultOf(plan, "R1c")).toBe("matched");
    expect(plan.rules.find((r) => r.id === "R1c")?.reason).toBe("교체 후 불일치 중 저장 방식으로 설명되지 않는 요청 있음 (19/20 일치)");
    expect(plan.requires?.[0]).toMatchObject({ id: "investigate_replace_failure", rule_id: "R1c", allowed_targets: ["onprem"] });
  });

  it("replace 에서만 실패 + 모르는 kind 의 사실 → block, investigate_replace_failure", () => {
    const h = handoff();
    const cache = { kind: "cache_dir", path: "/app/cache", storage: "container_layer", evidence: "docker diff A /app/cache" };
    const mismatch: Mismatch = { condition: "replace", index: 18, request: "GET /cache/stats", expected: "200 {}", actual: "404 {}", related_fact: "/app/cache" };
    const { test } = adaptParityHandoff(withReplace(19, [mismatch], { facts: [...h.result.facts, cache] }));
    const replace = test.facts.conditions!.find((c) => c.name === "replace")!;
    expect(replace.mismatches[0]).toEqual({ index: 18, request: "GET /cache/stats", related_fact: "/app/cache", related_storage: "container_layer", related_kind: "cache_dir" });
    const plan = planOf(test);
    expect(plan.decision).toBe("block");
    expect(requiresOf(plan)).toContain("investigate_replace_failure");
    expect(resultOf(plan, "R1c")).toBe("matched");
  });

  it("replace 에서만 실패 + sqlite / local_file 사실 → 차단 없음 (R5 / R6 가 담당)", () => {
    const plan = planOf(adaptParityHandoff(withReplace(18, [guestbookMismatch("replace", 13), guestbookMismatch("replace", 16)])).test);
    expect(plan.decision).toBe("allow");
    expect(plan.targets).toEqual(["onprem"]);
    expect(requiresOf(plan)).toEqual(["managed_db", "object_storage"]);
  });

  it("none 과 replace 가 같이 실패하면 R1 이 차단하고 R1c 는 걸리지 않는다 (replace 에서만 이 아님)", () => {
    const replay: Replay[] = [{ condition: "none", total: 20, matched: 19 }, ALL_PASS[1]!, { condition: "replace", total: 20, matched: 19 }];
    const mismatches = [{ ...guestbookMismatch("restart", 11), condition: "none" }, guestbookMismatch("replace", 11)];
    const plan = planOf(adaptParityHandoff(variant(replay, mismatches)).test);
    expect(plan.decision).toBe("block");
    expect(resultOf(plan, "R1")).toBe("matched");
    expect(resultOf(plan, "R1c")).toBe("not_matched");
  });

  it("하위 호환: conditions 가 없는 기존 fixtures 는 passed 로 판단하고 결과가 그대로다", () => {
    const fixture = (name: string): TestResult => TestResultSchema.parse(readJson(`fixtures/${name}/test_result.json`));
    const pii = (name: string) => PiiReportSchema.parse(readJson(`fixtures/${name}/pii.json`));
    const ok = decide(fixture("01-allow"), pii("01-allow"), policy);
    expect(ok.decision).toBe("allow");
    expect(ok.targets).toEqual(["onprem", "cloud_run"]);
    expect(ok.rules.filter((r) => r.result !== "not_matched").map((r) => r.id)).toEqual(["default"]);

    const failed = decide(fixture("02-block-test-failed"), pii("02-block-test-failed"), policy);
    expect(failed.decision).toBe("block");
    expect(requiresOf(failed)).toEqual(["fix_tests", "managed_db"]);
    expect(resultOf(failed, "R1")).toBe("matched");
    expect(failed.rules.find((r) => r.id === "R1")?.reason).toBe("테스트 실패 (17/20 일치)");
    expect(resultOf(failed, "R1b")).toBe("not_matched");
    expect(resultOf(failed, "R1c")).toBe("not_matched");
  });
});

// ---------------------------------------------------------------------------
// 변환 거부와 경고
// ---------------------------------------------------------------------------
describe("변환 거부 / 경고", () => {
  it("재생이 중단된 조건(replay[].error)이 있으면 변환하지 않는다", () => {
    const h = handoff();
    const replay: Replay[] = [ALL_PASS[0]!, { condition: "restart", total: 20, matched: 10, error: "prepare: DockerError" }, { condition: "replace", total: 20, matched: 0, error: "NOT_EXECUTED" }];
    const interrupted = { ...h, result: { ...h.result, passed: false, replay, mismatches: [] } };
    expect(() => adaptParityHandoff(interrupted)).toThrow(ParityAdapterError);
    expect(() => adaptParityHandoff(interrupted)).toThrow(/재생이 중단된 조건.*restart \(prepare: DockerError\).*replace \(NOT_EXECUTED\)/);
  });

  it("진단 status 가 completed 가 아니면 오류", () => {
    const d = { ...diagnostics(), status: "error", error: { condition: "replace", code: "IMAGE_CHANGED", phase: "identity" } };
    expect(() => adaptParityHandoff(handoff(), d)).toThrow(/status 가 error.*IMAGE_CHANGED/);
  });

  it("진단의 registry_digest 가 metadata.digest 와 다르면 오류, 같으면 통과", () => {
    const other = `sha256:${"f".repeat(64)}`;
    expect(() => adaptParityHandoff(handoff(), { ...diagnostics(), registry_digest: other })).toThrow(/registry_digest.*다릅니다/);
    const same = adaptParityHandoff(handoff(), { ...diagnostics(), registry_digest: handoff().metadata.digest });
    expect(same.warnings).toEqual([]);
  });

  it("metadata.digest 가 진단의 local_image_id 와 같으면 경고만 하고 변환한다", () => {
    const d = diagnostics();
    const h = handoff();
    const localAsDigest = { ...h, metadata: { ...h.metadata, digest: d.local_image_id! } };
    const { test, warnings } = adaptParityHandoff(localAsDigest, d);
    expect(test.digest).toBe(d.local_image_id);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("local_image_id");
    expect(warnings[0]).toContain("레지스트리");
  });

  it("조건은 none / restart / replace 가 정확히 한 번씩: 빠지거나 모르는 조건이 있으면 오류", () => {
    // --conditions 로 조건을 줄여 돌려 replace 를 빼먹은 결과 (parity CLI 기본값은 PR #10 부터 none,restart,replace)
    expect(() => adaptParityHandoff(variant([ALL_PASS[0]!, ALL_PASS[1]!], []))).toThrow(/필요한 조건이 빠졌습니다: replace/);
    expect(() => adaptParityHandoff(variant([ALL_PASS[0]!, ALL_PASS[2]!], []))).toThrow(/필요한 조건이 빠졌습니다: restart/);
    expect(() => adaptParityHandoff(variant([ALL_PASS[1]!, ALL_PASS[2]!], []))).toThrow(/필요한 조건이 빠졌습니다: none/);
    expect(() => adaptParityHandoff(variant([...ALL_PASS, { condition: "replicas", total: 20, matched: 20 }], []))).toThrow(/모르는 조건이 있습니다: replicas/);
    expect(() => adaptParityHandoff(variant([ALL_PASS[0]!, ALL_PASS[1]!, { condition: "recreate", total: 20, matched: 20 }], []))).toThrow(/모르는 조건이 있습니다: recreate/);
    expect(() => adaptParityHandoff(variant([ALL_PASS[0]!, ALL_PASS[0]!, ALL_PASS[1]!, ALL_PASS[2]!], []))).toThrow(/같은 조건이 두 번/);
  });

  it("total 은 1 이상 (0/0 은 판정이 아님). 조건·불일치 수가 맞지 않으면 오류", () => {
    const h = handoff();
    const zero = { ...h, result: { ...h.result, replay: [{ condition: "none", total: 0, matched: 0 }, ALL_PASS[1]!, ALL_PASS[2]!] } };
    expect(ParityHandoffSchema.safeParse(zero).success).toBe(false);
    expect(() => adaptParityHandoff(variant([{ condition: "none", total: 20, matched: 19 }, ALL_PASS[1]!, ALL_PASS[2]!], []))).toThrow(/none: 불일치 0건인데 total-matched 는 1/);
    expect(() => adaptParityHandoff(variant(ALL_PASS, [guestbookMismatch("replace", 16)]))).toThrow(/replace: 불일치 1건인데/);
    expect(() => adaptParityHandoff(variant([{ condition: "none", total: 20, matched: 21 }, ALL_PASS[1]!, ALL_PASS[2]!], []))).toThrow(/matched\(21\)가 total\(20\)보다/);
  });

  it("format 이나 stage 가 다르면 형식 오류 (verify 결과는 받지 않는다)", () => {
    const h = handoff() as unknown as Record<string, unknown>;
    expect(ParityHandoffSchema.safeParse({ ...h, format: "parity-handoff-v2" }).success).toBe(false);
    expect(ParityHandoffSchema.safeParse({ ...h, result: { ...(h.result as object), stage: "verify" } }).success).toBe(false);
    expect(ParityHandoffSchema.safeParse({ ...h, metadata: { ...(h.metadata as object), digest: "sha256:abc" } }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI 와 실행기
// ---------------------------------------------------------------------------
describe("변환 CLI (src/adapters/cli.ts)", () => {
  it("방명록 묶음 + 진단 → 종료 코드 0, test_result.json 생성, 조건별 요약 출력", () => {
    const out = join(tmp(), "test_result.json");
    const r = runCli("src/adapters/cli.ts", ["--handoff", HANDOFF_PATH, "--diagnostics", DIAGNOSTICS_PATH, "--out", out]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("conditions: none 20/20, restart 14/20, replace 13/20");
    expect(r.stdout).toContain("passed    : false");
    expect(r.stderr).not.toContain("경고");
    const test = TestResultSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(test).toEqual(adaptParityHandoff(handoff(), diagnostics()).test);
  });

  it("재생이 중단된 묶음 → 종료 코드 1, 파일을 만들지 않는다", () => {
    const dir = tmp();
    const h = handoff();
    const interrupted = { ...h, result: { ...h.result, passed: false, replay: [ALL_PASS[0]!, { condition: "restart", total: 20, matched: 0, error: "replay: REPLAY_INTERRUPTED" }], mismatches: [] } };
    const input = join(dir, "handoff.json");
    writeFileSync(input, JSON.stringify(interrupted));
    const out = join(dir, "test_result.json");
    const r = runCli("src/adapters/cli.ts", ["--handoff", input, "--out", out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("재생이 중단된 조건");
    expect(existsSync(out)).toBe(false);
  });

  it("digest 를 로컬 image ID 로 넣으면 경고만 내고 종료 코드 0", () => {
    const dir = tmp();
    const h = handoff();
    const input = join(dir, "handoff.json");
    writeFileSync(input, JSON.stringify({ ...h, metadata: { ...h.metadata, digest: diagnostics().local_image_id } }));
    const r = runCli("src/adapters/cli.ts", ["--handoff", input, "--diagnostics", DIAGNOSTICS_PATH, "--out", join(dir, "test_result.json")]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("경고: metadata.digest 가 실행 진단의 local_image_id 와 같습니다");
  });

  it("필수 옵션이 빠지면 종료 코드 1", () => {
    expect(runCli("src/adapters/cli.ts", ["--handoff", HANDOFF_PATH]).code).toBe(1);
  });
});

describe("보안 단계 실행기 --handoff", () => {
  it("방명록 묶음 → block (종료 코드 3), out-dir 에 변환된 test_result.json, 설명에 조건별 재생 결과 줄", () => {
    const out = tmp();
    const r = runCli("src/stage.ts", ["--src", sample("no-pii"), "--handoff", HANDOFF_PATH, "--diagnostics", DIAGNOSTICS_PATH, "--policy", POLICY, "--out-dir", out, "--log", join(out, "d.jsonl"), "--explain"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.stdout).toContain("replay   : none 20/20, restart 14/20, replace 13/20");
    expect(r.stdout).toContain("decision : block");
    expect(r.stdout).toContain("fix_restart_failure");
    expect(r.stdout).not.toContain("fix_tests");
    const test = TestResultSchema.parse(JSON.parse(readFileSync(join(out, "test_result.json"), "utf8")));
    expect(test.facts.conditions?.map((c) => c.name)).toEqual(["none", "restart", "replace"]);
    expect(test.facts.migration).toBeDefined(); // 실행기가 채운다
    const plan = PlanSchema.parse(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")));
    expect(plan.source_revision).toBe("b0a2c50db6c4012adc7e731d2d7fd728d8f35676");
    expect(readFileSync(join(out, "explain.ko.md"), "utf8")).toContain("재생 결과: none 20/20, restart 14/20, replace 13/20");
    expect(readFileSync(join(out, "explain.ja.md"), "utf8")).toContain("再生結果：none 20/20、restart 14/20、replace 13/20");
  });

  it("--test 와 --handoff 를 같이 주면 종료 코드 1. --diagnostics 만 주면 종료 코드 1", () => {
    const out = tmp();
    const both = runCli("src/stage.ts", ["--src", sample("no-pii"), "--test", join(ROOT, "fixtures", "01-allow", "test_result.json"), "--handoff", HANDOFF_PATH, "--policy", POLICY, "--out-dir", out]);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain("함께 쓸 수 없습니다");
    const diagOnly = runCli("src/stage.ts", ["--src", sample("no-pii"), "--test", join(ROOT, "fixtures", "01-allow", "test_result.json"), "--diagnostics", DIAGNOSTICS_PATH, "--policy", POLICY, "--out-dir", out]);
    expect(diagOnly.code).toBe(1);
    expect(existsSync(join(out, "plan.json"))).toBe(false);
  });

  it("runStage: 변환 거부는 handoff 단계의 StageError, 경고는 notes 에 실린다", async () => {
    const dir = tmp();
    const h = handoff();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...h, result: { ...h.result, replay: [{ condition: "restart", total: 20, matched: 20 }], mismatches: [], passed: true } }));
    await expect(runStage({ src: sample("no-pii"), handoffPath: bad, policyPath: POLICY, outDir: dir, logPath: join(dir, "d.jsonl") })).rejects.toMatchObject({ stage: "handoff" });
    await expect(runStage({ src: sample("no-pii"), testPath: bad, handoffPath: bad, policyPath: POLICY, outDir: dir })).rejects.toBeInstanceOf(StageError);

    const local = join(dir, "local.json");
    writeFileSync(local, JSON.stringify({ ...h, metadata: { ...h.metadata, digest: diagnostics().local_image_id } }));
    const result = await runStage({ src: sample("no-pii"), handoffPath: local, diagnosticsPath: DIAGNOSTICS_PATH, policyPath: POLICY, outDir: dir, logPath: join(dir, "d.jsonl") });
    expect(result.notes.some((n) => n.includes("local_image_id"))).toBe(true);
    expect(result.summary.decision).toBe("block");
  });
});

describe("결정 설명의 조건별 재생 결과 줄", () => {
  it("facts.conditions 가 있을 때만, 결론 아래에 한 줄 (ko, ja)", () => {
    const test = adaptParityHandoff(handoff()).test;
    const plan = planOf(test);
    const ko = explainPlan(plan, { test });
    expect(ko).toContain("\n재생 결과: none 20/20, restart 14/20, replace 13/20\n");
    expect(ko.indexOf("재생 결과:")).toBeLessThan(ko.indexOf("## 이유"));
    expect(ko).toContain("- 재시작 후 불일치 (14/20 일치) (규칙 R1b)");
    const ja = explainPlan(plan, { test, lang: "ja" });
    expect(ja).toContain("再生結果：none 20/20、restart 14/20、replace 13/20");
    expect(ja).toContain("- 再起動後に不一致（14/20一致）（ルールR1b）");
    // test 를 주지 않거나 conditions 가 없으면 줄이 없다
    expect(explainPlan(plan)).not.toContain("재생 결과");
    const legacy = TestResultSchema.parse(readJson("fixtures/02-block-test-failed/test_result.json"));
    expect(explainPlan(planOf(legacy), { test: legacy })).not.toContain("재생 결과");
  });

  it("explain CLI 의 --test 옵션", () => {
    const dir = tmp();
    const test = adaptParityHandoff(handoff()).test;
    const testPath = join(dir, "test_result.json");
    const planPath = join(dir, "plan.json");
    writeFileSync(testPath, JSON.stringify(test));
    writeFileSync(planPath, JSON.stringify(planOf(test)));
    const r = runCli("src/explain.ts", ["--plan", planPath, "--test", testPath, "--lang", "ja"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("再生結果：none 20/20、restart 14/20、replace 13/20");
    expect(runCli("src/explain.ts", ["--plan", planPath]).stdout).not.toContain("再生結果");
  });
});

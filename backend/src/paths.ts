/**
 * run 하나의 실행 폴더: WORK_DIR/runs/<run_id>/{test,policy,sign,deploy}/ + decisions.jsonl
 * 결정 기록은 run 별로 분리한다 (동시 실행 시 줄이 섞이지 않게). 전 run 공용 파일은 만들지 않는다.
 */
import { mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export class RunPaths {
  readonly root: string;
  readonly test: string;
  readonly policy: string;
  readonly sign: string;
  readonly deploy: string;
  readonly decisionsLog: string;

  constructor(
    readonly workDir: string,
    readonly runId: string,
  ) {
    this.root = join(workDir, "runs", runId);
    this.test = join(this.root, "test");
    this.policy = join(this.root, "policy");
    this.sign = join(this.root, "sign");
    this.deploy = join(this.root, "deploy");
    this.decisionsLog = join(this.root, "decisions.jsonl");
  }

  ensureDirs(): void {
    for (const dir of [this.test, this.policy, this.sign, this.deploy]) mkdirSync(dir, { recursive: true });
  }

  /** WORK_DIR 기준 상대 경로 (구분자는 / 로 통일) */
  relative(absolute: string): string {
    return relative(this.workDir, resolve(absolute)).split("\\").join("/");
  }
}

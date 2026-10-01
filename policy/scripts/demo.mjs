// fixtures 4세트를 차례로 CLI 에 넣어 out/ 에 plan 을 만든다. (발표 데모용)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const outDir = join(root, "out");
rmSync(outDir, { recursive: true, force: true });

for (const name of readdirSync(join(root, "fixtures")).sort()) {
  const dir = join(root, "fixtures", name);
  if (!existsSync(join(dir, "test_result.json"))) continue; // rollback/, parity/ 는 다른 형식
  console.log(`\n=== ${name} ===`);
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "tsx", "dist", "cli.mjs"),
      join(root, "src", "cli.ts"),
      "--test", join(dir, "test_result.json"),
      "--pii", join(dir, "pii.json"),
      "--policy", join(root, "policy.yaml"),
      "--out", join(outDir, `${name}.plan.json`),
      "--log", join(outDir, "decisions.jsonl"),
    ],
    { stdio: "inherit", cwd: root },
  );
}
console.log(`\n결과: ${outDir}`);

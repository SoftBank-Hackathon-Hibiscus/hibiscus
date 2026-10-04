import test from "node:test";
import assert from "node:assert/strict";
import { parseDockerLogs } from "../runtime-log-collector.js";
void test("Docker logs parse timestamps, mask credentials and keep stable IDs", () => {
  const text =
    "2026-10-03T00:00:00.123456789Z ERROR token=abcdef raw-secret\nnot a log";
  const first = parseDockerLogs(text, "stderr", ["raw-secret"]);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.timestamp, "2026-10-03T00:00:00.123Z");
  assert.equal(first[0]?.level, "ERROR");
  assert.ok(!first[0]?.message.includes("raw-secret"));
  assert.ok(!first[0]?.message.includes("abcdef"));
  assert.equal(
    first[0]?.id,
    parseDockerLogs(text, "stderr", ["raw-secret"])[0]?.id,
  );
});

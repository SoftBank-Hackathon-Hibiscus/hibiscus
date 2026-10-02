import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

const requiredEnvironment = {
  BACKEND_TUNNEL_URL: "wss://backend.example.com/agent/v1/tunnel/control",
  AGENT_ID: "agent-1",
  AGENT_TOKEN: "a".repeat(32),
  COSIGN_PUBLIC_KEY: "./cosign.pub",
};

void test("parses explicit false security options as false", () => {
  const config = loadConfig({
    ...requiredEnvironment,
    COSIGN_ALLOW_INSECURE_REGISTRY: "false",
    COSIGN_INSECURE_IGNORE_TLOG: "false",
  });

  assert.equal(config.cosignAllowInsecureRegistry, false);
  assert.equal(config.cosignInsecureIgnoreTlog, false);
});

void test("enables security exceptions only with explicit true values", () => {
  const config = loadConfig({
    ...requiredEnvironment,
    COSIGN_ALLOW_INSECURE_REGISTRY: "true",
    COSIGN_INSECURE_IGNORE_TLOG: "true",
  });

  assert.equal(config.cosignAllowInsecureRegistry, true);
  assert.equal(config.cosignInsecureIgnoreTlog, true);
});

void test("rejects ambiguous boolean values", () => {
  assert.throws(() =>
    loadConfig({
      ...requiredEnvironment,
      COSIGN_ALLOW_INSECURE_REGISTRY: "1",
    }),
  );
});

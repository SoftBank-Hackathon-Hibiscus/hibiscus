import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CosignSigner, CosignVerifier, cosignEnv, ensureCosignVersion, isKmsKey } from "../src/cosign.js";
import { fakeCosign, REPO, tmp } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const KMS = "gcpkms://projects/hib/locations/asia-northeast3/keyRings/hibiscus/cryptoKeys/cosign";

describe("CosignSigner", () => {
  it("cosign sign --yes --key <키> -a 주석 <저장소>@<digest> 로 부르고 signature_ref 를 돌려줌", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin, argsFile } = fakeCosign(dir);

    const ref = await new CosignSigner(key, bin).sign(`${REPO}@${DIGEST}`, { run_id: "r-1", plan_hash: "b".repeat(64) });

    expect(ref).toBe(`cosign:${REPO}@${DIGEST}`);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "sign", "--yes", "--key", key, "-a", "run_id=r-1", "-a", `plan_hash=${"b".repeat(64)}`, "--", `${REPO}@${DIGEST}`,
    ]);
  });

  it("noTlog 면 --use-signing-config=false --tlog-upload=false 를 붙임", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin, argsFile } = fakeCosign(dir);

    await new CosignSigner(key, bin, { noTlog: true }).sign(`${REPO}@${DIGEST}`, { run_id: "r-1" });

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "sign", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false", "-a", "run_id=r-1", "--", `${REPO}@${DIGEST}`,
    ]);
  });

  it("cosign 이 실패하면 SIGN_FAILED (stderr 마지막 줄 포함)", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin } = fakeCosign(dir, { code: 1 });
    await expect(new CosignSigner(key, bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "SIGN_FAILED", message: /registry denied/ });
  });

  it("KMS 키 주소면 파일 확인 없이 --key 로 그대로 넘김 (비밀번호 불필요)", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await new CosignSigner(KMS, bin).sign(`${REPO}@${DIGEST}`, { run_id: "r-1" });
    expect(readFileSync(argsFile, "utf8").trim().split("\n").slice(0, 4)).toEqual(["sign", "--yes", "--key", KMS]);
  });

  it("attest: cosign attest --yes --key <키> [Rekor 끄기] --type <종류> --predicate <임시 파일> -- <이미지>", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin, argsFile } = fakeCosign(dir);
    await new CosignSigner(key, bin, { noTlog: true }).attest(`${REPO}@${DIGEST}`, "t", { run_id: "r-1" });
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args.slice(0, 8)).toEqual(["attest", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false", "--type", "t"]);
    expect(args[8]).toBe("--predicate");
    expect(args.slice(10)).toEqual(["--", `${REPO}@${DIGEST}`]);
    expect(existsSync(args[9]!)).toBe(false); // 임시 predicate 파일은 지움
  });

  it("attest: cosign 이 실패하면 ATTEST_FAILED", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin } = fakeCosign(dir, { code: 1 });
    await expect(new CosignSigner(key, bin).attest(`${REPO}@${DIGEST}`, "t", {})).rejects.toMatchObject({ code: "ATTEST_FAILED" });
  });

  it("키 파일이 없으면 cosign 을 부르지 않고 KEY_MISSING", async () => {
    const dir = tmp();
    const { bin } = fakeCosign(dir);
    await expect(new CosignSigner(join(dir, "nope.key"), bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "KEY_MISSING" });
  });

  it("signBlob: cosign sign-blob --yes --key <키> [Rekor 끄기] --bundle <임시 파일> -- <임시 파일> 로 부르고 bundle 을 돌려줌", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const argsFile = join(dir, "args.txt");
    const bin = join(dir, "cosign");
    // --bundle 뒤 경로에 bundle 을 쓰는 가짜 cosign
    writeFileSync(bin, `#!/bin/sh
if [ "$1" = "version" ]; then echo '{"gitVersion":"v3.1.3"}'; exit 0; fi
printf '%s\\n' "$@" > "${argsFile}"
for a; do last="$a"; done; cp "$last" "${join(dir, "blob.txt")}"
while [ $# -gt 0 ]; do [ "$1" = "--bundle" ] && echo '{"mediaType":"m"}' > "$2"; shift; done
exit 0
`);
    chmodSync(bin, 0o755);
    expect(await new CosignSigner(key, bin, { noTlog: true }).signBlob("내용")).toEqual({ mediaType: "m" });
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args.slice(0, 6)).toEqual(["sign-blob", "--yes", "--key", key, "--use-signing-config=false", "--tlog-upload=false"]);
    expect(args[6]).toBe("--bundle");
    expect(args[8]).toBe("--");
    expect(readFileSync(join(dir, "blob.txt"), "utf8")).toBe("내용");
    expect(existsSync(args[9]!)).toBe(false); // 임시 파일은 지움
  });

  it("signBlob: cosign 이 실패하면 SIGN_FAILED", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin } = fakeCosign(dir, { code: 1 });
    await expect(new CosignSigner(key, bin).signBlob("x")).rejects.toMatchObject({ code: "SIGN_FAILED" });
  });
});

describe("cosign 에 넘기는 환경변수 (minimalEnv)", () => {
  const ENV = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    COSIGN_PASSWORD: "pw",
    GOOGLE_APPLICATION_CREDENTIALS: "/sa.json",
    CLOUDSDK_CONFIG: "/gcloud",
    DOCKER_CONFIG: "/docker",
    HTTPS_PROXY: "http://proxy",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
    JWT_ACCESS_SECRET: "jwt",
    DATABASE_URL: "postgres://",
    SIGNER_COSIGN_KEY: "/k",
  };

  it("끄면 환경변수 전체를 그대로 넘김 (기존 동작)", () => {
    expect(cosignEnv({}, ENV)).toBe(ENV);
  });

  it("켜면 cosign·레지스트리 인증·KMS 에 쓰는 것만 남기고 backend 비밀값은 뺌", () => {
    expect(Object.keys(cosignEnv({ minimalEnv: true }, ENV)).sort()).toEqual(
      ["CLOUDSDK_CONFIG", "COSIGN_PASSWORD", "DOCKER_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS", "HOME", "HTTPS_PROXY", "PATH"].sort(),
    );
  });

  it("cosign version 확인에도 걸러진 환경변수만 감", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const log = join(dir, "env.log");
    const bin = join(dir, "cosign");
    writeFileSync(bin, `#!/bin/sh\necho "$1 DB_PASSWORD=\${DB_PASSWORD:-<unset>}" >> "${log}"\nif [ "$1" = "version" ]; then echo '{"gitVersion":"v3.1.3"}'; fi\nexit 0\n`);
    chmodSync(bin, 0o755);
    process.env.DB_PASSWORD = "hunter2";
    try {
      await new CosignSigner(key, bin, { minimalEnv: true }).sign(`${REPO}@${DIGEST}`, {});
    } finally {
      delete process.env.DB_PASSWORD;
    }
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["version DB_PASSWORD=<unset>", "sign DB_PASSWORD=<unset>"]);
  });

  it("실제 cosign 프로세스에도 걸러진 환경변수만 감", async () => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const envFile = join(dir, "env.txt");
    const bin = join(dir, "cosign");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "version" ]; then echo '{"gitVersion":"v3.1.3"}'; exit 0; fi\nenv > "${envFile}"\n`);
    chmodSync(bin, 0o755);
    process.env.HIBISCUS_TEST_SECRET = "should-not-leak";
    process.env.COSIGN_PASSWORD = "pw";
    try {
      await new CosignSigner(key, bin, { minimalEnv: true }).sign(`${REPO}@${DIGEST}`, {});
    } finally {
      delete process.env.HIBISCUS_TEST_SECRET;
      delete process.env.COSIGN_PASSWORD;
    }
    const env = readFileSync(envFile, "utf8");
    expect(env).toContain("COSIGN_PASSWORD=pw");
    expect(env).not.toContain("HIBISCUS_TEST_SECRET");
  });
});

describe("cosign 버전 확인", () => {
  it.each([["v2.4.1"], ["2.5.0"], ["devel"]])("cosign 버전이 %s 면 서명·확인 전에 멈춤", async (version) => {
    const dir = tmp();
    const key = join(dir, "cosign.key");
    writeFileSync(key, "dummy");
    const { bin, argsFile } = fakeCosign(dir, { version });
    await expect(new CosignSigner(key, bin).sign(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: version === "devel" ? "COSIGN_VERSION_UNKNOWN" : "COSIGN_VERSION" });
    expect(existsSync(argsFile)).toBe(false);
  });

  it("v3 이상이면 통과하고 실행 파일마다 한 번만 확인", async () => {
    expect(await ensureCosignVersion(fakeCosign(tmp(), { version: "v3.2.0" }).bin)).toBe("v3.2.0");
  });
});

describe("CosignVerifier", () => {
  function pubKey(dir: string): string {
    const pub = join(dir, "cosign.pub");
    writeFileSync(pub, "dummy");
    return pub;
  }

  it("cosign verify --key <공개키> -a 주석 <저장소>@<digest> 로 부름", async () => {
    const dir = tmp();
    const pub = pubKey(dir);
    const { bin, argsFile } = fakeCosign(dir);

    await new CosignVerifier(pub, bin).verify(`${REPO}@${DIGEST}`, { run_id: "r-1", targets: "onprem+cloud_run" });

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "verify", "--key", pub, "-a", "run_id=r-1", "-a", "targets=onprem+cloud_run", "--", `${REPO}@${DIGEST}`,
    ]);
  });

  it("noTlog 면 공개키 바로 뒤에 --insecure-ignore-tlog=true 를 붙임", async () => {
    const dir = tmp();
    const pub = pubKey(dir);
    const { bin, argsFile } = fakeCosign(dir);

    await new CosignVerifier(pub, bin, { noTlog: true }).verify(`${REPO}@${DIGEST}`, { run_id: "r-1" });

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "verify", "--key", pub, "--insecure-ignore-tlog=true", "-a", "run_id=r-1", "--", `${REPO}@${DIGEST}`,
    ]);
  });

  it("cosign 이 실패하면 SIGNATURE_INVALID (stderr 마지막 줄 포함)", async () => {
    const dir = tmp();
    const { bin } = fakeCosign(dir, { code: 1, stderr: "Error: no matching attestations: missing or incorrect annotation" });
    await expect(new CosignVerifier(pubKey(dir), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({
      code: "SIGNATURE_INVALID",
      message: /missing or incorrect annotation/,
    });
  });

  it.each([
    ["Error: no signatures found", "SIGNATURE_INVALID"],
    ["error during command execution: no signatures found", "SIGNATURE_INVALID"],
    ["Error: no matching attestations: missing or incorrect annotation", "SIGNATURE_INVALID"],
    ["Error: not enough verified log entries from transparency log: 0 < 1", "SIGNATURE_INVALID"],
    ["Error: loading verifier from key opts: loading public key: new gcp kms client: credentials: could not find default credentials", "KEY_UNAVAILABLE"],
    ['Error: Get "https://localhost:5999/v2/": dial tcp [::1]:5999: connect: connection refused', "REGISTRY_UNAVAILABLE"],
    ["Error: GET https://asia-northeast3-docker.pkg.dev/v2/x/manifests/sha256:abc: DENIED: Permission denied", "REGISTRY_UNAVAILABLE"],
  ])("cosign stderr '%s' → %s (서명 문제만 검증 실패, 키·레지스트리 문제는 실행 오류)", async (stderr, code) => {
    const dir = tmp();
    const { bin } = fakeCosign(dir, { code: 1, stderr });
    await expect(new CosignVerifier(pubKey(dir), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code });
  });

  it("이미지 자리에 옵션처럼 생긴 값이 와도 -- 뒤라서 옵션으로 안 읽힘", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await new CosignVerifier(pubKey(dir), bin).verify("--help", {});
    expect(readFileSync(argsFile, "utf8").trim().split("\n").slice(-2)).toEqual(["--", "--help"]);
  });

  it("signatures: 이 키로 확인되는 서명마다 주석(optional)을 돌려줌", async () => {
    const dir = tmp();
    const stdout = JSON.stringify([
      { critical: {}, optional: { run_id: "r-1", audit_head: "a".repeat(64) } },
      { critical: {}, optional: { run_id: "r-2", weird: 1 } },
      { critical: {} },
    ]);
    const { bin, argsFile } = fakeCosign(dir, { stdout });
    expect(await new CosignVerifier(pubKey(dir), bin).signatures(`${REPO}@${DIGEST}`)).toEqual([{ run_id: "r-1", audit_head: "a".repeat(64) }, { run_id: "r-2" }, {}]);
    expect(readFileSync(argsFile, "utf8")).not.toContain("-a\n");
  });

  it("signatures: 같은 키로 붙인 증명서(critical.type 이 predicate 종류)는 서명 목록에서 뺌 (cosign v3)", async () => {
    const dir = tmp();
    const stdout = JSON.stringify([
      { critical: { type: "https://hibiscus.lth.so/attestations/deploy-decision/v1" }, optional: {} },
      { critical: { type: "https://sigstore.dev/cosign/sign/v1" }, optional: { run_id: "r-1" } },
      { critical: { type: "cosign container image signature" }, optional: { run_id: "r-0" } },
    ]);
    const { bin } = fakeCosign(dir, { stdout });
    expect(await new CosignVerifier(pubKey(dir), bin).signatures(`${REPO}@${DIGEST}`)).toEqual([{ run_id: "r-1" }, { run_id: "r-0" }]);
  });

  it("signatures: 서명이 없으면 빈 배열, 레지스트리 오류는 그대로 실행 오류", async () => {
    const dir = tmp();
    const none = fakeCosign(dir, { code: 1, stderr: "Error: no signatures found" });
    expect(await new CosignVerifier(pubKey(dir), none.bin).signatures(`${REPO}@${DIGEST}`)).toEqual([]);
    // cosign v3.1.3 실제 문구
    const dirReal = tmp();
    const real = fakeCosign(dirReal, { code: 1, stderr: "error during command execution: no signatures found" });
    expect(await new CosignVerifier(pubKey(dirReal), real.bin).signatures(`${REPO}@${DIGEST}`)).toEqual([]);
    const dir2 = tmp();
    const denied = fakeCosign(dir2, { code: 1, stderr: "Error: GET https://x/v2/: DENIED: Permission denied" });
    await expect(new CosignVerifier(pubKey(dir2), denied.bin).signatures(`${REPO}@${DIGEST}`)).rejects.toMatchObject({ code: "REGISTRY_UNAVAILABLE" });
  });

  it("attestations: --type·--policy 를 넘기고 DSSE 봉투의 payload 를 in-toto Statement 로 풂", async () => {
    const dir = tmp();
    const statement = { _type: "https://in-toto.io/Statement/v0.1", subject: [], predicateType: "t", predicate: { run_id: "r-1" } };
    const envelope = { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64"), signatures: [] };
    const { bin, argsFile } = fakeCosign(dir, { stdout: JSON.stringify(envelope) });
    const pub = pubKey(dir);
    const policy = join(dir, "deploy.rego");
    writeFileSync(policy, "package signature\n");
    expect(await new CosignVerifier(pub, bin, { noTlog: true }).attestations(`${REPO}@${DIGEST}`, "t", policy)).toEqual([statement]);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "verify-attestation", "--key", pub, "--insecure-ignore-tlog=true", "--type", "t", "--policy", policy, "--", `${REPO}@${DIGEST}`,
    ]);
  });

  it("attestations: 정책 파일이 없으면 cosign 을 부르지 않고 POLICY_MISSING", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await expect(new CosignVerifier(pubKey(dir), bin).attestations(`${REPO}@${DIGEST}`, "t", join(dir, "strcit.rego"))).rejects.toMatchObject({ code: "POLICY_MISSING" });
    expect(existsSync(argsFile)).toBe(false);
  });

  // cosign v3.1.3 실제 stderr: 마지막 줄은 셋 다 같고 앞 줄이 다름
  it.each([
    ["문법 오류", "- 1 error occurred during loading: bad.rego:3: rego_parse_error: unexpected eof token", "POLICY_INVALID"],
    ["파일 못 읽음", "- 1 error occurred during loading: stat x.rego: no such file or directory", "POLICY_INVALID"],
    ["실제 거부", "- expression value, false, is not true", "POLICY_DENIED"],
  ])("attestations: 정책 오류 분류 (%s)", async (_name, line, code) => {
    const dir = tmp();
    const policy = join(dir, "p.rego");
    writeFileSync(policy, "package signature\n");
    const { bin } = fakeCosign(dir, { code: 1, stderr: `${line}\nerror during command execution: 1 validation errors occurred` });
    const err = await new CosignVerifier(pubKey(dir), bin).attestations(`${REPO}@${DIGEST}`, "t", policy).catch((e: unknown) => e);
    expect(err).toMatchObject({ code });
    if (code === "POLICY_DENIED") expect((err as Error).message).toContain("expression value, false, is not true");
  });

  it("signatures legacy: --new-bundle-format=false 로 예전 형식(.sig) 서명만 물어봄", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir, { stdout: "[]" });
    const pub = pubKey(dir);
    await new CosignVerifier(pub, bin).signatures(`${REPO}@${DIGEST}`, { legacy: true });
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["verify", "--new-bundle-format=false", "--key", pub, "--", `${REPO}@${DIGEST}`]);
  });

  it("signatures: 증명서처럼 type 을 바꿔도 주석이 있으면 서명으로 셈 (훔친 키로 감사 대조에서 숨기기)", async () => {
    const dir = tmp();
    const stdout = JSON.stringify([{ critical: { type: "x-not-a-signature" }, optional: { run_id: "r-999", audit_head: "0".repeat(64) } }]);
    const { bin } = fakeCosign(dir, { stdout });
    expect(await new CosignVerifier(pubKey(dir), bin).signatures(`${REPO}@${DIGEST}`)).toEqual([{ run_id: "r-999", audit_head: "0".repeat(64) }]);
  });

  it.each([
    ["Error: 1 validation errors occurred", "POLICY_DENIED"],
    ["error during command execution: no matching attestations: ", "SIGNATURE_INVALID"],
    ["error during command execution: none of the attestations matched the predicate type: t, found: x", "SIGNATURE_INVALID"],
  ])("attestations: cosign stderr '%s' → %s", async (stderr, code) => {
    const dir = tmp();
    const { bin } = fakeCosign(dir, { code: 1, stderr });
    await expect(new CosignVerifier(pubKey(dir), bin).attestations(`${REPO}@${DIGEST}`, "t")).rejects.toMatchObject({ code });
  });

  it("공개키 자리에 KMS 키 주소를 주면 파일 확인 없이 그대로 넘김", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await new CosignVerifier(KMS, bin).verify(`${REPO}@${DIGEST}`, {});
    expect(readFileSync(argsFile, "utf8").trim().split("\n").slice(0, 3)).toEqual(["verify", "--key", KMS]);
  });

  it.each([["gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k", true], ["awskms://alias/x", true], ["hashivault://cosign", true], ["/tmp/cosign.key", false], ["gcpkms://", false], ["file://cosign.key", false]])(
    "isKmsKey(%s) = %s",
    (key, kms) => {
      expect(isKmsKey(key)).toBe(kms);
    },
  );

  it("공개키 파일이 없으면 cosign 을 부르지 않고 KEY_MISSING", async () => {
    const dir = tmp();
    const { bin, argsFile } = fakeCosign(dir);
    await expect(new CosignVerifier(join(dir, "nope.pub"), bin).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "KEY_MISSING" });
    expect(() => readFileSync(argsFile)).toThrow();
  });

  it("cosign 실행 파일이 없으면 COSIGN_MISSING", async () => {
    const dir = tmp();
    await expect(new CosignVerifier(pubKey(dir), join(dir, "no-cosign")).verify(`${REPO}@${DIGEST}`, {})).rejects.toMatchObject({ code: "COSIGN_MISSING" });
  });
});

describe("CosignVerifier.verifyBlob", () => {
  function setup(o: Parameters<typeof fakeCosign>[1] = {}) {
    const dir = tmp();
    const pub = join(dir, "cosign.pub");
    writeFileSync(pub, "dummy");
    return { pub, ...fakeCosign(dir, o) };
  }

  it("cosign verify-blob --key <공개키> [--insecure-ignore-tlog=true] --bundle <임시 파일> -- <임시 파일>", async () => {
    const { pub, bin, argsFile } = setup();
    await new CosignVerifier(pub, bin, { noTlog: true }).verifyBlob("x", { mediaType: "m" });
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args.slice(0, 5)).toEqual(["verify-blob", "--key", pub, "--insecure-ignore-tlog=true", "--bundle"]);
    expect(args[6]).toBe("--");
  });

  // 실제 cosign v3.1.3 이 낸 문구: 내용을 바꿨을 때 / bundle 서명 바이트가 망가졌을 때
  it.each(["Error: failed to verify signature: invalid signature when validating ASN.1 encoded signature", "error during command execution: ecdsa: Invalid IEEE_P1363 encoded bytes"])(
    "서명이 안 맞으면 SIGNATURE_INVALID (%s)",
    async (stderr) => {
      const { pub, bin } = setup({ code: 1, stderr });
      await expect(new CosignVerifier(pub, bin).verifyBlob("x", {})).rejects.toMatchObject({ code: "SIGNATURE_INVALID" });
    },
  );

  it("공개키를 못 읽으면 숨기지 않고 KEY_UNAVAILABLE", async () => {
    const { pub, bin } = setup({ code: 1, stderr: "Error: loading public key: bad pem" });
    await expect(new CosignVerifier(pub, bin).verifyBlob("x", {})).rejects.toMatchObject({ code: "KEY_UNAVAILABLE" });
  });
});

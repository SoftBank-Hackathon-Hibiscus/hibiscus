// 레지스트리 훑기. audit --images 는 감사 로그에 나온 digest 만 보는데, 키를 훔쳐 로그에 한 번도 안 나온 새 이미지에 서명하면 안 보임.
// 저장소의 태그를 전부 훑어서 확인할 이미지에 더함 (cosign v3 는 서명 대상마다 sha256-<digest> 태그를 남김)
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { cosignEnv, type CosignOptions } from "./cosign.js";
import { SignerError } from "./io.js";

const execFileAsync = promisify(execFile);

export interface RegistryLister {
  /** 저장소의 태그 전부. 저장소가 없으면 빈 목록 */
  tags(repo: string): Promise<string[]>;
  /** <저장소>:<태그> 의 digest (sha256:<hex>) */
  digest(ref: string): Promise<string>;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
// cosign 서명·증명서가 붙는 태그. 예전 형식은 .sig .att .sbom 이 붙음
const SIGNATURE_TAG_RE = /^sha256-([0-9a-f]{64})(?:\.(?:sig|att|sbom))?$/;

/** crane 으로 태그·digest 조회. 레지스트리 인증은 cosign 과 같은 환경변수(DOCKER_CONFIG, gcloud 등) */
export class CraneLister implements RegistryLister {
  constructor(
    private readonly craneBin = "crane",
    private readonly options: CosignOptions = {},
  ) {}

  async tags(repo: string): Promise<string[]> {
    try {
      return (await this.run(["ls", "--", repo])).split("\n").map((t) => t.trim()).filter(Boolean);
    } catch (e) {
      if (e instanceof SignerError && /NAME_UNKNOWN/.test(e.message)) return [];
      throw e;
    }
  }

  async digest(ref: string): Promise<string> {
    const out = (await this.run(["digest", "--", ref])).trim();
    if (!DIGEST_RE.test(out)) throw new SignerError("REGISTRY_UNAVAILABLE", `crane digest 출력이 digest 가 아님: ${ref}`);
    return out;
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.craneBin, args, { env: cosignEnv(this.options), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { code?: unknown; stderr?: unknown };
      if (err.code === "ENOENT") throw new SignerError("CRANE_MISSING", `crane 실행 파일이 없음 (레지스트리 훑기에 필요): ${this.craneBin}`);
      const stderr = String(err.stderr ?? "").trim().split("\n").pop() ?? "";
      throw new SignerError("REGISTRY_UNAVAILABLE", `레지스트리 조회 실패 (crane ${args[0]}): ${stderr}`);
    }
  }
}

/**
 * 저장소에서 서명이 붙었을 수 있는 이미지 digest 전부.
 * sha256-<hex> 태그는 서명 대상 digest 로 바로 읽고, 나머지 태그는 crane digest 로 풂.
 * 태그가 max 보다 많으면 일부만 보고 통과시키지 않게 멈춤 (SWEEP_TRUNCATED)
 */
export async function sweepDigests(lister: RegistryLister, repo: string, max = 1000): Promise<{ digests: string[]; tags: number; signatureTags: number }> {
  const tags = await lister.tags(repo);
  if (tags.length > max) throw new SignerError("SWEEP_TRUNCATED", `${repo} 의 태그가 ${tags.length}개라 한도(${max})를 넘음. --sweep-max 를 올리거나 --digests-file 로 나눠서 확인`);
  const digests = new Set<string>();
  const plain: string[] = [];
  let signatureTags = 0;
  for (const tag of tags) {
    const m = SIGNATURE_TAG_RE.exec(tag);
    if (m) {
      digests.add(`sha256:${m[1]}`);
      signatureTags++;
    } else {
      plain.push(tag);
    }
  }
  // 일반 태그는 4개씩 동시에
  for (let i = 0; i < plain.length; i += 4) {
    for (const d of await Promise.all(plain.slice(i, i + 4).map((t) => lister.digest(`${repo}:${t}`)))) digests.add(d);
  }
  return { digests: [...digests].sort(), tags: tags.length, signatureTags };
}

/**
 * 태그 없는 이미지용 오프라인 입력. 한 줄에 sha256:<hex> 또는 <저장소>@sha256:<hex>. # 주석·빈 줄은 무시
 * 예: gcloud artifacts docker images list <저장소> --format='value(version)'
 */
export function readDigestsFile(path: string): Array<{ repo?: string; digest: string }> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SignerError("DIGESTS_FILE_INVALID", `digest 목록 파일을 읽지 못함: ${path}`);
  }
  const out: Array<{ repo?: string; digest: string }> = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const at = line.lastIndexOf("@");
    const digest = at < 0 ? line : line.slice(at + 1);
    if (!DIGEST_RE.test(digest) || at === 0) throw new SignerError("DIGESTS_FILE_INVALID", `${path} ${i + 1}번째 줄 형식 오류 (sha256:<hex> 또는 <저장소>@sha256:<hex>): ${raw}`);
    out.push(at < 0 ? { digest } : { repo: line.slice(0, at), digest });
  }
  return out;
}

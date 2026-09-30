/**
 * --classifier 옵션에 따라 판정기를 고른다. pii CLI 와 보안 단계 실행기가 같이 쓴다.
 *
 *   heuristic (기본) : 규칙 판정기
 *   llm              : ANTHROPIC_API_KEY 가 있으면 LLM 판정기, 없으면 heuristic 으로 내려가고 notes 에 알린다
 *   replay           : recordings/<run_id>.json (또는 recording 경로) 를 재생
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../io.js";
import { type Classifier, HeuristicClassifier, LlmClassifier, ReplayClassifier, createAnthropicCall, loadRecording, resolveLlmModel } from "./classifier.js";

export const CLASSIFIER_MODES = ["heuristic", "llm", "replay"] as const;
export type ClassifierMode = (typeof CLASSIFIER_MODES)[number];

export interface SelectClassifierOptions {
  /** 기본 heuristic */
  mode?: string;
  runId: string;
  /** replay 용 녹화 파일. 기본 recordings/<run_id>.json */
  recording?: string;
  /** llm 응답을 recordings/<run_id>.json 에 저장 */
  record?: boolean;
}

export function selectClassifier(opts: SelectClassifierOptions): { classifier: Classifier; notes: string[] } {
  const mode = opts.mode ?? "heuristic";
  const heuristic = new HeuristicClassifier();
  const notes: string[] = [];

  if (mode === "heuristic") return { classifier: heuristic, notes };

  if (mode === "llm") {
    if (!process.env.ANTHROPIC_API_KEY) {
      notes.push("ANTHROPIC_API_KEY 가 없어 heuristic 으로 판정합니다 (llm 요청됨)");
      return { classifier: heuristic, notes };
    }
    const model = resolveLlmModel();
    notes.push(`LLM 모델: ${model} (환경변수 PII_LLM_MODEL 로 변경 가능)`);
    const recordPath = join("recordings", `${opts.runId}.json`);
    const classifier = new LlmClassifier({
      base: heuristic,
      call: createAnthropicCall({ model }),
      onExchange: opts.record
        ? (request, response) => {
            mkdirSync(dirname(recordPath), { recursive: true });
            const recording = { recorded_at: new Date().toISOString(), model, request, response };
            writeFileSync(recordPath, JSON.stringify(recording, null, 2) + "\n", "utf8");
            notes.push(`LLM 응답을 저장했습니다: ${recordPath}`);
          }
        : undefined,
    });
    return { classifier, notes };
  }

  if (mode === "replay") {
    const path = opts.recording ?? join("recordings", `${opts.runId}.json`);
    let recording;
    try {
      recording = loadRecording(path);
    } catch (e) {
      throw new CliError(`녹화 파일을 읽을 수 없습니다: ${path} (${(e as Error).message})`);
    }
    notes.push(`녹화 재생: ${path}`);
    return { classifier: new ReplayClassifier(heuristic, recording), notes };
  }

  throw new CliError(`--classifier 는 ${CLASSIFIER_MODES.join(" | ")} 중 하나여야 합니다: ${mode}`);
}

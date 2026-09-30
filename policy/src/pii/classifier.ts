/**
 * 판정기 인터페이스.
 *
 *   추출기(extractor) → ColumnCandidate[] → Classifier.classify() → Classification[] (= pii.json 의 pii[])
 *
 * 구현 3개:
 *   - HeuristicClassifier (heuristic.ts) : 이름 사전 + 쓰임새 신호. 결정적. 기본값.
 *   - LlmClassifier       (llm.ts)       : 휴리스틱이 애매하다고 한 칼럼만 LLM 에 묻는다. 호출 함수 주입 가능.
 *   - ReplayClassifier    (replay.ts)    : 저장된 LLM 응답을 재생. 데모·테스트를 결정적으로 만든다.
 */
import type { PiiCandidate, PiiSource } from "../schema.js";
import type { ColumnCandidate } from "./extractor.js";

export type Classification = PiiCandidate & { source: PiiSource };

export interface Classifier {
  readonly name: string;
  classify(candidates: ColumnCandidate[]): Promise<Classification[]>;
}

export { HeuristicClassifier } from "./heuristic.js";
export { DEFAULT_LLM_MODEL, LLM_MODEL_ENV, LlmClassifier, LlmResponseSchema, createAnthropicCall, loadPromptTemplate, resolveLlmModel } from "./llm.js";
export type { LlmCall, LlmRequest, LlmResponse } from "./llm.js";
export { ReplayClassifier, RecordingSchema, loadRecording } from "./replay.js";
export type { Recording } from "./replay.js";
